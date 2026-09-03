"""Draft creation and version history (docs/07 draft_versions).

The LLM writes; the human edits and publishes. Every content change is a new
version — nothing is overwritten.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, sessionmaker

from app.models_db import Draft, DraftVersion, Keyword, KeywordSnapshot, PublishJob
from app.services.factpacks import FactPackService, render_approved_evidence
from planner.templates import PROMPT_VERSION, SYSTEM_PROMPT, build_prompt
from planner.types import BlogType
from providers.llm.base import LLMProvider
from publisher.markdown import clean_markdown

TITLE_PREFIX = "제목:"
DRAFT_STATUSES = frozenset({"editing", "review_ready", "archived"})
_DRAFT_TRANSITIONS = {
    "editing": frozenset({"review_ready", "archived"}),
    "review_ready": frozenset({"editing", "archived"}),
    "archived": frozenset({"editing"}),
}


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
            )
            fact_context = render_approved_evidence(approved_evidence)
            if fact_context:
                prompt = f"{prompt}\n\n{fact_context}"
            generated = self._llm.generate(prompt, system=SYSTEM_PROMPT)
            title, body = split_generated(generated, plan_item["title"])
        else:
            title, body = plan_item["title"], skeleton_body(blog_type)
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
            return {
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

    def add_version(self, draft_id: int, title: str, body: str, note: str = "") -> dict:
        with self._sessions() as session:
            latest = session.scalar(
                select(DraftVersion)
                .where(DraftVersion.draft_id == draft_id)
                .order_by(DraftVersion.version.desc())
            )
            if latest is None:
                raise ValueError(f"draft {draft_id} has no versions")
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
            if job.status in {"pending", "running"}:
                return "pending"
            if job.status in {"draft_saved", "failed"}:
                return job.status
            return "pending"

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

    def create(self, draft_id: int) -> int:
        with self._sessions() as session:
            job = PublishJob(draft_id=draft_id, status="pending", history=[])
            session.add(job)
            session.commit()
            return job.id

    def update(
        self, job_id: int, *, status: str, stage: str, error_code: str | None, detail: str, history_entry: dict
    ) -> None:
        with self._sessions() as session:
            job = session.get(PublishJob, job_id)
            if job is None:
                return
            job.status = status
            job.stage = stage
            job.error_code = error_code
            job.detail = detail
            job.history = [*job.history, history_entry]
            session.commit()

    def get(self, job_id: int) -> dict | None:
        with self._sessions() as session:
            job = session.get(PublishJob, job_id)
            if job is None:
                return None
            return {
                "job_id": job.id,
                "draft_id": job.draft_id,
                "status": job.status,
                "stage": job.stage,
                "error_code": job.error_code,
                "detail": job.detail,
                "history": list(job.history),
            }
