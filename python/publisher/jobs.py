"""Publish job state machine. Every stage is timestamped so a failure names its
exact spot (docs/07 publish_jobs). Health-check failure stops the run BEFORE any
input reaches the editor."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol

from publisher.editor import EditorError, SmartEditorAdapter
from publisher.health import HealthReport
from publisher.page import PageLike

STAGES = ("health_check", "prepare_editor", "input_title", "input_body", "input_tags", "draft_save")


class JobStore(Protocol):
    def create(self, draft_id: int) -> int: ...
    def update(self, job_id: int, *, status: str, stage: str, error_code: str | None, detail: str, history_entry: dict) -> None: ...


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PublishJobRunner:
    def __init__(self, store: JobStore, health_runner=None):
        from publisher.health import run_health_check

        self._store = store
        self._run_health = health_runner or run_health_check

    def run(
        self,
        page: PageLike,
        adapter: SmartEditorAdapter,
        *,
        draft_id: int,
        blog_id: str,
        title: str,
        body: str,
        tags: list[str],
    ) -> dict:
        job_id = self._store.create(draft_id)

        def record(stage: str, status: str, error_code: str | None = None, detail: str = "") -> None:
            self._store.update(
                job_id,
                status=status,
                stage=stage,
                error_code=error_code,
                detail=detail,
                history_entry={"stage": stage, "status": status, "at": _now(), "error_code": error_code, "detail": detail},
            )

        # gate: no input starts unless every health check passes (docs/05)
        record("health_check", "running")
        report: HealthReport = self._run_health(page, blog_id)
        if not report.all_ok:
            detail = ", ".join(report.failed)
            record("health_check", "failed", "health_check_failed", detail)
            return {"job_id": job_id, "status": "failed", "stage": "health_check", "failed_checks": report.failed}
        record("health_check", "passed")

        steps = (
            # Health already navigated to and validated this exact editor page.
            ("prepare_editor", adapter.dismiss_popups),
            ("input_title", lambda: adapter.input_title(title)),
            ("input_body", lambda: adapter.input_body(body)),
            ("input_tags", lambda: adapter.input_tags(tags)),
            ("draft_save", adapter.save_draft),
        )
        for stage, step in steps:
            record(stage, "running")
            try:
                step()
            except (EditorError, LookupError, RuntimeError) as exc:
                code = exc.stage if isinstance(exc, EditorError) else "editor_error"
                record(stage, "failed", code, str(exc))
                return {"job_id": job_id, "status": "failed", "stage": stage, "error": str(exc)}
            record(stage, "passed")

        record("draft_save", "draft_saved")
        return {"job_id": job_id, "status": "draft_saved", "stage": "draft_save"}
