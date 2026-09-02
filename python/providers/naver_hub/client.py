"""NAVER API HUB clients (Search + Search Trend).

Verified 2026-09-01: search endpoints return JSON bodies with a text/plain
content-type, so parsing must never trust the header (docs/10).
"""

from __future__ import annotations

import datetime as dt
import json

import httpx
from pydantic import ValidationError

from providers.gateway import Gateway, GatewayResult, ProviderPolicy, cache_key
from providers.models import (
    ImageSearchItem,
    LocalSearchItem,
    SearchChannelResult,
    SearchItem,
    SearchLandscape,
    TrendPoint,
    TrendSeries,
)

BASE_URL = "https://naverapihub.apigw.ntruss.com"
HUB_SEARCH_TTL = 6 * 3600
HUB_TREND_TTL = 24 * 3600
HUB_DAILY_TREND_TTL = 6 * 3600
HUB_NEWS_LATEST_TTL = 15 * 60
HUB_PREFLIGHT_TTL = 24 * 3600

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


def _load_object(gateway: Gateway, policy: ProviderPolicy, body: str) -> dict:
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, TypeError) as exc:
        raise gateway.invalid_schema(policy, "upstream returned invalid JSON") from exc
    if not isinstance(data, dict):
        raise gateway.invalid_schema(policy, "upstream JSON root must be an object")
    return data


def _date_value(value: dt.date | str | None) -> dt.date | None:
    if value is None:
        return None
    if isinstance(value, dt.date):
        return value
    try:
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("dates must use YYYY-MM-DD") from exc


def _date_range(
    *, months: int, start_date: dt.date | str | None, end_date: dt.date | str | None
) -> tuple[str, str]:
    explicit_start = _date_value(start_date)
    explicit_end = _date_value(end_date)
    if (explicit_start is None) != (explicit_end is None):
        raise ValueError("start_date and end_date must be provided together")
    if explicit_start is not None and explicit_end is not None:
        if explicit_start > explicit_end:
            raise ValueError("start_date must not be after end_date")
        return explicit_start.isoformat(), explicit_end.isoformat()
    today = dt.date.today()
    return (today - dt.timedelta(days=months * 30)).strftime("%Y-%m-01"), today.isoformat()


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

    def usage_status(self) -> dict:
        return self._gateway.usage_status(self._policy)

    def _get_object(
        self,
        path: str,
        params: dict,
        *,
        ttl_seconds: int = HUB_SEARCH_TTL,
        force_refresh: bool = False,
    ) -> tuple[dict, GatewayResult]:
        key = cache_key("naver_hub_search", "GET", path, params, None)
        result = self._gateway.request(
            policy=self._policy,
            key=key,
            ttl_seconds=ttl_seconds,
            send=lambda: self._http.get(path, params=params),
            force_refresh=force_refresh,
        )
        return _load_object(self._gateway, self._policy, result.body), result

    def search(
        self,
        channel: str,
        query: str,
        *,
        display: int = 10,
        start: int = 1,
        sort: str = "sim",
        force_refresh: bool = False,
    ) -> SearchChannelResult:
        path = CHANNEL_PATHS[channel]
        params = {"query": query, "display": display, "start": start, "sort": sort}
        data, result = self._get_object(path, params, force_refresh=force_refresh)
        if not isinstance(data.get("items", []), list):
            raise self._gateway.invalid_schema(self._policy, "search.items must be a list")
        try:
            return SearchChannelResult(
                channel=channel,
                total=data.get("total"),
                items=_parse_items(data.get("items", [])),
                collected_at=result.collected_at,
                from_cache=result.from_cache,
            )
        except (ValidationError, TypeError, ValueError) as exc:
            raise self._gateway.invalid_schema(self._policy, "invalid search response schema") from exc

    def search_news_latest(
        self, query: str, *, display: int = 100, force_refresh: bool = False
    ) -> dict:
        if not 1 <= display <= 100:
            raise ValueError("news display must be between 1 and 100")
        data, result = self._get_object(
            "/search/v1/news",
            {"query": query, "display": display, "start": 1, "sort": "date"},
            ttl_seconds=HUB_NEWS_LATEST_TTL,
            force_refresh=force_refresh,
        )
        rows = data.get("items", [])
        if not isinstance(rows, list):
            raise self._gateway.invalid_schema(self._policy, "news.items must be a list")
        items = []
        for row in rows:
            if not isinstance(row, dict):
                raise self._gateway.invalid_schema(self._policy, "news item must be an object")
            items.append(
                {
                    "title": str(row.get("title", "")),
                    "link": str(row.get("link", "")),
                    "original_link": str(row.get("originallink", "")),
                    "description": str(row.get("description", "")),
                    "published_at": str(row.get("pubDate", "")),
                }
            )
        return {
            "items": items,
            "total": data.get("total"),
            "display": display,
            "collected_at": result.collected_at.isoformat(),
            "from_cache": result.from_cache,
        }

    def landscape(self, keyword: str, *, force_refresh: bool = False) -> SearchLandscape:
        """5-channel competition landscape for one keyword."""
        results = {ch: self.search(ch, keyword, force_refresh=force_refresh) for ch in CHANNEL_PATHS}
        return SearchLandscape(
            keyword=keyword,
            collected_at=min(r.collected_at for r in results.values()),
            from_cache=all(r.from_cache for r in results.values()),
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

    def get_errata(self, query: str, *, force_refresh: bool = False) -> dict:
        data, result = self._get_object(
            "/search/v1/errata",
            {"query": query},
            ttl_seconds=HUB_PREFLIGHT_TTL,
            force_refresh=force_refresh,
        )
        value = data.get("errata", "")
        if not isinstance(value, str):
            raise self._gateway.invalid_schema(self._policy, "errata must be a string")
        return {
            "value": value.strip(),
            "collected_at": result.collected_at.isoformat(),
            "from_cache": result.from_cache,
        }

    def is_adult(self, query: str, *, force_refresh: bool = False) -> dict:
        data, result = self._get_object(
            "/search/v1/adult",
            {"query": query},
            ttl_seconds=HUB_PREFLIGHT_TTL,
            force_refresh=force_refresh,
        )
        value = str(data.get("adult", ""))
        if value not in {"0", "1"}:
            raise self._gateway.invalid_schema(self._policy, "adult must be '0' or '1'")
        return {
            "value": value == "1",
            "collected_at": result.collected_at.isoformat(),
            "from_cache": result.from_cache,
        }

    def search_local(
        self, query: str, *, display: int = 5, force_refresh: bool = False
    ) -> dict:
        if not 1 <= display <= 5:
            raise ValueError("local display must be between 1 and 5")
        data, result = self._get_object(
            "/search/v1/local",
            {"query": query, "display": display, "start": 1, "sort": "comment"},
            force_refresh=force_refresh,
        )
        rows = data.get("items", [])
        if not isinstance(rows, list):
            raise self._gateway.invalid_schema(self._policy, "local.items must be a list")
        try:
            items = [
                LocalSearchItem(
                    title=row.get("title", ""),
                    link=row.get("link", ""),
                    category=row.get("category", ""),
                    description=row.get("description", ""),
                    address=row.get("address", ""),
                    road_address=row.get("roadAddress", ""),
                    mapx=str(row.get("mapx", "")),
                    mapy=str(row.get("mapy", "")),
                )
                for row in rows
                if isinstance(row, dict)
            ]
        except ValidationError as exc:
            raise self._gateway.invalid_schema(self._policy, "invalid local item") from exc
        return {
            "items": [item.model_dump(mode="json") for item in items],
            "total": data.get("total"),
            "collected_at": result.collected_at.isoformat(),
            "from_cache": result.from_cache,
        }

    def search_images(
        self, query: str, *, display: int = 10, force_refresh: bool = False
    ) -> dict:
        if not 1 <= display <= 100:
            raise ValueError("image display must be between 1 and 100")
        data, result = self._get_object(
            "/search/v1/image",
            {"query": query, "display": display, "start": 1, "sort": "sim", "filter": "all"},
            force_refresh=force_refresh,
        )
        rows = data.get("items", [])
        if not isinstance(rows, list):
            raise self._gateway.invalid_schema(self._policy, "image.items must be a list")

        def dimension(value) -> int | None:
            try:
                parsed = int(str(value))
                return parsed if parsed >= 0 else None
            except (TypeError, ValueError):
                return None

        items = [
            ImageSearchItem(
                title=row.get("title", ""),
                link=row.get("link", ""),
                thumbnail=row.get("thumbnail", ""),
                width=dimension(row.get("sizewidth")),
                height=dimension(row.get("sizeheight")),
            )
            for row in rows
            if isinstance(row, dict)
        ]
        return {
            "items": [item.model_dump(mode="json") for item in items],
            "total": data.get("total"),
            "collected_at": result.collected_at.isoformat(),
            "from_cache": result.from_cache,
        }


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

    def usage_status(self) -> dict:
        return self._gateway.usage_status(self._policy)

    def get_search_trends(
        self,
        keyword_groups: list[tuple[str, list[str]]],
        *,
        months: int = 12,
        time_unit: str = "month",
        start_date: dt.date | str | None = None,
        end_date: dt.date | str | None = None,
        device: str = "",
        gender: str = "",
        ages: list[str] | None = None,
        force_refresh: bool = False,
    ) -> list[TrendSeries]:
        if not 1 <= len(keyword_groups) <= 5:
            raise ValueError("keyword groups must contain 1 to 5 groups")
        if any(not keywords or len(keywords) > 20 for _, keywords in keyword_groups):
            raise ValueError("each keyword group must contain 1 to 20 keywords")
        if time_unit not in {"date", "week", "month"}:
            raise ValueError("invalid trend time unit")
        if device not in {"", "pc", "mo"} or gender not in {"", "m", "f"}:
            raise ValueError("invalid trend segment")
        age_values = ages or []
        valid_ages = {str(value) for value in range(1, 12)}
        if any(age not in valid_ages for age in age_values):
            raise ValueError("invalid trend age")
        start_value, end_value = _date_range(
            months=months, start_date=start_date, end_date=end_date
        )
        payload: dict = {
            "startDate": start_value,
            "endDate": end_value,
            "timeUnit": time_unit,
            "keywordGroups": [
                {"groupName": name, "keywords": keywords} for name, keywords in keyword_groups
            ],
        }
        if device:
            payload["device"] = device
        if gender:
            payload["gender"] = gender
        if age_values:
            payload["ages"] = age_values
        key = cache_key("naver_hub_trend", "POST", "/search-trend/v1/search", None, payload)
        result = self._gateway.request(
            policy=self._policy,
            key=key,
            ttl_seconds=HUB_DAILY_TREND_TTL if time_unit == "date" else HUB_TREND_TTL,
            send=lambda: self._http.post("/search-trend/v1/search", json=payload),
            force_refresh=force_refresh,
        )
        data = _load_object(self._gateway, self._policy, result.body)
        results = data.get("results", [])
        if not isinstance(results, list):
            raise self._gateway.invalid_schema(self._policy, "trend.results must be a list")
        series: list[TrendSeries] = []
        try:
            for index, raw in enumerate(results):
                if not isinstance(raw, dict) or not isinstance(raw.get("data", []), list):
                    raise TypeError("invalid trend result")
                fallback_name, fallback_keywords = keyword_groups[min(index, len(keyword_groups) - 1)]
                series.append(
                    TrendSeries(
                        keyword_group=str(raw.get("title") or fallback_name),
                        keywords=[str(value) for value in raw.get("keywords", fallback_keywords)],
                        time_unit=time_unit,
                        points=[
                            TrendPoint(period=point.get("period", ""), ratio=float(point["ratio"]))
                            for point in raw.get("data", [])
                            if isinstance(point, dict)
                        ],
                        device=device,
                        gender=gender,
                        ages=age_values,
                        collected_at=result.collected_at,
                        from_cache=result.from_cache,
                    )
                )
        except (ValidationError, KeyError, TypeError, ValueError) as exc:
            raise self._gateway.invalid_schema(self._policy, "invalid trend response schema") from exc
        for index in range(len(series), len(keyword_groups)):
            name, keywords = keyword_groups[index]
            series.append(
                TrendSeries(
                    keyword_group=name,
                    keywords=keywords,
                    time_unit=time_unit,
                    points=[],
                    device=device,
                    gender=gender,
                    ages=age_values,
                    collected_at=result.collected_at,
                    from_cache=result.from_cache,
                )
            )
        return series

    def get_search_trend(
        self,
        keyword: str,
        *,
        months: int = 12,
        time_unit: str = "month",
        start_date: dt.date | str | None = None,
        end_date: dt.date | str | None = None,
        force_refresh: bool = False,
    ) -> TrendSeries:
        rows = self.get_search_trends(
            [(keyword, [keyword])],
            months=months,
            time_unit=time_unit,
            start_date=start_date,
            end_date=end_date,
            force_refresh=force_refresh,
        )
        return rows[0]


class NaverHubShoppingClient:
    def __init__(
        self,
        gateway: Gateway,
        client_id: str,
        client_secret: str,
        *,
        shopping_policy: ProviderPolicy,
        transport: httpx.BaseTransport | None = None,
    ):
        self._gateway = gateway
        self._policy = shopping_policy
        self._http = httpx.Client(
            base_url=BASE_URL,
            headers={"X-NCP-APIGW-API-KEY-ID": client_id, "X-NCP-APIGW-API-KEY": client_secret},
            timeout=15,
            transport=transport,
        )

    def usage_status(self) -> dict:
        return self._gateway.usage_status(self._policy)

    def get_keyword_trends(
        self,
        category: str,
        keywords: list[str],
        *,
        months: int = 12,
        time_unit: str = "month",
        start_date: dt.date | str | None = None,
        end_date: dt.date | str | None = None,
        force_refresh: bool = False,
    ) -> list[dict]:
        cleaned = [keyword.strip() for keyword in keywords if keyword.strip()][:5]
        if not category.strip() or not cleaned:
            raise ValueError("shopping category and keywords are required")
        start_value, end_value = _date_range(
            months=months, start_date=start_date, end_date=end_date
        )
        payload = {
            "startDate": start_value,
            "endDate": end_value,
            "timeUnit": time_unit,
            "category": category.strip(),
            "keyword": [{"name": keyword, "param": [keyword]} for keyword in cleaned],
        }
        uri = "/shopping/v1/category/keywords"
        key = cache_key("naver_hub_shopping", "POST", uri, None, payload)
        result = self._gateway.request(
            policy=self._policy,
            key=key,
            ttl_seconds=HUB_DAILY_TREND_TTL if time_unit == "date" else HUB_TREND_TTL,
            send=lambda: self._http.post(uri, json=payload),
            force_refresh=force_refresh,
        )
        data = _load_object(self._gateway, self._policy, result.body)
        rows = data.get("results", [])
        if not isinstance(rows, list):
            raise self._gateway.invalid_schema(self._policy, "shopping results must be a list")
        return [
            {
                "title": str(row.get("title", "")),
                "keyword": list(row.get("keyword", [])) if isinstance(row.get("keyword", []), list) else [],
                "points": [
                    {"period": str(point.get("period", "")), "ratio": float(point.get("ratio", 0))}
                    for point in row.get("data", [])
                    if isinstance(point, dict)
                ],
                "collected_at": result.collected_at.isoformat(),
                "from_cache": result.from_cache,
            }
            for row in rows
            if isinstance(row, dict)
        ]
