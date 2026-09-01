"""Keyword analysis orchestration: collect from providers, persist a snapshot,
return normalized blocks with an explicit per-source status.

A missing provider (unconfigured .env) or an upstream failure degrades that block
to null with a status code — it never turns into a fake zero or a crash (docs/03, docs/12).
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.errors import CoreError
from app.logging import get_logger
from app.models_db import Keyword, KeywordSnapshot, SerpSnapshot
from intelligence.cluster import cluster_keywords
from intelligence.keyword.models import compact, normalize_keyword
from intelligence.questions import extract_candidates
from intelligence.scoring import OpportunityScorer
from planner.series import build_content_plan
from providers.models import KeywordMetric, SearchLandscape, SerpObservation, TrendSeries
from providers.naver_hub.client import NaverHubSearchClient, NaverHubTrendClient
from providers.searchad.client import NaverSearchAdClient

log = get_logger("analyze")

RELATED_KEYWORDS_CAP = 50


def _same_keyword(a: str, b: str) -> bool:
    return compact(a) == compact(b)


class AnalyzeService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        searchad: NaverSearchAdClient | None,
        hub_search: NaverHubSearchClient | None,
        hub_trend: NaverHubTrendClient | None,
    ):
        self._sessions = session_factory
        self._searchad = searchad
        self._hub_search = hub_search
        self._hub_trend = hub_trend
        self._scorer = OpportunityScorer()

    def analyze(
        self, keyword: str, *, force_refresh: bool = False, serp: SerpObservation | None = None
    ) -> dict:
        kw = normalize_keyword(keyword)
        data_status: dict[str, str] = {}

        metric, related = self._collect_searchad(kw, force_refresh, data_status)
        landscape = self._collect_landscape(kw, force_refresh, data_status)
        trend = self._collect_trend(kw, force_refresh, data_status)

        score = self._scorer.score(kw, metric, landscape, trend, serp)
        questions = extract_candidates(landscape)
        clusters = cluster_keywords(related[:RELATED_KEYWORDS_CAP])
        plan = build_content_plan(kw, metric, related[:RELATED_KEYWORDS_CAP], landscape, trend, questions)

        snapshot_id, collected_at = self._persist(kw, metric, related, landscape, trend, serp, score)

        return {
            "keyword": kw,
            "snapshot_id": snapshot_id,
            "collected_at": collected_at,
            "data_status": data_status,
            "metric": metric.model_dump(mode="json") if metric else None,
            "related_keywords": [m.model_dump(mode="json") for m in related[:RELATED_KEYWORDS_CAP]],
            "landscape": landscape.model_dump(mode="json") if landscape else None,
            "trend": trend.model_dump(mode="json") if trend else None,
            "serp": serp.model_dump(mode="json") if serp else None,
            "score": score,
            "questions": questions,
            "clusters": clusters,
            "plan": plan,
        }

    def _collect_searchad(
        self, kw: str, force_refresh: bool, data_status: dict
    ) -> tuple[KeywordMetric | None, list[KeywordMetric]]:
        if self._searchad is None:
            data_status["searchad"] = "unconfigured"
            return None, []
        try:
            rows = self._searchad.get_related_keywords(kw, force_refresh=force_refresh)
        except CoreError as exc:
            data_status["searchad"] = exc.code
            log.warning("searchad_failed", code=exc.code)
            return None, []
        data_status["searchad"] = "ok"
        metric = next((r for r in rows if _same_keyword(r.keyword, kw)), None)
        return metric, rows

    def _collect_landscape(
        self, kw: str, force_refresh: bool, data_status: dict
    ) -> SearchLandscape | None:
        if self._hub_search is None:
            data_status["hub_search"] = "unconfigured"
            return None
        try:
            landscape = self._hub_search.landscape(kw, force_refresh=force_refresh)
        except CoreError as exc:
            data_status["hub_search"] = exc.code
            log.warning("hub_search_failed", code=exc.code)
            return None
        data_status["hub_search"] = "ok"
        return landscape

    def _collect_trend(self, kw: str, force_refresh: bool, data_status: dict) -> TrendSeries | None:
        if self._hub_trend is None:
            data_status["hub_trend"] = "unconfigured"
            return None
        try:
            trend = self._hub_trend.get_search_trend(kw, force_refresh=force_refresh)
        except CoreError as exc:
            data_status["hub_trend"] = exc.code
            log.warning("hub_trend_failed", code=exc.code)
            return None
        data_status["hub_trend"] = "ok"
        return trend

    def _persist(
        self,
        kw: str,
        metric: KeywordMetric | None,
        related: list[KeywordMetric],
        landscape: SearchLandscape | None,
        trend: TrendSeries | None,
        serp: SerpObservation | None,
        score: dict | None = None,
    ) -> tuple[int, str]:
        payload = {
            "metric": metric.model_dump(mode="json") if metric else None,
            "related_keywords": [m.model_dump(mode="json") for m in related[:RELATED_KEYWORDS_CAP]],
            "landscape": landscape.model_dump(mode="json") if landscape else None,
            "trend": trend.model_dump(mode="json") if trend else None,
        }
        with self._sessions() as session:
            row = session.scalar(select(Keyword).where(Keyword.text == kw))
            if row is None:
                row = Keyword(text=kw)
                session.add(row)
                session.flush()
            snapshot = KeywordSnapshot(
                keyword_id=row.id,
                payload=payload,
                score=score,
                score_version=score.get("score_version") if score else None,
            )
            session.add(snapshot)
            if serp is not None:
                session.add(SerpSnapshot(keyword_id=row.id, payload=serp.model_dump(mode="json")))
            session.commit()
            return snapshot.id, snapshot.collected_at.isoformat()
