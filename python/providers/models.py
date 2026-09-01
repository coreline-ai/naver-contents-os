"""Normalized provider contracts (docs/12).

Every model carries source / collected_at / raw_schema_version so UI and scoring
never confuse a SearchAd volume, a Hub total, and a derived score.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum

from pydantic import BaseModel, Field

RAW_SCHEMA_VERSION = "2026-09-01"


class DataSource(StrEnum):
    SEARCH_AD = "SEARCH_AD"
    NAVER_API_HUB = "NAVER_API_HUB"
    BROWSER_DOM = "BROWSER_DOM"
    DERIVED = "DERIVED"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class SourcedModel(BaseModel):
    source: DataSource
    collected_at: datetime = Field(default_factory=now_utc)
    from_cache: bool = False
    raw_schema_version: str = RAW_SCHEMA_VERSION


class KeywordMetric(SourcedModel):
    """One row of SearchAd /keywordstool. Volumes are search-ad counts, never blog traffic."""

    source: DataSource = DataSource.SEARCH_AD
    keyword: str
    monthly_pc_searches: int | None = None
    monthly_mobile_searches: int | None = None
    volume_masked: bool = False  # SearchAd reports "< 10" for tiny volumes
    ad_competition: str | None = None  # compIdx: 낮음/중간/높음
    ad_click_metrics: dict = Field(default_factory=dict)

    @property
    def monthly_total_searches(self) -> int | None:
        if self.monthly_pc_searches is None and self.monthly_mobile_searches is None:
            return None
        return (self.monthly_pc_searches or 0) + (self.monthly_mobile_searches or 0)

    @property
    def mobile_share(self) -> float | None:
        total = self.monthly_total_searches
        if not total:
            return None
        return (self.monthly_mobile_searches or 0) / total


class SearchItem(BaseModel):
    title: str
    link: str = ""
    description: str = ""
    author: str = ""
    posted_at: str = ""  # raw postdate/pubDate string; channels differ


class SearchChannelResult(BaseModel):
    channel: str  # blog | cafe | kin | web | news
    total: int | None = None
    items: list[SearchItem] = Field(default_factory=list)
    collected_at: datetime = Field(default_factory=now_utc)
    from_cache: bool = False


class SearchLandscape(SourcedModel):
    source: DataSource = DataSource.NAVER_API_HUB
    keyword: str
    blog_total: int | None = None
    cafe_total: int | None = None
    kin_total: int | None = None
    web_total: int | None = None
    news_total: int | None = None
    top_results: list[SearchItem] = Field(default_factory=list)  # blog top results
    kin_items: list[SearchItem] = Field(default_factory=list)
    cafe_items: list[SearchItem] = Field(default_factory=list)
    news_items: list[SearchItem] = Field(default_factory=list)


class TrendPoint(BaseModel):
    period: str  # e.g. "2026-08-01"
    ratio: float  # relative to max=100 within this request window only


class TrendSeries(SourcedModel):
    source: DataSource = DataSource.NAVER_API_HUB
    keyword_group: str
    keywords: list[str]
    time_unit: str = "month"
    points: list[TrendPoint] = Field(default_factory=list)
    device: str = ""
    gender: str = ""
    ages: list[str] = Field(default_factory=list)


class SerpResult(BaseModel):
    rank: int
    result_type: str = ""  # blog | cafe | news | ad | etc
    title: str = ""
    url: str = ""
    blog_id: str = ""
    description: str = ""
    posted_at: str = ""
    is_ad: bool = False


class SerpObservation(SourcedModel):
    """Parsed from the user's live SERP by the extension content script."""

    source: DataSource = DataSource.BROWSER_DOM
    query: str
    results: list[SerpResult] = Field(default_factory=list)
