"""Connect an existing Draft latest version to the draft-save-only publisher."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, ContextManager

from sqlalchemy.orm import Session, sessionmaker

from app.services.drafts import DraftService, SqlJobStore
from publisher.browser import attached_page
from publisher.editor import SmartEditorAdapter
from publisher.jobs import PublishJobRunner
from publisher.page import PageLike


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class PreparedPublish:
    job_id: int
    draft_id: int
    blog_id: str
    cdp_url: str
    title: str
    body: str
    tags: list[str]


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
        self._page_factory = page_factory
        self._adapter_factory = adapter_factory
        self._runner_factory = runner_factory

    def prepare(
        self,
        draft_id: int,
        *,
        blog_id: str,
        tags: list[str],
        cdp_url: str,
    ) -> PreparedPublish | None:
        draft = DraftService(self._sessions, None).get_draft(draft_id)
        if draft is None or not draft["versions"]:
            return None
        latest = draft["versions"][-1]
        job_id = self._store.create(draft_id)
        return PreparedPublish(
            job_id=job_id,
            draft_id=draft_id,
            blog_id=blog_id,
            cdp_url=cdp_url,
            title=latest["title"],
            body=latest["body"],
            tags=[tag.strip() for tag in tags if tag.strip()][:10],
        )

    def run(self, task: PreparedPublish) -> None:
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
        except Exception as exc:  # noqa: BLE001 - every unexpected publisher failure must close the job
            current = self._store.get(task.job_id)
            if current is not None and current["status"] in {"failed", "draft_saved"}:
                return
            stage = "publisher_runtime" if attached else "browser_attach"
            error_code = "publisher_error" if attached else "browser_unavailable"
            detail = f"{stage} failed ({type(exc).__name__})"
            self._store.update(
                task.job_id,
                status="failed",
                stage=stage,
                error_code=error_code,
                detail=detail,
                history_entry={
                    "stage": stage,
                    "status": "failed",
                    "at": _now(),
                    "error_code": error_code,
                    "detail": detail,
                },
            )

    def get_job(self, job_id: int) -> dict | None:
        return self._store.get(job_id)
