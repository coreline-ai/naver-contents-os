"""Opportunity Score v1 (docs/03 weights).

Explainable by construction: the result carries per-component contributions and an
explicit missing list, and the same snapshot + score_version always reproduces the
same numbers. Components without V1 data (top10 strength, intent) are declared
missing rather than faked; weights renormalize over what is available.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from intelligence.keyword.models import (
    clean_title,
    compact,
    log1p_norm,
    parse_posted_date,
    trend_change,
)
from providers.models import KeywordMetric, SearchItem, SearchLandscape, SerpObservation, TrendSeries

SCORE_VERSION = "v1"

# Fixed reference scales — changing any of these requires a new SCORE_VERSION.
VOLUME_REF_MAX = 100_000
BLOG_DOCS_REF_MAX = 1_000_000
FRESHNESS_OLD_DAYS = 365
MIN_PARSED_DATES = 3

WEIGHTS: dict[str, float] = {
    "volume": 0.25,
    "trend": 0.15,
    "blog_competition": 0.15,
    "top10_strength": 0.15,  # V1: no per-blogger influence data -> missing
    "top10_freshness": 0.10,
    "intent_match": 0.10,  # V1: no intent classifier -> missing
    "exact_title_ratio": 0.05,
    "mobile_share": 0.05,
}


@dataclass
class Component:
    name: str
    weight: float
    normalized: float | None  # 0..1, None = missing
    raw: str = ""

    @property
    def available(self) -> bool:
        return self.normalized is not None


class OpportunityScorer:
    score_version = SCORE_VERSION

    def score(
        self,
        keyword: str,
        metric: KeywordMetric | None,
        landscape: SearchLandscape | None,
        trend: TrendSeries | None,
        serp: SerpObservation | None = None,
        today: date | None = None,
    ) -> dict:
        today = today or date.today()
        top_items = self._top_items(landscape, serp)
        components = [
            self._volume(metric),
            self._trend(trend),
            self._blog_competition(landscape),
            Component("top10_strength", WEIGHTS["top10_strength"], None, "no influence data in V1"),
            self._freshness(top_items, today),
            Component("intent_match", WEIGHTS["intent_match"], None, "no intent classifier in V1"),
            self._exact_title(keyword, top_items),
            self._mobile_share(metric),
        ]

        available = [c for c in components if c.available]
        total_weight = sum(c.weight for c in available)
        value = (
            round(100 * sum(c.weight * c.normalized for c in available) / total_weight, 1)
            if total_weight > 0
            else None
        )
        return {
            "value": value,
            "score_version": self.score_version,
            "contributions": [
                {
                    "component": c.name,
                    "weight": c.weight,
                    "normalized": round(c.normalized, 4) if c.available else None,
                    "points": round(100 * c.weight * c.normalized / total_weight, 1)
                    if c.available and total_weight > 0
                    else None,
                    "status": "ok" if c.available else "missing",
                    "raw": c.raw,
                }
                for c in components
            ],
            "missing": [c.name for c in components if not c.available],
        }

    @staticmethod
    def _top_items(landscape: SearchLandscape | None, serp: SerpObservation | None) -> list[SearchItem]:
        if serp is not None and serp.results:
            return [
                SearchItem(title=r.title, link=r.url, posted_at=r.posted_at)
                for r in serp.results
                if not r.is_ad
            ][:10]
        if landscape is not None:
            return landscape.top_results[:10]
        return []

    @staticmethod
    def _volume(metric: KeywordMetric | None) -> Component:
        weight = WEIGHTS["volume"]
        if metric is None or metric.monthly_total_searches is None:
            raw = "masked (< 10)" if metric is not None and metric.volume_masked else "missing"
            return Component("volume", weight, None, raw)
        total = metric.monthly_total_searches
        return Component("volume", weight, log1p_norm(total, VOLUME_REF_MAX), f"monthly={total}")

    @staticmethod
    def _trend(trend: TrendSeries | None) -> Component:
        weight = WEIGHTS["trend"]
        if trend is None or not trend.points:
            return Component("trend", weight, None, "missing")
        change = trend_change([p.ratio for p in trend.points])
        if change is None:
            return Component("trend", weight, None, "series too short")
        return Component("trend", weight, (change + 1) / 2, f"recent_change={change:+.2f}")

    @staticmethod
    def _blog_competition(landscape: SearchLandscape | None) -> Component:
        weight = WEIGHTS["blog_competition"]
        if landscape is None or landscape.blog_total is None:
            return Component("blog_competition", weight, None, "missing")
        crowding = log1p_norm(landscape.blog_total, BLOG_DOCS_REF_MAX)
        return Component(
            "blog_competition", weight, 1 - (crowding or 0), f"blog_docs={landscape.blog_total}"
        )

    @staticmethod
    def _freshness(items: list[SearchItem], today: date) -> Component:
        weight = WEIGHTS["top10_freshness"]
        dates = [d for d in (parse_posted_date(i.posted_at) for i in items) if d is not None]
        if len(dates) < MIN_PARSED_DATES:
            return Component("top10_freshness", weight, None, f"parsed_dates={len(dates)}")
        old = sum(1 for d in dates if (today - d).days > FRESHNESS_OLD_DAYS)
        share = old / len(dates)
        return Component("top10_freshness", weight, share, f"stale_share={share:.2f} of {len(dates)}")

    @staticmethod
    def _exact_title(keyword: str, items: list[SearchItem]) -> Component:
        weight = WEIGHTS["exact_title_ratio"]
        if not items:
            return Component("exact_title_ratio", weight, None, "no top results")
        target = compact(keyword)
        exact = sum(1 for i in items if target in compact(clean_title(i.title)))
        share = exact / len(items)
        return Component("exact_title_ratio", weight, 1 - share, f"exact_share={share:.2f}")

    @staticmethod
    def _mobile_share(metric: KeywordMetric | None) -> Component:
        weight = WEIGHTS["mobile_share"]
        if metric is None or metric.mobile_share is None:
            return Component("mobile_share", weight, None, "missing")
        return Component("mobile_share", weight, metric.mobile_share, f"mobile={metric.mobile_share:.2f}")
