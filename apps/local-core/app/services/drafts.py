"""Draft creation and version history (docs/07 draft_versions).

The LLM writes; the human edits and publishes. Every content change is a new
version — nothing is overwritten.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models_db import Draft, DraftVersion, Keyword, KeywordSnapshot, PublishJob
from planner.templates import PROMPT_VERSION, SYSTEM_PROMPT, build_prompt
from planner.types import BlogType
from providers.llm.base import LLMProvider
from publisher.markdown import clean_markdown

TITLE_PREFIX = "제목:"


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
    ) -> dict:
        blog_type = BlogType(plan_item["blog_type"])
        self._validate_snapshot(keyword_text, snapshot_id)
        if self._llm is not None:
            # raises for structure-only types: generation is V1-active for HOWTO/POLICY/REVIEW
            prompt = build_prompt(
                title=plan_item["title"],
                target_keyword=plan_item["target_keyword"],
                blog_type=blog_type,
                angle=plan_item.get("angle", ""),
                questions=questions,
            )
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

    def get_draft(self, draft_id: int) -> dict | None:
        with self._sessions() as session:
            draft = session.get(Draft, draft_id)
            if draft is None:
                return None
            versions = session.scalars(
                select(DraftVersion)
                .where(DraftVersion.draft_id == draft_id)
                .order_by(DraftVersion.version)
            ).all()
            return {
                "draft_id": draft.id,
                "blog_type": draft.blog_type,
                "title": draft.title,
                "source_snapshot_id": draft.source_snapshot_id,
                "plan": draft.plan_payload,
                "provider": draft.provider,
                "model": draft.model,
                "prompt_version": draft.prompt_version,
                "versions": [
                    {"version": v.version, "title": v.title, "body": v.body, "note": v.note}
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
