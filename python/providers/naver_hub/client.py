"""NAVER API HUB clients (Search + Search Trend).

Verified 2026-09-01: search endpoints return JSON bodies with a text/plain
content-type, so parsing must never trust the header (docs/10).
"""

from __future__ import annotations

import datetime as dt
import json

import httpx

from providers.gateway import Gateway, ProviderPolicy, cache_key
from providers.models import (
    SearchChannelResult,
    SearchItem,
    SearchLandscape,
    TrendPoint,
    TrendSeries,
    now_utc,
)

BASE_URL = "https://naverapihub.apigw.ntruss.com"
HUB_SEARCH_TTL = 6 * 3600
HUB_TREND_TTL = 24 * 3600

CHANNEL_PATHS = {
    "blog": "/search/v1/blog",
    "cafe": "/search/v1/cafearticle",
    "kin": "/search/v1/kin",
    "web": "/search/v1/webkr",
    "news": "/search/v1/news",
}

_AUTHOR_FIELDS = ("bloggername", "cafename")
_DATE_FIELDS = ("postdate", "pubDate")


def _parse_items(raw_items: list[dict]) -> list[SearchItem]:
    items = []
    for raw in raw_items:
        author = next((raw[f] for f in _AUTHOR_FIELDS if raw.get(f)), "")
        posted = next((raw[f] for f in _DATE_FIELDS if raw.get(f)), "")
        items.append(
            SearchItem(
                title=raw.get("title", ""),
                link=raw.get("link", ""),
                description=raw.get("description", ""),
                author=author,
                posted_at=posted,
            )
        )
    return items


class NaverHubSearchClient:
    def __init__(
        self,
        gateway: Gateway,
        client_id: str,
        client_secret: str,
        *,
        search_policy: ProviderPolicy,
        transport: httpx.BaseTransport | None = None,
    ):
        self._gateway = gateway
        self._policy = search_policy
        self._http = httpx.Client(
            base_url=BASE_URL,
            headers={"X-NCP-APIGW-API-KEY-ID": client_id, "X-NCP-APIGW-API-KEY": client_secret},
            timeout=15,
            transport=transport,
        )

    def search(
        self, channel: str, query: str, *, display: int = 10, start: int = 1, force_refresh: bool = False
    ) -> SearchChannelResult:
        path = CHANNEL_PATHS[channel]
        params = {"query": query, "display": display, "start": start}
        key = cache_key("naver_hub_search", "GET", path, params, None)
        body, _ = self._gateway.request(
            policy=self._policy,
            key=key,
            ttl_seconds=HUB_SEARCH_TTL,
            send=lambda: self._http.get(path, params=params),
            force_refresh=force_refresh,
        )
        data = json.loads(body)
        return SearchChannelResult(
            channel=channel,
            total=data.get("total"),
            items=_parse_items(data.get("items", [])),
        )

    def landscape(self, keyword: str, *, force_refresh: bool = False) -> SearchLandscape:
        """5-channel competition landscape for one keyword."""
        results = {ch: self.search(ch, keyword, force_refresh=force_refresh) for ch in CHANNEL_PATHS}
        return SearchLandscape(
            keyword=keyword,
            collected_at=now_utc(),
            blog_total=results["blog"].total,
            cafe_total=results["cafe"].total,
            kin_total=results["kin"].total,
            web_total=results["web"].total,
            news_total=results["news"].total,
            top_results=results["blog"].items,
            kin_items=results["kin"].items,
            cafe_items=results["cafe"].items,
            news_items=results["news"].items,
        )


class NaverHubTrendClient:
    def __init__(
        self,
        gateway: Gateway,
        client_id: str,
        client_secret: str,
        *,
        trend_policy: ProviderPolicy,
        transport: httpx.BaseTransport | None = None,
    ):
        self._gateway = gateway
        self._policy = trend_policy
        self._http = httpx.Client(
            base_url=BASE_URL,
            headers={"X-NCP-APIGW-API-KEY-ID": client_id, "X-NCP-APIGW-API-KEY": client_secret},
            timeout=15,
            transport=transport,
        )

    def get_search_trend(
        self,
        keyword: str,
        *,
        months: int = 12,
        time_unit: str = "month",
        force_refresh: bool = False,
    ) -> TrendSeries:
        today = dt.date.today()
        payload = {
            "startDate": (today - dt.timedelta(days=months * 30)).strftime("%Y-%m-01"),
            "endDate": today.strftime("%Y-%m-%d"),
            "timeUnit": time_unit,
            "keywordGroups": [{"groupName": keyword, "keywords": [keyword]}],
        }
        key = cache_key("naver_hub_trend", "POST", "/search-trend/v1/search", None, payload)
        body, _ = self._gateway.request(
            policy=self._policy,
            key=key,
            ttl_seconds=HUB_TREND_TTL,
            send=lambda: self._http.post("/search-trend/v1/search", json=payload),
            force_refresh=force_refresh,
        )
        data = json.loads(body)
        results = data.get("results", [])
        points = [
            TrendPoint(period=p.get("period", ""), ratio=float(p.get("ratio", 0.0)))
            for p in (results[0].get("data", []) if results else [])
        ]
        return TrendSeries(
            keyword_group=keyword,
            keywords=[keyword],
            time_unit=time_unit,
            points=points,
            collected_at=now_utc(),
        )
