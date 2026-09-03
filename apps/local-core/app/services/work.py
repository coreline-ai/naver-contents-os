"""Deterministic local-only recommendations for the next user action."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models_db import (
    AdPerformanceSnapshot,
    DiscoveryRun,
    Draft,
    DraftVersion,
    Keyword,
    PublishedContent,
    PublishJob,
    WatchlistItem,
)
from app.services.published import build_content_state_index, publication_state
from intelligence.keyword.models import compact

LOCAL_FRESH_FOR = timedelta(days=1)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return _as_utc(value).isoformat()


def _parse(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _as_utc(value)
    if isinstance(value, str) and value:
        try:
            return _as_utc(datetime.fromisoformat(value.replace("Z", "+00:00")))
        except ValueError:
            return None
    return None


def _is_stale(value: object, now: datetime) -> bool:
    parsed = _parse(value)
    return parsed is None or now - parsed > LOCAL_FRESH_FOR


class TodayWorkService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        now: Callable[[], datetime] | None = None,
    ):
        self._sessions = session_factory
        self._now = now or _utcnow

    def list(self, *, limit: int = 5) -> dict:
        if limit < 1 or limit > 5:
            raise ValueError("today work limit must be between 1 and 5")
        now = _as_utc(self._now())
        calculated_at = _iso(now)
        recommendations: list[dict] = []
        seen_drafts: set[int] = set()
        seen_keywords: set[str] = set()

        def add(
            *,
            priority: int,
            source_type: str,
            source_id: int,
            keyword: str,
            title: str,
            reason: str,
            action: str,
            stale: bool = False,
            draft_id: int | None = None,
            publish_job_id: int | None = None,
            published_content_id: int | None = None,
            published_url: str | None = None,
        ) -> None:
            keyword_key = compact(keyword)
            if (draft_id is not None and draft_id in seen_drafts) or keyword_key in seen_keywords:
                return
            recommendations.append(
                {
                    "id": f"{source_type}:{source_id}",
                    "priority": priority,
                    "source_type": source_type,
                    "source_id": source_id,
                    "keyword": keyword,
                    "title": title,
                    "reason": reason,
                    "action": action,
                    "stale": stale,
                    "draft_id": draft_id,
                    "publish_job_id": publish_job_id,
                    "published_content_id": published_content_id,
                    "published_url": published_url,
                    "calculated_at": calculated_at,
                }
            )
            if draft_id is not None:
                seen_drafts.add(draft_id)
            if keyword_key:
                seen_keywords.add(keyword_key)

        with self._sessions() as session:
            latest_versions = (
                select(
                    DraftVersion.draft_id.label("draft_id"),
                    func.max(DraftVersion.version).label("version"),
                )
                .group_by(DraftVersion.draft_id)
                .subquery()
            )
            draft_rows = session.execute(
                select(Draft, Keyword, DraftVersion)
                .join(Keyword, Keyword.id == Draft.keyword_id)
                .join(latest_versions, latest_versions.c.draft_id == Draft.id)
                .join(
                    DraftVersion,
                    and_(
                        DraftVersion.draft_id == Draft.id,
                        DraftVersion.version == latest_versions.c.version,
                    ),
                )
                .order_by(DraftVersion.created_at.desc(), Draft.id.desc())
            ).all()
            draft_map = {
                draft.id: (draft, keyword, version)
                for draft, keyword, version in draft_rows
            }
            latest_jobs = (
                select(PublishJob.draft_id, func.max(PublishJob.id).label("job_id"))
                .group_by(PublishJob.draft_id)
                .subquery()
            )
            jobs = session.scalars(
                select(PublishJob)
                .join(latest_jobs, PublishJob.id == latest_jobs.c.job_id)
                .order_by(PublishJob.updated_at.desc(), PublishJob.id.desc())
            ).all()

            # 1. Failed latest delivery jobs.
            for job in jobs:
                row = draft_map.get(job.draft_id)
                if job.status != "failed" or row is None:
                    continue
                draft, keyword, version = row
                add(
                    priority=1,
                    source_type="publish_job",
                    source_id=job.id,
                    keyword=keyword.text,
                    title=version.title,
                    reason=f"SmartEditor 임시저장 작업이 {job.stage or '처리 단계'}에서 실패했습니다.",
                    action="inspect_error",
                    draft_id=draft.id,
                    publish_job_id=job.id,
                )

            # 2. Human review queue.
            for draft, keyword, version in draft_rows:
                if draft.user_status == "review_ready":
                    add(
                        priority=2,
                        source_type="draft",
                        source_id=draft.id,
                        keyword=keyword.text,
                        title=version.title,
                        reason="검수 대기 상태의 최신 초안이 있습니다.",
                        action="resume_draft",
                        draft_id=draft.id,
                    )

            # 3. Saved in SmartEditor but not explicitly registered as public.
            public_draft_ids = set(
                session.scalars(
                    select(PublishedContent.draft_id).where(
                        PublishedContent.draft_id.is_not(None)
                    )
                ).all()
            )
            for job in jobs:
                row = draft_map.get(job.draft_id)
                if (
                    job.status != "draft_saved"
                    or job.draft_id in public_draft_ids
                    or row is None
                ):
                    continue
                draft, keyword, version = row
                add(
                    priority=3,
                    source_type="publish_job",
                    source_id=job.id,
                    keyword=keyword.text,
                    title=version.title,
                    reason="SmartEditor 임시저장은 완료됐지만 실제 공개 등록은 아직 없습니다.",
                    action="register_publication",
                    draft_id=draft.id,
                    publish_job_id=job.id,
                )

            # 4. Explicitly registered public content older than 90 days.
            publications = session.execute(
                select(PublishedContent, Keyword)
                .join(Keyword, Keyword.id == PublishedContent.keyword_id)
                .order_by(PublishedContent.published_at, PublishedContent.id)
            ).all()
            for publication, keyword in publications:
                if publication_state(publication, now=now) != "stale":
                    continue
                add(
                    priority=4,
                    source_type="published_content",
                    source_id=publication.id,
                    keyword=keyword.text,
                    title=publication.title,
                    reason="실제 공개 후 90일 이상 지나 갱신 여부를 검토할 시점입니다.",
                    action="open_analysis",
                    published_content_id=publication.id,
                    published_url=publication.canonical_url,
                )

            content_states = build_content_state_index(session, now=now)

            # 5a. Rising watchlist items without content. Partial/stale data only asks for refresh.
            watch_rows = session.execute(
                select(WatchlistItem, Keyword)
                .join(Keyword, Keyword.id == WatchlistItem.keyword_id)
                .order_by(WatchlistItem.id)
            ).all()
            for watch, keyword in watch_rows:
                content = content_states.get(compact(keyword.text), {"state": "missing"})
                if content["state"] != "missing" or not watch.last_snapshot:
                    continue
                previous = watch.previous_snapshot or {}
                current = watch.last_snapshot
                comparable = (
                    previous.get("comparison_key") == current.get("comparison_key")
                    and isinstance(previous.get("latest_ratio"), (int, float))
                    and isinstance(current.get("latest_ratio"), (int, float))
                )
                rising = (
                    comparable
                    and float(current["latest_ratio"]) > float(previous["latest_ratio"])
                )
                stale = (
                    _is_stale(current.get("collected_at"), now)
                    or watch.last_status != "ok"
                )
                if not rising and not stale:
                    continue
                add(
                    priority=5,
                    source_type="watchlist",
                    source_id=watch.id,
                    keyword=keyword.text,
                    title=keyword.text,
                    reason=(
                        "Watchlist 근거가 오래됐거나 부분 데이터여서 먼저 갱신해야 합니다."
                        if stale
                        else "Watchlist 상대 추세가 상승 중이고 작성된 콘텐츠가 없습니다."
                    ),
                    action="refresh_data" if stale else "open_analysis",
                    stale=stale,
                )

            # 5b. Only the latest discovery run; missing evidence is never a writing signal.
            discovery = session.scalar(
                select(DiscoveryRun).order_by(
                    DiscoveryRun.created_at.desc(), DiscoveryRun.id.desc()
                )
            )
            if discovery is not None:
                run_stale = _is_stale(discovery.created_at, now)
                candidates = (
                    discovery.payload.get("candidates", [])
                    if isinstance(discovery.payload, dict)
                    else []
                )
                for candidate in candidates:
                    if (
                        not isinstance(candidate, dict)
                        or candidate.get("direction") not in {"new", "rising"}
                    ):
                        continue
                    keyword_text = str(candidate.get("keyword") or "").strip()
                    content = content_states.get(
                        compact(keyword_text), {"state": "missing"}
                    )
                    if not keyword_text or content["state"] != "missing":
                        continue
                    data_status = (
                        candidate.get("data_status")
                        if isinstance(candidate.get("data_status"), dict)
                        else {}
                    )
                    partial = (
                        data_status.get("trend") != "ok"
                        or candidate.get("freshness_score") is None
                    )
                    stale = run_stale or partial
                    add(
                        priority=5,
                        source_type="discovery_run",
                        source_id=discovery.id,
                        keyword=keyword_text,
                        title=keyword_text,
                        reason=(
                            "급상승 후보 근거가 오래됐거나 부분 데이터여서 먼저 갱신해야 합니다."
                            if stale
                            else "최근 급상승 후보이며 작성된 콘텐츠가 없습니다."
                        ),
                        action="refresh_data" if stale else "open_analysis",
                        stale=stale,
                    )

            # 6. Sanitized ad recommendations saved by an explicit account lookup.
            ad_snapshot = session.scalar(
                select(AdPerformanceSnapshot).order_by(
                    AdPerformanceSnapshot.collected_at.desc(),
                    AdPerformanceSnapshot.id.desc(),
                )
            )
            if ad_snapshot is not None:
                stale_snapshot = _is_stale(ad_snapshot.collected_at, now)
                rows = (
                    ad_snapshot.payload.get("recommendations", [])
                    if isinstance(ad_snapshot.payload, dict)
                    else []
                )
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    keyword_text = str(row.get("keyword") or "").strip()
                    if (
                        not keyword_text
                        or row.get("content_state") not in {"missing", "stale"}
                    ):
                        continue
                    add(
                        priority=6,
                        source_type="ad_performance",
                        source_id=ad_snapshot.id,
                        keyword=keyword_text,
                        title=keyword_text,
                        reason=(
                            "광고 성과 근거가 오래되어 먼저 다시 조회해야 합니다."
                            if stale_snapshot
                            else str(
                                row.get("reason")
                                or "성과가 높은 광고 키워드의 콘텐츠 공백입니다."
                            )
                        ),
                        action="refresh_data" if stale_snapshot else "open_analysis",
                        stale=stale_snapshot,
                    )

        recommendations.sort(
            key=lambda row: (row["priority"], row["source_id"], row["keyword"])
        )
        return {
            "items": recommendations[:limit],
            "calculated_at": calculated_at,
            "limit": limit,
        }
