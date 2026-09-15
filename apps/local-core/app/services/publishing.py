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
from urllib.parse import urlsplit

from sqlalchemy.orm import Session, sessionmaker

from app.errors import DraftVersionConflict
from app.services.draft_assets import DraftAssetService
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
    ):
        self._sessions = session_factory
        self._store = SqlJobStore(session_factory)
        self._assets = DraftAssetService(session_factory)
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
        manifest_version = self._assets.manifest_version(draft_id, latest["version"])
        signature_payload = {
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
                self._store.restart(job_id)
        else:
            job_id = self._store.create(
                draft_id,
                transport=transport,
                draft_version=latest["version"],
                asset_manifest_version=manifest_version,
                idempotency_key=idempotency_key,
                request_payload={"blog_id": blog_id, "tags": normalized_tags},
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
        self._record(task.job_id, "waiting_extension", "browser_attach", detail="waiting for current Chrome extension")

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

    def command(self, job_id: int, *, lease_owner: str | None = None) -> dict | None:
        job = self._store.get(job_id)
        if job is None:
            return None
        if job["transport"] != "current_chrome_extension":
            raise ValueError("job does not use current Chrome extension transport")
        if lease_owner and not self._store.claim_lease(job_id, lease_owner):
            raise ValueError("publish job is already leased by another extension")
        draft = DraftService(self._sessions, None).get_draft(job["draft_id"])
        if draft is None:
            return None
        version = next((row for row in draft["versions"] if row["version"] == job["draft_version"]), None)
        if version is None:
            raise ValueError("pinned draft version no longer exists")
        assets = self._assets.list(job["draft_id"], job["draft_version"])
        if self._assets.manifest_version(job["draft_id"], job["draft_version"]) != job["asset_manifest_version"]:
            raise DraftVersionConflict("이미지 구성이 변경되었습니다. 새 임시저장 작업을 시작하세요.")
        self._record(job_id, "running", "browser_attach", detail="extension claimed publish job")
        payload = job["request_payload"]
        return {
            "job_id": job_id,
            "draft_id": job["draft_id"],
            "draft_version": job["draft_version"],
            "blog_id": payload.get("blog_id", ""),
            "title": version["title"],
            "body": version["body"],
            "title_hash": _content_hash(version["title"]),
            "body_hash": _content_hash(version["body"]),
            "body_chars": len(version["body"]),
            "tags": list(payload.get("tags", [])),
            "assets": [
                {
                    **row,
                    "download_url": f"/v1/publish-jobs/{job_id}/assets/{row['asset_id']}",
                    # Only the token-authenticated extension command receives
                    # this path. Chrome's debugger API requires a native file
                    # path for a trusted file chooser operation.
                    "native_path": str(self._assets.get_row(row["asset_id"]).local_path),
                }
                for row in assets
            ],
        }

    def asset_for_job(self, job_id: int, asset_id: int):
        job = self._store.get(job_id)
        row = self._assets.get_row(asset_id)
        if job is None or row is None:
            return None
        if row.draft_id != job["draft_id"] or row.draft_version != job["draft_version"]:
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
        self,
        job_id: int,
        *,
        stage: str,
        status: str,
        error_code: str | None = None,
        detail: str = "",
        verification: dict | None = None,
    ) -> dict | None:
        if stage not in EXTENSION_STAGES:
            raise ValueError("unsupported publisher stage")
        if status not in {"running", "passed", "failed"}:
            raise ValueError("unsupported publisher event status")
        current = self._store.get(job_id)
        if current is None:
            return None
        if current["transport"] != "current_chrome_extension":
            raise ValueError("job does not use current Chrome extension transport")
        if current["status"] == "verified_draft_saved":
            return current
        if status == "failed":
            self._record(job_id, "failed", stage, error_code or stage, detail or "extension publisher failed", verification)
            return self._store.get(job_id)
        if stage == "reopen_verify" and status == "passed":
            values = verification or {}
            draft = DraftService(self._sessions, None).get_draft(current["draft_id"])
            version = next(
                (row for row in (draft or {}).get("versions", []) if row["version"] == current["draft_version"]),
                None,
            )
            expected_title_hash = _content_hash(version["title"]) if version else ""
            expected_body_hash = _content_hash(version["body"]) if version else ""
            expected_images = len(self._assets.list(current["draft_id"], current["draft_version"]))
            required = {
                "title_hash": bool(expected_title_hash) and values.get("actual_title_hash") == expected_title_hash,
                "body_hash": bool(expected_body_hash) and values.get("actual_body_hash") == expected_body_hash,
                "body_chars": int(values.get("body_chars") or 0) >= 3000,
                "image_count": int(values.get("image_count") or 0) >= max(3, expected_images),
                "remote_images": int(values.get("remote_image_count") or 0) >= max(3, expected_images),
            }
            if not all(required.values()):
                failed = ", ".join(name for name, ok in required.items() if not ok)
                self._record(job_id, "failed", stage, "verification_failed", f"reopen verification failed: {failed}", values)
            else:
                self._record(job_id, "verified_draft_saved", stage, detail="saved draft reopened and verified", verification=values)
            return self._store.get(job_id)
        if verification is not None:
            self._store.update_verification(job_id, verification)
        self._store.update(
            job_id,
            status="running",
            stage=stage,
            error_code=None,
            detail=detail,
            history_entry={
                "stage": stage,
                "status": status,
                "at": _now(),
                "error_code": None,
                "detail": detail,
                **({"verification": verification} if verification is not None else {}),
            },
        )
        return self._store.get(job_id)

    def retry(self, job_id: int) -> dict | None:
        current = self._store.get(job_id)
        if current is None:
            return None
        if current["status"] == "verified_draft_saved":
            return current
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
        return self._store.get(job_id)

    def latest_job(self, draft_id: int) -> dict | None:
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
