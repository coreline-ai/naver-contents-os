"""Version-pinned, idempotent draft-save orchestration for CDP and extension transports."""

from __future__ import annotations

import hashlib
import json
import re
import socket
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Callable, ContextManager
from urllib.parse import urlsplit, unquote

from sqlalchemy.orm import Session, sessionmaker

from app.errors import DraftVersionConflict
from app.services.draft_assets import DraftAssetService, asset_snapshot, asset_manifest_hash
from app.services.drafts import DraftService, SqlJobStore
from publisher.browser import attached_page
from publisher.editor import SmartEditorAdapter
from publisher.jobs import PublishJobRunner
from publisher.page import PageLike

TRANSPORTS = frozenset({"dedicated_chrome_cdp", "current_chrome_extension"})
EXTENSION_STAGES = (
    "browser_attach",
    "health_check",
    "prepare_editor",
    "input_title",
    "input_body",
    "upload_images",
    "input_tags",
    "draft_save",
    "reopen_verify",
)
TERMINAL_STATUSES = frozenset({"failed", "draft_saved", "verified_draft_saved"})


class PublishPreconditionError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _content_hash(value: str) -> str:
    normalized = re.sub(r"[\s\u200b-\u200d\ufeff]+", "", value or "")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _normalized_tags(values: list[str]) -> list[str]:
    return sorted({re.sub(r"\s+", "", value.lstrip("#")).casefold() for value in values if isinstance(value, str) and value.strip()})


def _remote_image_url(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("remote image URL is required")
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("remote images must use HTTPS")
    if not host.endswith(".pstatic.net") or not parsed.path or parsed.path == "/":
        raise ValueError("remote image is not a NAVER image URL")
    # These hosts serve the same uploaded object at different display sizes.
    if host in {"postfiles.pstatic.net", "blogfiles.pstatic.net", "blogthumb.pstatic.net"}:
        host = "blogfiles.pstatic.net"
    return f"https://{host}{unquote(parsed.path)}"


def _receipt_keys(receipts: object, snapshot: list[dict]) -> list[tuple[int, str, str]]:
    if not isinstance(receipts, list) or len(receipts) != len(snapshot):
        raise ValueError("one remote receipt per pinned image is required")
    result = []
    for receipt, expected in zip(receipts, snapshot):
        if (not isinstance(receipt, dict) or not isinstance(receipt.get("asset_id"), int)
                or isinstance(receipt.get("asset_id"), bool) or receipt.get("asset_id") != expected["asset_id"]
                or receipt.get("sha256") != expected["sha256"]):
            raise ValueError("image receipt identity or order does not match the snapshot")
        result.append((receipt["asset_id"], receipt["sha256"], _remote_image_url(receipt.get("remote_url"))))
    if len({item[2] for item in result}) != len(result):
        raise ValueError("distinct pinned images must have distinct remote receipts")
    return result


@dataclass(frozen=True)
class PreparedPublish:
    job_id: int
    draft_id: int
    blog_id: str
    cdp_url: str
    title: str
    body: str
    tags: list[str]
    transport: str = "dedicated_chrome_cdp"
    draft_version: int = 1
    asset_manifest_version: int = 0
    idempotency_key: str = ""
    reused: bool = False


class PublishService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        page_factory: Callable[[str], ContextManager[PageLike]] = attached_page,
        adapter_factory: Callable[[PageLike], SmartEditorAdapter] = SmartEditorAdapter,
        runner_factory: Callable[[SqlJobStore], PublishJobRunner] = PublishJobRunner,
        asset_service: DraftAssetService | None = None,
    ):
        self._sessions = session_factory
        self._store = SqlJobStore(session_factory)
        self._assets = asset_service or DraftAssetService(session_factory)
        self._page_factory = page_factory
        self._adapter_factory = adapter_factory
        self._runner_factory = runner_factory
        self._heartbeat_lock = Lock()
        self._extension_heartbeat: dict = {}

    def prepare(
        self,
        draft_id: int,
        *,
        blog_id: str,
        tags: list[str],
        cdp_url: str,
        expected_version: int | None = None,
        transport: str = "dedicated_chrome_cdp",
    ) -> PreparedPublish | None:
        if transport not in TRANSPORTS:
            raise ValueError("unsupported publisher transport")
        draft = DraftService(self._sessions, None).get_draft(draft_id)
        if draft is None or not draft["versions"]:
            return None
        latest = draft["versions"][-1]
        if expected_version is not None and latest["version"] != expected_version:
            raise DraftVersionConflict("원고의 최신 버전이 변경되었습니다. 최신 원고를 확인한 뒤 네이버 임시저장을 다시 요청하세요.")
        normalized_tags = [tag.strip() for tag in tags if tag.strip()][:10]
        assets = self._assets.list(draft_id, latest["version"])
        if transport == "current_chrome_extension":
            if len(latest["body"]) < 3000:
                raise PublishPreconditionError("body_too_short", "현재 Chrome 임시저장 본문은 3,000자 이상이어야 합니다.")
            if len(assets) < 3:
                raise PublishPreconditionError("image_assets_not_ready", "승인된 현재 원고 이미지가 3장 이상 필요합니다.")
        snapshot = asset_snapshot(assets)
        manifest_hash = asset_manifest_hash(snapshot)
        manifest_version = int(manifest_hash[:7], 16)
        if transport == "current_chrome_extension":
            self._assert_assets({"draft_id": draft_id, "draft_version": latest["version"],
                                 "request_payload": {"asset_snapshot": snapshot, "asset_manifest_hash": manifest_hash}})
        signature_payload = {
            "contract_version": 2,
            "asset_manifest_hash": manifest_hash,
            "draft_id": draft_id,
            "draft_version": latest["version"],
            "blog_id": blog_id,
            "tags": normalized_tags,
            "transport": transport,
            "assets": [(row["asset_id"], row["sha256"], row["position"], row["anchor_after"]) for row in assets],
        }
        idempotency_key = hashlib.sha256(
            json.dumps(signature_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        existing = self._store.by_idempotency_key(idempotency_key)
        reused = existing is not None
        if existing is not None:
            job_id = existing["job_id"]
            if existing["status"] == "failed":
                if transport == "current_chrome_extension":
                    self._assert_assets(existing)
                self._store.restart(job_id, only_if_failed=True)
        else:
            job_id = self._store.create(
                draft_id,
                transport=transport,
                draft_version=latest["version"],
                asset_manifest_version=manifest_version,
                idempotency_key=idempotency_key,
                request_payload={"blog_id": blog_id, "tags": normalized_tags,
                                 "asset_snapshot": snapshot, "asset_manifest_hash": manifest_hash,
                                 "resume_stage": "browser_attach"},
            )
        return PreparedPublish(
            job_id=job_id,
            draft_id=draft_id,
            blog_id=blog_id,
            cdp_url=cdp_url,
            title=latest["title"],
            body=latest["body"],
            tags=normalized_tags,
            transport=transport,
            draft_version=latest["version"],
            asset_manifest_version=manifest_version,
            idempotency_key=idempotency_key,
            reused=reused,
        )

    def mark_waiting_extension(self, task: PreparedPublish) -> None:
        current = self._store.get(task.job_id)
        if current is None or current["status"] in {"verified_draft_saved", "draft_saved"}:
            return
        self._store.mark_waiting(task.job_id)

    def run(self, task: PreparedPublish) -> None:
        if task.transport == "current_chrome_extension":
            self.mark_waiting_extension(task)
            return
        attached = False
        try:
            with self._page_factory(task.cdp_url) as page:
                attached = True
                adapter = self._adapter_factory(page)
                self._runner_factory(self._store).run(
                    page,
                    adapter,
                    draft_id=task.draft_id,
                    blog_id=task.blog_id,
                    title=task.title,
                    body=task.body,
                    tags=task.tags,
                    job_id=task.job_id,
                )
        except Exception as exc:  # noqa: BLE001 - close every unexpected browser failure
            current = self._store.get(task.job_id)
            if current is not None and current["status"] in TERMINAL_STATUSES:
                return
            stage = "publisher_runtime" if attached else "browser_attach"
            error_code = "publisher_error" if attached else "browser_unavailable"
            self._record(task.job_id, "failed", stage, error_code, f"{stage} failed ({type(exc).__name__})")

    def _assert_assets(self, job: dict, *, verify_files: bool = True) -> list[dict]:
        payload = job["request_payload"]
        snapshot = payload.get("asset_snapshot")
        if not isinstance(snapshot, list) or not payload.get("asset_manifest_hash"):
            raise DraftVersionConflict(
                "구형 작업에는 승인 이미지 목록이 고정되어 있지 않아 자동 재시도를 중단했습니다. "
                "기존 네이버 임시글을 먼저 확인·보존한 뒤 원고를 새 버전으로 저장하고 다시 요청하세요."
            )
        assets = self._assets.list(job["draft_id"], job["draft_version"])
        if (asset_snapshot(assets) != snapshot
                or asset_manifest_hash(snapshot) != payload.get("asset_manifest_hash")):
            raise DraftVersionConflict("이미지 구성이 변경되었습니다. 새 임시저장 작업을 시작하세요.")
        if any(asset["rights_status"] != "approved" for asset in assets):
            raise ValueError("pinned images require rights approval")
        if verify_files:
            for asset in assets:
                self._assets.verify_file(asset["asset_id"])
        return assets

    def command(self, job_id: int, *, lease_owner: str | None = None) -> dict | None:
        job = self._store.get(job_id)
        if job is None:
            return None
        if job["transport"] != "current_chrome_extension":
            raise ValueError("job does not use current Chrome extension transport")
        if not lease_owner:
            raise ValueError("extension lease owner is required")
        if job["status"] in TERMINAL_STATUSES:
            raise ValueError("terminal publish jobs cannot be claimed")
        assets = self._assert_assets(job)
        draft = DraftService(self._sessions, None).get_draft(job["draft_id"])
        version = next((row for row in (draft or {}).get("versions", []) if row["version"] == job["draft_version"]), None)
        if version is None:
            raise ValueError("pinned draft version no longer exists")
        if not self._store.claim_lease(job_id, lease_owner):
            raise ValueError("publish job is already leased or not eligible")
        job = self._store.get(job_id)
        # Asset mutations share the SQLite writer lock with job creation/claim.
        # Recheck the snapshot and bytes before exposing paths to the worker.
        assets = self._assert_assets(job)
        payload = job["request_payload"]
        return {
            "job_id": job_id, "draft_id": job["draft_id"], "draft_version": job["draft_version"],
            "attempt_id": payload["attempt_id"], "lease_owner": job["lease_owner"],
            "resume_stage": payload["resume_stage"], "asset_manifest_hash": payload["asset_manifest_hash"],
            "image_receipts": list(job["verification"].get("image_receipts", [])),
            "blog_id": payload.get("blog_id", ""), "title": version["title"], "body": version["body"],
            "title_hash": _content_hash(version["title"]), "body_hash": _content_hash(version["body"]),
            "body_chars": len(version["body"]), "tags": list(payload.get("tags", [])),
            "assets": [{**row, "download_url": f"/v1/publish-jobs/{job_id}/assets/{row['asset_id']}",
                        "native_path": str(self._assets.get_row(row["asset_id"]).local_path)} for row in assets],
        }

    def asset_for_job(self, job_id: int, asset_id: int):
        job = self._store.get(job_id)
        row = self._assets.get_row(asset_id)
        if job is None or row is None:
            return None
        if row.draft_id != job["draft_id"] or row.draft_version != job["draft_version"]:
            return None
        self._assert_assets(job)
        if not any(item["asset_id"] == asset_id for item in job["request_payload"]["asset_snapshot"]):
            return None
        return row

    def next_extension_command(self, lease_owner: str, *, blog_ids: list[str] | None = None) -> dict | None:
        # A browser profile may share the same extension id with another
        # profile. Only hand a job to a worker that reports an exact editor
        # blog id; legacy callers that report none must not steal the job.
        job_id = self._store.next_available("current_chrome_extension", blog_ids)
        if job_id is None:
            return None
        return self.command(job_id, lease_owner=lease_owner)

    def record_extension_event(
        self, job_id: int, *, stage: str, status: str,
        attempt_id: str, lease_owner: str,
        error_code: str | None = None, detail: str = "", verification: dict | None = None,
    ) -> dict | None:
        if stage not in EXTENSION_STAGES:
            raise ValueError("unsupported publisher stage")
        if status not in {"running", "passed", "failed"}:
            raise ValueError("unsupported publisher event status")

        def validate(current: dict) -> tuple[str, str | None, str]:
            if status == "failed":
                return "failed", error_code or stage, detail or "extension publisher failed"
            if stage not in {"upload_images", "reopen_verify"} or status != "passed":
                return "running", None, detail
            values = verification or {}
            snapshot = current["request_payload"].get("asset_snapshot", [])
            try:
                self._assert_assets(current)
                receipts = _receipt_keys(values.get("image_receipts"), snapshot)
                if stage == "upload_images":
                    return "running", None, detail
                checkpoint = _receipt_keys(current["verification"].get("image_receipts"), snapshot)
            except (ValueError, DraftVersionConflict) as exc:
                return "failed", "verification_failed", str(exc)
            draft = DraftService(self._sessions, None).get_draft(current["draft_id"])
            version = next((row for row in (draft or {}).get("versions", []) if row["version"] == current["draft_version"]), None)
            actual_tags = values.get("actual_tags")
            def count_matches(key: str, expected: int) -> bool:
                return isinstance(values.get(key), int) and not isinstance(values.get(key), bool) and values[key] == expected
            required = {
                "title_hash": bool(version) and values.get("actual_title_hash") == _content_hash(version["title"]),
                "body_hash": bool(version) and values.get("actual_body_hash") == _content_hash(version["body"]),
                "body_chars": isinstance(values.get("body_chars"), int) and values["body_chars"] >= 3000,
                "image_count": count_matches("image_count", len(snapshot)),
                "remote_images": count_matches("remote_image_count", len(snapshot)),
                "manifest_hash": values.get("asset_manifest_hash") == current["request_payload"]["asset_manifest_hash"],
                "image_receipts": receipts == checkpoint,
                "tags": isinstance(actual_tags, list) and all(isinstance(tag, str) for tag in actual_tags)
                        and _normalized_tags(actual_tags) == _normalized_tags(current["request_payload"].get("tags", [])),
            }
            if not all(required.values()):
                failed = ", ".join(name for name, ok in required.items() if not ok)
                return "failed", "verification_failed", f"reopen verification failed: {failed}"
            return "verified_draft_saved", None, "saved draft reopened and verified"

        return self._store.extension_event(
            job_id, attempt_id=attempt_id, lease_owner=lease_owner, stage=stage, status=status,
            error_code=error_code, detail=detail, verification=verification,
            stages=EXTENSION_STAGES, validate=validate,
        )

    def retry(self, job_id: int) -> dict | None:
        self._store.expire_leases(job_id)
        current = self._store.get(job_id)
        if current is None:
            return None
        if current["status"] in {"draft_saved", "verified_draft_saved"}:
            return current
        if current["transport"] == "current_chrome_extension":
            self._assert_assets(current)
        self._store.restart(job_id)
        return self._store.get(job_id)

    def heartbeat(self, *, extension_id: str, version: str, active_url: str = "") -> dict:
        with self._heartbeat_lock:
            self._extension_heartbeat = {
                "extension_id": extension_id[:100],
                "version": version[:40],
                "active_url": active_url[:1000],
                "seen_at": datetime.now(timezone.utc),
            }
        return self.readiness("")

    def readiness(self, cdp_url: str) -> dict:
        with self._heartbeat_lock:
            heartbeat = dict(self._extension_heartbeat)
        seen_at = heartbeat.pop("seen_at", None)
        extension_ready = bool(seen_at and datetime.now(timezone.utc) - seen_at <= timedelta(seconds=20))
        return {
            "current_chrome_extension": {
                "ready": extension_ready,
                "last_seen": seen_at.isoformat() if seen_at else None,
                **heartbeat,
            },
            "dedicated_chrome_cdp": {
                "ready": self._cdp_ready(cdp_url) if cdp_url else False,
                "url": cdp_url,
            },
        }

    def get_job(self, job_id: int) -> dict | None:
        self._store.expire_leases(job_id)
        return self._store.get(job_id)

    def latest_job(self, draft_id: int) -> dict | None:
        self._store.expire_leases()
        return self._store.latest(draft_id)

    def _record(
        self,
        job_id: int,
        status: str,
        stage: str,
        error_code: str | None = None,
        detail: str = "",
        verification: dict | None = None,
    ) -> None:
        if verification is not None:
            self._store.update_verification(job_id, verification)
        self._store.update(
            job_id,
            status=status,
            stage=stage,
            error_code=error_code,
            detail=detail,
            history_entry={
                "stage": stage,
                "status": status,
                "at": _now(),
                "error_code": error_code,
                "detail": detail,
                **({"verification": verification} if verification is not None else {}),
            },
        )

    @staticmethod
    def _cdp_ready(cdp_url: str) -> bool:
        try:
            parsed = urlsplit(cdp_url)
            with socket.create_connection((parsed.hostname or "127.0.0.1", parsed.port or 80), timeout=0.15):
                return True
        except OSError:
            return False
