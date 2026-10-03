"""Draft creation and version history (docs/07 draft_versions).

The LLM writes; the human edits and publishes. Every content change is a new
version — nothing is overwritten.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from typing import Callable

from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.exc import IntegrityError

from app.models_db import Draft, DraftAsset, DraftVersion, Keyword, KeywordSnapshot, PublishJob
from app.errors import DraftVersionConflict
from app.services.factpacks import FactPackService, render_approved_evidence
from planner.article_quality import build_expansion_prompt, build_repair_prompt, evaluate_article
from planner.templates import PROMPT_VERSION, SYSTEM_PROMPT, build_prompt
from planner.types import BlogType
from providers.llm.base import LLMError, LLMProvider
from publisher.markdown import clean_markdown

TITLE_PREFIX = "제목:"
DRAFT_STATUSES = frozenset({"editing", "review_ready", "archived"})
_DRAFT_TRANSITIONS = {
    "editing": frozenset({"review_ready", "archived"}),
    "review_ready": frozenset({"editing", "archived"}),
    "archived": frozenset({"editing"}),
}


def output_token_budget(target_chars: int) -> int:
    """Bound local-model output while leaving enough room for Korean prose."""

    # JSON structured output must also encode newlines and punctuation. A
    # ceiling below the visible character target can truncate an otherwise
    # valid article and leave invalid JSON, so keep roughly 30% headroom. The
    # prompt still asks for 90~115% of the requested length and the validator
    # rejects excessive output.
    return max(2400, min(5500, round(target_chars * 1.3)))


def _generate_article(
    llm: LLMProvider,
    prompt: str,
    *,
    max_tokens: int,
) -> str:
    structured = getattr(llm, "generate_article", None)
    if callable(structured):
        return structured(prompt, system=SYSTEM_PROMPT, max_tokens=max_tokens)
    return llm.generate(prompt, system=SYSTEM_PROMPT, max_tokens=max_tokens)


def _clean_shortfall(quality, target_chars: int) -> bool:
    return (
        quality.char_count < max(1200, round(target_chars * 0.85))
        and quality.checks["no_placeholders"]
        and quality.checks["no_meta_commentary"]
        and quality.checks["korean_ready"]
        and quality.checks["variety_ready"]
        and quality.keyword_count <= 12
    )


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _encode_cursor(created_at: datetime, draft_id: int) -> str:
    payload = json.dumps(
        {"at": created_at.isoformat(), "id": draft_id}, separators=(",", ":")
    ).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _decode_cursor(value: str) -> tuple[datetime, int]:
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        created_at = datetime.fromisoformat(payload["at"])
        draft_id = int(payload["id"])
        if draft_id < 1:
            raise ValueError
        return created_at, draft_id
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("invalid draft cursor") from exc


def split_generated(text: str, fallback_title: str) -> tuple[str, str]:
    """First line '제목: ...' becomes the title; the rest is the body."""
    lines = text.strip().split("\n")
    if lines and lines[0].strip().startswith(TITLE_PREFIX):
        title = lines[0].strip()[len(TITLE_PREFIX) :].strip()
        body = "\n".join(lines[1:]).strip()
        return (title or fallback_title), body
    return fallback_title, text.strip()


def skeleton_body(blog_type: BlogType) -> str:
    """LLM-less fallback: section headers with guidance, for pipeline tests."""
    from planner.templates import TEMPLATES

    parts = []
    for section in TEMPLATES[blog_type]:
        parts.append(section.name)
        if section.guidance:
            parts.append(f"({section.guidance})")
        parts.append("")
    return "\n".join(parts).strip()


class DraftService:
    def __init__(self, session_factory: sessionmaker[Session], llm: LLMProvider | None):
        self._sessions = session_factory
        self._llm = llm

    @property
    def provider_name(self) -> str:
        return self._llm.name if self._llm is not None else "skeleton"

    def readiness(self) -> dict:
        """Resolve the configured model without generating or persisting content."""

        if self._llm is None:
            return {
                "ready": False,
                "provider": "unconfigured",
                "model": "",
                "message": "실제 AI 모델이 연결되지 않았습니다.",
                "action": "설정에서 AI 모델을 연결한 뒤 다시 확인하세요.",
                "engine": "unconfigured",
                "auth": "missing",
                "quality_tier": "none",
            }
        try:
            resolver = getattr(self._llm, "resolve_model", None)
            model = str(resolver() if callable(resolver) else getattr(self._llm, "model_name", ""))
        except LLMError as exc:
            metadata = self._readiness_metadata()
            return {
                "ready": False,
                "provider": self.provider_name,
                "model": "",
                "message": str(exc),
                "action": (
                    "터미널에서 `codex login`을 실행한 뒤 다시 확인하세요."
                    if self.provider_name == "codex_cli"
                    else "AI 서버를 실행하고 사용할 모델이 설치되었는지 확인하세요."
                ),
                **metadata,
            }
        metadata = self._readiness_metadata()
        is_codex = self.provider_name == "codex_cli"
        return {
            "ready": bool(model),
            "provider": self.provider_name,
            "model": model,
            "message": (
                "Codex 고품질 AI가 연결되었습니다. 생성 원고는 임시저장 전에 확인하세요."
                if model and is_codex
                else "AI 모델이 연결되었습니다. 생성 원고는 임시저장 전에 확인하세요."
                if model
                else "사용할 AI 모델을 찾지 못했습니다."
            ),
            "action": "" if model else "AI 모델을 하나 이상 설치하세요.",
            **metadata,
        }

    def _readiness_metadata(self) -> dict[str, str]:
        metadata = getattr(self._llm, "status_metadata", None)
        if isinstance(metadata, dict):
            return {
                "engine": str(metadata.get("engine") or self.provider_name),
                "auth": str(metadata.get("auth") or "unknown"),
                "quality_tier": str(metadata.get("quality_tier") or "unknown"),
            }
        if self.provider_name == "ollama":
            return {"engine": "ollama", "auth": "not_required", "quality_tier": "local"}
        if self.provider_name == "openai_compat":
            return {"engine": "openai_compat", "auth": "configured", "quality_tier": "external"}
        return {"engine": self.provider_name, "auth": "unknown", "quality_tier": "unknown"}

    def _validate_snapshot(self, keyword_text: str, snapshot_id: int | None) -> None:
        """Reject invalid lineage before an external LLM call can consume time or quota."""
        if snapshot_id is None:
            return
        with self._sessions() as session:
            keyword = session.scalar(select(Keyword).where(Keyword.text == keyword_text))
            snapshot = session.get(KeywordSnapshot, snapshot_id)
            if keyword is None or snapshot is None or snapshot.keyword_id != keyword.id:
                raise ValueError("snapshot_id does not belong to keyword")

    def create_draft(
        self,
        keyword_text: str,
        plan_item: dict,
        questions: list[str] | None = None,
        *,
        snapshot_id: int | None = None,
        fact_pack_id: int | None = None,
        fact_pack_version: int | None = None,
        user_notes: str = "",
        target_chars: int = 2500,
        enforce_quality: bool = False,
    ) -> dict:
        blog_type = BlogType(plan_item["blog_type"])
        self._validate_snapshot(keyword_text, snapshot_id)
        approved_evidence = FactPackService(self._sessions).approved_context(
            keyword_text,
            snapshot_id,
            fact_pack_id,
            fact_pack_version,
        )
        if self._llm is not None:
            prompt = build_prompt(
                title=plan_item["title"],
                target_keyword=plan_item["target_keyword"],
                blog_type=blog_type,
                angle=plan_item.get("angle", ""),
                questions=questions,
                min_chars=target_chars,
                user_notes=user_notes,
            )
            fact_context = render_approved_evidence(approved_evidence)
            if fact_context:
                prompt = f"{prompt}\n\n{fact_context}"
            token_budget = output_token_budget(target_chars)
            generated = _generate_article(
                self._llm,
                prompt,
                max_tokens=token_budget,
            )
            title, body = split_generated(generated, plan_item["title"])
            quality = evaluate_article(
                clean_markdown(title),
                clean_markdown(body),
                plan_item["target_keyword"],
                target_chars=target_chars,
            )
            repair_attempted = False
            if enforce_quality and not quality.passed:
                repair_attempted = True
                if _clean_shortfall(quality, target_chars):
                    missing_chars = max(500, target_chars - quality.char_count)
                    expansion_budget = max(900, min(token_budget, round(missing_chars * 1.5)))
                    expanded = _generate_article(
                        self._llm,
                        build_expansion_prompt(
                            title=title,
                            body=body,
                            keyword=plan_item["target_keyword"],
                            target_chars=target_chars,
                            round_index=0,
                        ),
                        max_tokens=expansion_budget,
                    )
                    _, extra_body = split_generated(expanded, "추가 본문")
                    body = f"{body.rstrip()}\n\n{extra_body.lstrip()}"
                else:
                    repaired = _generate_article(
                        self._llm,
                        build_repair_prompt(
                            title=title,
                            body=body,
                            keyword=plan_item["target_keyword"],
                            target_chars=target_chars,
                            issues=quality.issues,
                        ),
                        max_tokens=token_budget,
                    )
                    title, body = split_generated(repaired, plan_item["title"])
                quality = evaluate_article(
                    clean_markdown(title),
                    clean_markdown(body),
                    plan_item["target_keyword"],
                    target_chars=target_chars,
                )
                # Some local models stop early even when explicitly asked for
                # the missing length. At most two additional, bounded top-ups
                # are cheaper and more reliable than another full rewrite.
                for round_index in range(1, 3):
                    if not _clean_shortfall(quality, target_chars):
                        break
                    missing_chars = max(500, target_chars - quality.char_count)
                    top_up_budget = max(900, min(token_budget, round(missing_chars * 1.5)))
                    top_up = _generate_article(
                        self._llm,
                        build_expansion_prompt(
                            title=title,
                            body=body,
                            keyword=plan_item["target_keyword"],
                            target_chars=target_chars,
                            round_index=round_index,
                        ),
                        max_tokens=top_up_budget,
                    )
                    _, top_up_body = split_generated(top_up, "추가 본문")
                    body = f"{body.rstrip()}\n\n{top_up_body.lstrip()}"
                    quality = evaluate_article(
                        clean_markdown(title),
                        clean_markdown(body),
                        plan_item["target_keyword"],
                        target_chars=target_chars,
                    )
            if enforce_quality and not quality.passed:
                summary = " ".join(quality.issues[:3])
                raise LLMError(f"완성 글 품질 검사를 통과하지 못했습니다. {summary}")
        else:
            title, body = plan_item["title"], skeleton_body(blog_type)
            quality = None
            repair_attempted = False
        title = clean_markdown(title)
        body = clean_markdown(body)
        provider_name = self.provider_name
        model_name = getattr(self._llm, "model_name", "") if self._llm is not None else ""

        with self._sessions() as session:
            keyword = session.scalar(select(Keyword).where(Keyword.text == keyword_text))
            if keyword is None:
                keyword = Keyword(text=keyword_text)
                session.add(keyword)
                session.flush()
            if snapshot_id is not None:
                snapshot = session.get(KeywordSnapshot, snapshot_id)
                if snapshot is None or snapshot.keyword_id != keyword.id:
                    raise ValueError("snapshot_id does not belong to keyword")
            draft = Draft(
                keyword_id=keyword.id,
                source_snapshot_id=snapshot_id,
                plan_order=plan_item.get("order"),
                plan_payload=dict(plan_item),
                blog_type=blog_type.value,
                title=title,
                provider=provider_name,
                model=model_name,
                prompt_version=PROMPT_VERSION,
                fact_pack_id=fact_pack_id,
                fact_pack_version=fact_pack_version,
            )
            session.add(draft)
            session.flush()
            session.add(DraftVersion(draft_id=draft.id, version=1, title=title, body=body, note="V1 원본"))
            session.commit()
            response = {
                "draft_id": draft.id,
                "version": 1,
                "title": title,
                "body": body,
                "source_snapshot_id": snapshot_id,
                "fact_pack_id": fact_pack_id,
                "fact_pack_version": fact_pack_version,
                "provider": provider_name,
                "model": model_name,
                "prompt_version": PROMPT_VERSION,
            }
            if quality is not None:
                response["quality"] = quality.payload(repair_attempted=repair_attempted)
            return response

    def add_version(self, draft_id: int, title: str, body: str, note: str = "", expected_version: int | None = None) -> dict:
        with self._sessions() as session:
            # Serialize the version check and append, including legacy clients.
            # Checking before the transaction would still permit lost updates.
            session.execute(text("BEGIN IMMEDIATE"))
            latest = session.scalar(
                select(DraftVersion)
                .where(DraftVersion.draft_id == draft_id)
                .order_by(DraftVersion.version.desc())
            )
            if latest is None:
                raise ValueError(f"draft {draft_id} has no versions")
            if expected_version is not None and latest.version != expected_version:
                raise DraftVersionConflict("다른 화면에서 새 버전을 저장했습니다. 편집 내용은 유지하고 최신 원고와 비교한 뒤 다시 저장하세요.")
            next_version = latest.version + 1
            session.add(
                DraftVersion(
                    draft_id=draft_id,
                    version=next_version,
                    title=clean_markdown(title),
                    body=clean_markdown(body),
                    note=note,
                )
            )
            draft = session.get(Draft, draft_id)
            if draft is not None:
                draft.title = clean_markdown(title)
            session.commit()
            return {"draft_id": draft_id, "version": next_version}

    def list_drafts(
        self,
        *,
        query: str = "",
        status: str | None = None,
        cursor: str | None = None,
        limit: int = 20,
    ) -> dict:
        if status is not None and status not in DRAFT_STATUSES:
            raise ValueError("invalid draft status")
        if limit < 1 or limit > 50:
            raise ValueError("draft limit must be between 1 and 50")

        latest_versions = (
            select(
                DraftVersion.draft_id.label("draft_id"),
                func.max(DraftVersion.version).label("latest_version"),
            )
            .group_by(DraftVersion.draft_id)
            .subquery()
        )
        latest_jobs = (
            select(PublishJob.draft_id.label("draft_id"), func.max(PublishJob.id).label("job_id"))
            .group_by(PublishJob.draft_id)
            .subquery()
        )
        stmt = (
            select(Draft, Keyword, DraftVersion, PublishJob)
            .join(Keyword, Keyword.id == Draft.keyword_id)
            .join(latest_versions, latest_versions.c.draft_id == Draft.id)
            .join(
                DraftVersion,
                and_(
                    DraftVersion.draft_id == Draft.id,
                    DraftVersion.version == latest_versions.c.latest_version,
                ),
            )
            .outerjoin(latest_jobs, latest_jobs.c.draft_id == Draft.id)
            .outerjoin(PublishJob, PublishJob.id == latest_jobs.c.job_id)
        )
        normalized_query = query.strip()
        if normalized_query:
            needle = f"%{normalized_query.casefold()}%"
            stmt = stmt.where(
                or_(
                    func.lower(Keyword.text).like(needle),
                    func.lower(DraftVersion.title).like(needle),
                )
            )
        if status is not None:
            stmt = stmt.where(Draft.user_status == status)
        if cursor:
            cursor_at, cursor_id = _decode_cursor(cursor)
            stmt = stmt.where(
                or_(
                    DraftVersion.created_at < cursor_at,
                    and_(DraftVersion.created_at == cursor_at, Draft.id < cursor_id),
                )
            )
        stmt = stmt.order_by(DraftVersion.created_at.desc(), Draft.id.desc()).limit(limit + 1)

        with self._sessions() as session:
            rows = session.execute(stmt).all()
        has_more = len(rows) > limit
        rows = rows[:limit]

        def delivery_status(job: PublishJob | None) -> str:
            if job is None:
                return "none"
            # Preserve delivery states in the list read-model. In particular,
            # a strictly verified saved draft must not become "pending" again.
            if job.status in {"pending", "waiting_extension", "running", "draft_saved", "verified_draft_saved", "failed"}:
                return job.status
            return "unknown"

        items = [
            {
                "draft_id": draft.id,
                "keyword": keyword.text,
                "title": version.title,
                "blog_type": draft.blog_type,
                "latest_version": version.version,
                "latest_version_at": _iso(version.created_at),
                "user_status": draft.user_status,
                "latest_job_status": delivery_status(job),
                "latest_job_id": job.id if job is not None else None,
                "latest_job_stage": job.stage if job is not None else None,
                "latest_job_error": job.detail if job is not None and job.status == "failed" else None,
                "source_snapshot_id": draft.source_snapshot_id,
            }
            for draft, keyword, version, job in rows
        ]
        next_cursor = None
        if has_more and rows:
            draft, _keyword, version, _job = rows[-1]
            next_cursor = _encode_cursor(version.created_at, draft.id)
        return {"items": items, "next_cursor": next_cursor}

    def update_status(self, draft_id: int, status: str) -> dict | None:
        if status not in DRAFT_STATUSES:
            raise ValueError("invalid draft status")
        with self._sessions() as session:
            draft = session.get(Draft, draft_id)
            if draft is None:
                return None
            current = draft.user_status
            if status != current and status not in _DRAFT_TRANSITIONS[current]:
                raise ValueError(f"draft status transition not allowed: {current} -> {status}")
            draft.user_status = status
            session.commit()
            return {"draft_id": draft.id, "user_status": draft.user_status}

    def get_draft(self, draft_id: int) -> dict | None:
        with self._sessions() as session:
            draft = session.get(Draft, draft_id)
            if draft is None:
                return None
            keyword = session.get(Keyword, draft.keyword_id)
            versions = session.scalars(
                select(DraftVersion)
                .where(DraftVersion.draft_id == draft_id)
                .order_by(DraftVersion.version)
            ).all()
            return {
                "draft_id": draft.id,
                "keyword": keyword.text if keyword is not None else "",
                "blog_type": draft.blog_type,
                "title": draft.title,
                "source_snapshot_id": draft.source_snapshot_id,
                "user_status": draft.user_status,
                "fact_pack_id": draft.fact_pack_id,
                "fact_pack_version": draft.fact_pack_version,
                "created_at": _iso(draft.created_at),
                "plan": draft.plan_payload,
                "provider": draft.provider,
                "model": draft.model,
                "prompt_version": draft.prompt_version,
                "versions": [
                    {
                        "version": v.version,
                        "title": v.title,
                        "body": v.body,
                        "note": v.note,
                        "created_at": _iso(v.created_at),
                    }
                    for v in versions
                ],
            }


class SqlJobStore:
    """publisher.jobs.JobStore backed by the publish_jobs table."""

    def __init__(self, session_factory: sessionmaker[Session]):
        self._sessions = session_factory

    def create(
        self,
        draft_id: int,
        *,
        transport: str = "dedicated_chrome_cdp",
        draft_version: int = 1,
        asset_manifest_version: int = 0,
        idempotency_key: str | None = None,
        request_payload: dict | None = None,
    ) -> int:
        with self._sessions() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            if idempotency_key:
                existing = session.scalar(select(PublishJob).where(PublishJob.idempotency_key == idempotency_key))
                if existing is not None:
                    if transport == "current_chrome_extension" and (existing.request_payload or {}).get("target_worker_id") != (request_payload or {}).get("target_worker_id"):
                        raise DraftVersionConflict("기존 작업을 요청한 브라우저에서 재개하세요.")
                    return existing.id
            if transport == "current_chrome_extension":
                snapshot = (request_payload or {}).get("asset_snapshot")
                if snapshot is None:
                    raise ValueError("an immutable image snapshot is required")
                rows = session.scalars(select(DraftAsset).where(
                    DraftAsset.draft_id == draft_id, DraftAsset.draft_version == draft_version,
                ).order_by(DraftAsset.position, DraftAsset.id)).all()
                actual = [{key: getattr(row, "id" if key == "asset_id" else key) for key in expected} for row, expected in zip(rows, snapshot)]
                if len(rows) != len(snapshot) or actual != snapshot:
                    raise DraftVersionConflict("이미지 구성이 작업 생성 중 변경되었습니다.")
                active = session.scalar(select(PublishJob.id).where(
                    PublishJob.draft_id == draft_id, PublishJob.draft_version == draft_version,
                    PublishJob.status.in_(("pending", "waiting_extension", "running")),
                ))
                if active is not None:
                    raise DraftVersionConflict("현재 원고 버전의 임시저장 작업이 진행 중입니다.")
            job = PublishJob(
                draft_id=draft_id,
                status="pending",
                history=[],
                transport=transport,
                draft_version=draft_version,
                asset_manifest_version=asset_manifest_version,
                idempotency_key=idempotency_key,
                request_payload=request_payload or {},
                verification={},
            )
            session.add(job)
            try:
                session.commit()
            except IntegrityError:
                session.rollback()
                if not idempotency_key:
                    raise
                existing = session.scalar(select(PublishJob.id).where(PublishJob.idempotency_key == idempotency_key))
                if existing is None:
                    raise
                return existing
            return job.id

    def by_idempotency_key(self, key: str) -> dict | None:
        with self._sessions() as session:
            job_id = session.scalar(select(PublishJob.id).where(PublishJob.idempotency_key == key))
        return self.get(job_id) if job_id is not None else None

    def restart(self, job_id: int, *, only_if_failed: bool = False) -> None:
        with self._sessions() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            job = session.get(PublishJob, job_id)
            if job is None or job.status in {"draft_saved", "verified_draft_saved"}:
                return
            if job.status != "failed":
                if only_if_failed:
                    return  # A concurrent identical request already resumed it.
                raise ValueError("only a failed publish job can be restarted")
            other = session.scalar(select(PublishJob.id).where(
                PublishJob.draft_id == job.draft_id, PublishJob.draft_version == job.draft_version,
                PublishJob.id != job.id, PublishJob.status.in_(("pending", "waiting_extension", "running")),
            ))
            if other is not None:
                raise DraftVersionConflict("현재 원고 버전의 다른 임시저장 작업이 진행 중입니다.")
            payload = dict(job.request_payload or {})
            passed = payload.get("passed_stages", [])
            resume_stage = "reopen_verify" if job.stage in {"draft_save", "reopen_verify"} or "draft_save" in passed else "browser_attach"
            if resume_stage == "browser_attach" and ("upload_images" in passed or payload.get("resume_stage") == "input_tags") and (job.verification or {}).get("image_receipts"):
                resume_stage = "input_tags"
            if resume_stage == "browser_attach" and job.transport == "current_chrome_extension" and ("input_body" in passed or payload.get("resume_stage") == "upload_images"):
                # The extension must revalidate the pinned text and zero images.
                # Never restart title/body entry over an already-filled editor.
                resume_stage = "upload_images"
            payload.update(resume_stage=resume_stage, attempt_id=None, passed_stages=[])
            job.request_payload = payload
            entry = {
                "stage": resume_stage, "status": "pending",
                "at": datetime.now(timezone.utc).isoformat(), "error_code": None,
                "detail": "same idempotent job restarted",
            }
            job.status = "pending"
            job.stage = resume_stage
            job.error_code = None
            job.detail = "waiting to resume saved-draft verification" if resume_stage == "reopen_verify" else "waiting for publisher transport"
            if resume_stage == "browser_attach":
                job.verification = {}
            job.lease_owner = None
            job.lease_expires_at = None
            job.history = [*job.history, entry]
            session.commit()

    def claim_lease(self, job_id: int, owner: str, *, ttl_seconds: int = 300) -> bool:
        if not owner.strip() or len(owner) > 100:
            raise ValueError("a valid extension lease owner is required")
        now = datetime.now(timezone.utc)
        with self._sessions() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            candidate = session.get(PublishJob, job_id)
            if candidate is None or (candidate.transport == "current_chrome_extension"
                                     and (candidate.request_payload or {}).get("target_worker_id") != owner):
                return False
            claimed = session.execute(
                update(PublishJob).where(
                    PublishJob.id == job_id,
                    PublishJob.status.in_(("pending", "waiting_extension")),
                    or_(PublishJob.lease_owner.is_(None), PublishJob.lease_expires_at.is_(None), PublishJob.lease_expires_at <= now),
                ).values(lease_owner=owner, lease_expires_at=now + timedelta(seconds=ttl_seconds), status="running")
            ).rowcount
            if claimed != 1:
                return False
            job = session.get(PublishJob, job_id)
            payload = dict(job.request_payload or {})
            resume_stage = payload.get("resume_stage") or ("reopen_verify" if job.stage == "reopen_verify" else "browser_attach")
            payload.update(attempt_id=uuid4().hex, resume_stage=resume_stage, passed_stages=[])
            job.request_payload = payload
            # Claim is not an editor event: preserve the saved-draft checkpoint.
            job.stage = resume_stage
            job.history = [*job.history, {
                "stage": resume_stage, "status": "running", "at": now.isoformat(),
                "detail": "extension claimed publish job", "attempt_id": payload["attempt_id"],
            }]
            session.commit()
            return True

    def mark_waiting(self, job_id: int) -> None:
        with self._sessions() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            job = session.get(PublishJob, job_id)
            if job is None or job.status not in {"pending", "waiting_extension"}:
                return
            if job.status == "waiting_extension":
                return
            stage = "reopen_verify" if job.stage == "reopen_verify" else "browser_attach"
            job.status = "waiting_extension"
            job.stage = stage
            job.detail = "waiting for current Chrome extension"
            job.history = [*job.history, {"stage": stage, "status": "waiting_extension", "at": datetime.now(timezone.utc).isoformat(), "detail": job.detail}]
            session.commit()

    def extension_event(
        self, job_id: int, *, attempt_id: str, lease_owner: str,
        stage: str, status: str, error_code: str | None, detail: str,
        verification: dict | None, stages: tuple[str, ...],
        validate: Callable[[dict], tuple[str, str | None, str]],
    ) -> dict | None:
        """Serialize identity, legal transition, checkpoint and history in one write."""
        now = datetime.now(timezone.utc)
        with self._sessions() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            job = session.get(PublishJob, job_id)
            if job is None:
                return None
            payload = dict(job.request_payload or {})
            expires = job.lease_expires_at
            if expires is not None and expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if (job.transport != "current_chrome_extension" or not attempt_id or not lease_owner
                    or payload.get("attempt_id") != attempt_id or job.lease_owner != lease_owner
                    or expires is None or expires <= now):
                raise ValueError("publisher attempt or lease is stale")
            if job.status in {"failed", "draft_saved", "verified_draft_saved"}:
                raise ValueError("terminal publish jobs do not accept extension events")
            resume_stage = payload.get("resume_stage")
            resume_sequences = {
                "reopen_verify": ("reopen_verify",),
                "input_tags": ("input_tags", "draft_save", "reopen_verify"),
                "upload_images": ("upload_images", "input_tags", "draft_save", "reopen_verify"),
            }
            sequence = resume_sequences.get(resume_stage, stages)
            passed = list(payload.get("passed_stages", []))
            next_stage = sequence[len(passed)] if len(passed) < len(sequence) else None
            optional_attach = resume_stage in resume_sequences and stage == "browser_attach" and not passed
            uncertain_ack = status == "failed" and passed and passed[-1] == stage and job.stage == stage
            if stage != next_stage and not optional_attach and not uncertain_ack:
                raise ValueError("publisher stage transition is not allowed")
            row = self._view(job)
            result_status, result_error, result_detail = validate(row)
            if status == "passed" and result_status != "failed" and not optional_attach:
                passed.append(stage)
            payload["passed_stages"] = passed
            job.request_payload = payload
            if verification is not None:
                values = dict(job.verification or {})
                # Upload receipts are an immutable checkpoint; a bad reopen
                # observation cannot replace them and poison a later retry.
                incoming = dict(verification)
                if stage != "upload_images" or status != "passed" or result_status == "failed":
                    incoming.pop("image_receipts", None)
                values.update(incoming)
                job.verification = values
            job.status = result_status
            job.stage = stage
            job.error_code = result_error
            job.detail = result_detail
            job.lease_expires_at = now + timedelta(seconds=300)
            job.history = [*job.history, {
                "stage": stage, "status": "failed" if result_status == "failed" else status,
                "at": now.isoformat(), "attempt_id": attempt_id,
                "error_code": result_error, "detail": result_detail,
                **({"verification": verification} if verification is not None else {}),
            }]
            session.commit()
            return self._view(job)

    def expire_leases(self, job_id: int | None = None) -> int:
        """Close stalled attempts, never automatically start a new writer."""
        now = datetime.now(timezone.utc)
        with self._sessions() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            query = select(PublishJob).where(
                PublishJob.transport == "current_chrome_extension",
                PublishJob.status == "running",
                PublishJob.lease_expires_at.is_not(None), PublishJob.lease_expires_at <= now,
            )
            if job_id is not None:
                query = query.where(PublishJob.id == job_id)
            jobs = session.scalars(query).all()
            for job in jobs:
                job.status = "failed"
                job.error_code = "lease_expired"
                job.detail = "확장 연결이 끊겨 실행이 중단되었습니다. 저장 단계였다면 재시도 시 저장본 확인만 진행합니다."
                job.history = [*job.history, {
                    "stage": job.stage, "status": "failed", "at": now.isoformat(),
                    "attempt_id": (job.request_payload or {}).get("attempt_id"),
                    "error_code": "lease_expired", "detail": job.detail,
                }]
            session.commit()
            return len(jobs)

    def next_available(self, transport: str, blog_ids: list[str] | None = None, *, target_worker_id: str | None = None) -> int | None:
        self.expire_leases()
        now = datetime.now(timezone.utc)
        eligible = {value.strip().casefold() for value in (blog_ids or []) if value.strip()}
        if blog_ids is not None and not eligible:
            return None
        with self._sessions() as session:
            jobs = session.scalars(
                select(PublishJob).where(
                    PublishJob.transport == transport,
                    PublishJob.status.in_(("pending", "waiting_extension")),
                ).where(PublishJob.request_payload["target_worker_id"].as_string() == target_worker_id)
                .order_by(PublishJob.id).limit(20)
            ).all()
            for job in jobs:
                requested_blog = str((job.request_payload or {}).get("blog_id") or "").strip().casefold()
                if eligible and requested_blog not in eligible:
                    continue
                expires = job.lease_expires_at
                if expires is not None and expires.tzinfo is None:
                    expires = expires.replace(tzinfo=timezone.utc)
                if not job.lease_owner or not expires or expires <= now:
                    return job.id
        return None

    def latest(self, draft_id: int) -> dict | None:
        with self._sessions() as session:
            job_id = session.scalar(
                select(PublishJob.id).where(PublishJob.draft_id == draft_id)
                .order_by(PublishJob.id.desc()).limit(1)
            )
        return self.get(job_id) if job_id is not None else None

    def update(
        self, job_id: int, *, status: str, stage: str, error_code: str | None, detail: str, history_entry: dict
    ) -> None:
        with self._sessions() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            job = session.get(PublishJob, job_id)
            if job is None:
                return
            if job.status in {"failed", "draft_saved", "verified_draft_saved"}:
                raise ValueError("terminal publish jobs do not accept updates")
            job.status = status
            job.stage = stage
            job.error_code = error_code
            job.detail = detail
            job.history = [*job.history, history_entry]
            session.commit()

    def update_verification(self, job_id: int, verification: dict) -> None:
        with self._sessions() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            job = session.get(PublishJob, job_id)
            if job is None:
                return
            job.verification = {**(job.verification or {}), **verification}
            session.commit()

    def get(self, job_id: int) -> dict | None:
        with self._sessions() as session:
            job = session.get(PublishJob, job_id)
            if job is None:
                return None
            return self._view(job)

    @staticmethod
    def _view(job: PublishJob) -> dict:
        return {
            "job_id": job.id, "draft_id": job.draft_id,
            "status": job.status, "stage": job.stage, "error_code": job.error_code,
            "detail": job.detail, "history": list(job.history),
            "transport": job.transport, "draft_version": job.draft_version,
            "asset_manifest_version": job.asset_manifest_version,
            "idempotency_key": job.idempotency_key,
            "request_payload": dict(job.request_payload), "verification": dict(job.verification),
            "lease_owner": job.lease_owner, "lease_expires_at": _iso(job.lease_expires_at),
        }
