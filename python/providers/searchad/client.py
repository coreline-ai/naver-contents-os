"""Read-only SearchAd client.

POST is used only for official estimate calculators. Campaign/adgroup/keyword
management mutation endpoints are intentionally not implemented.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from pydantic import ValidationError

from providers.gateway import Gateway, ProviderPolicy, cache_key
from providers.models import KeywordMetric
from providers.searchad.signature import auth_headers

BASE_URL = "https://api.searchad.naver.com"
KEYWORDSTOOL_URI = "/keywordstool"
SEARCHAD_TTL = 24 * 3600
SEARCHAD_ACCOUNT_TTL = 15 * 60

READ_ONLY_GET_URIS = frozenset(
    {
        KEYWORDSTOOL_URI,
        "/ncc/campaigns",
        "/ncc/adgroups",
        "/ncc/keywords",
        "/stats",
    }
)
READ_ONLY_POST_URIS = frozenset(
    {
        "/estimate/average-position-bid/keyword",
        "/estimate/exposure-minimum-bid/keyword",
        "/estimate/median-bid/keyword",
        "/estimate/performance/keyword",
        "/estimate/performance-bulk",
    }
)

_CLICK_FIELDS = (
    "monthlyAvePcClkCnt",
    "monthlyAveMobileClkCnt",
    "monthlyAvePcCtr",
    "monthlyAveMobileCtr",
    "plAvgDepth",
)


def _parse_volume(value) -> tuple[int | None, bool]:
    """SearchAd masks tiny volumes as the string '< 10'. Keep masked as missing, not zero."""
    if value is None:
        return None, False
    if isinstance(value, int):
        return value, False
    text = str(value).strip()
    if text.startswith("<"):
        return None, True
    try:
        return int(text), False
    except ValueError:
        return None, False


class NaverSearchAdClient:
    def __init__(
        self,
        gateway: Gateway,
        api_key: str,
        secret_key: str,
        customer_id: str,
        *,
        policy: ProviderPolicy,
        transport: httpx.BaseTransport | None = None,
    ):
        self._gateway = gateway
        self._policy = policy
        self._api_key = api_key
        self._secret_key = secret_key
        self._customer_id = customer_id
        self._http = httpx.Client(base_url=BASE_URL, timeout=15, transport=transport)

    def usage_status(self) -> dict:
        return self._gateway.usage_status(self._policy)

    def _request_json(
        self,
        method: str,
        uri: str,
        *,
        params: dict | None = None,
        body: dict | list | None = None,
        ttl_seconds: int = SEARCHAD_TTL,
        force_refresh: bool = False,
        with_meta: bool = False,
    ) -> Any:
        normalized_method = method.upper()
        allowed = (
            uri in READ_ONLY_GET_URIS
            if normalized_method == "GET"
            else uri in READ_ONLY_POST_URIS if normalized_method == "POST" else False
        )
        if not allowed:
            raise ValueError(f"SearchAd URI is not in the read-only allowlist: {normalized_method} {uri}")
        key = cache_key("searchad", normalized_method, uri, params, body if isinstance(body, dict) else {"items": body} if body else None)

        def send() -> httpx.Response:
            headers = auth_headers(
                normalized_method, uri, self._api_key, self._secret_key, self._customer_id
            )
            if normalized_method == "GET":
                return self._http.get(uri, params=params, headers=headers)
            return self._http.post(uri, params=params, json=body, headers=headers)

        result = self._gateway.request(
            policy=self._policy,
            key=key,
            ttl_seconds=ttl_seconds,
            send=send,
            force_refresh=force_refresh,
        )
        try:
            data = json.loads(result.body)
        except (json.JSONDecodeError, TypeError) as exc:
            raise self._gateway.invalid_schema(self._policy, "upstream returned invalid JSON") from exc
        return (data, result) if with_meta else data

    def get_related_keywords(self, hint_keyword: str, *, force_refresh: bool = False) -> list[KeywordMetric]:
        # keywordstool rejects hints containing spaces; relKeyword rows come back space-less too.
        params = {"hintKeywords": hint_keyword.replace(" ", ""), "showDetail": 1}
        data, result = self._request_json(
            "GET", KEYWORDSTOOL_URI, params=params, force_refresh=force_refresh, with_meta=True
        )
        if not isinstance(data, dict) or not isinstance(data.get("keywordList", []), list):
            raise self._gateway.invalid_schema(self._policy, "keywordList must be a list")
        collected = result.collected_at
        metrics = []
        for row in data.get("keywordList", []):
            if not isinstance(row, dict):
                raise self._gateway.invalid_schema(self._policy, "keywordList row must be an object")
            pc, pc_masked = _parse_volume(row.get("monthlyPcQcCnt"))
            mobile, mobile_masked = _parse_volume(row.get("monthlyMobileQcCnt"))
            try:
                metrics.append(
                    KeywordMetric(
                        keyword=row.get("relKeyword", ""),
                        monthly_pc_searches=pc,
                        monthly_mobile_searches=mobile,
                        volume_masked=pc_masked or mobile_masked,
                        ad_competition=row.get("compIdx"),
                        ad_click_metrics={f: row.get(f) for f in _CLICK_FIELDS if row.get(f) is not None},
                        collected_at=collected,
                        from_cache=result.from_cache,
                    )
                )
            except ValidationError as exc:
                raise self._gateway.invalid_schema(self._policy, "invalid keywordList row schema") from exc
        return metrics

    def estimate_average_position_bid(
        self,
        keywords: list[str],
        *,
        device: str = "PC",
        position: int = 1,
        force_refresh: bool = False,
    ) -> Any:
        items = [{"key": keyword, "position": position} for keyword in keywords[:100]]
        return self._request_json(
            "POST",
            "/estimate/average-position-bid/keyword",
            body={"device": device.upper(), "items": items},
            force_refresh=force_refresh,
        )

    def estimate_exposure_minimum_bid(
        self, keywords: list[str], *, device: str = "PC", force_refresh: bool = False
    ) -> Any:
        return self._request_json(
            "POST",
            "/estimate/exposure-minimum-bid/keyword",
            body={"device": device.upper(), "period": "MONTH", "items": keywords[:100]},
            force_refresh=force_refresh,
        )

    def estimate_median_bid(
        self, keywords: list[str], *, device: str = "PC", force_refresh: bool = False
    ) -> Any:
        return self._request_json(
            "POST",
            "/estimate/median-bid/keyword",
            body={"device": device.upper(), "period": "MONTH", "items": keywords[:100]},
            force_refresh=force_refresh,
        )

    def estimate_performance_bulk(
        self,
        items: list[dict],
        *,
        force_refresh: bool = False,
    ) -> Any:
        normalized = [
            {
                "device": str(item.get("device", "PC")).upper(),
                "keywordplus": bool(item.get("keywordplus", True)),
                "keyword": str(item.get("keyword", "")),
                "bid": max(0, int(item.get("bid", 0))),
            }
            for item in items[:100]
            if str(item.get("keyword", "")).strip()
        ]
        return self._request_json(
            "POST",
            "/estimate/performance-bulk",
            body={"items": normalized},
            force_refresh=force_refresh,
        )

    def list_campaigns(self, *, force_refresh: bool = False) -> list[dict]:
        data = self._request_json(
            "GET", "/ncc/campaigns", ttl_seconds=SEARCHAD_ACCOUNT_TTL, force_refresh=force_refresh
        )
        if not isinstance(data, list):
            raise self._gateway.invalid_schema(self._policy, "campaigns must be a list")
        return [row for row in data if isinstance(row, dict)]

    def list_adgroups(self, *, force_refresh: bool = False) -> list[dict]:
        data = self._request_json(
            "GET", "/ncc/adgroups", ttl_seconds=SEARCHAD_ACCOUNT_TTL, force_refresh=force_refresh
        )
        if not isinstance(data, list):
            raise self._gateway.invalid_schema(self._policy, "adgroups must be a list")
        return [row for row in data if isinstance(row, dict)]

    def list_keywords(
        self, adgroup_id: str, *, force_refresh: bool = False
    ) -> list[dict]:
        data = self._request_json(
            "GET",
            "/ncc/keywords",
            params={"nccAdgroupId": adgroup_id},
            ttl_seconds=SEARCHAD_ACCOUNT_TTL,
            force_refresh=force_refresh,
        )
        if not isinstance(data, list):
            raise self._gateway.invalid_schema(self._policy, "keywords must be a list")
        return [row for row in data if isinstance(row, dict)]

    def get_stats(
        self,
        ids: list[str],
        since: str,
        until: str,
        *,
        breakdown: str = "",
        force_refresh: bool = False,
    ) -> list[dict]:
        fields = ["impCnt", "clkCnt", "salesAmt", "ctr", "cpc", "avgRnk", "ccnt", "convAmt", "ror"]
        params = {
            "ids": ids[:100],
            "fields": json.dumps(fields, separators=(",", ":")),
            "timeRange": json.dumps({"since": since, "until": until}, separators=(",", ":")),
            "timeIncrement": "allDays",
        }
        if breakdown:
            params["breakdown"] = breakdown
        data = self._request_json(
            "GET", "/stats", params=params, ttl_seconds=SEARCHAD_ACCOUNT_TTL, force_refresh=force_refresh
        )
        rows = data.get("data", []) if isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise self._gateway.invalid_schema(self._policy, "stats data must be a list")
        return [row for row in rows if isinstance(row, dict)]
