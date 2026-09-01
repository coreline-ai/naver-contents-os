"""SearchAd keyword tool client. The only source of real PC/mobile monthly volumes."""

from __future__ import annotations

import json

import httpx

from providers.gateway import Gateway, ProviderPolicy, cache_key
from providers.models import KeywordMetric, now_utc
from providers.searchad.signature import auth_headers

BASE_URL = "https://api.searchad.naver.com"
KEYWORDSTOOL_URI = "/keywordstool"
SEARCHAD_TTL = 24 * 3600

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

    def get_related_keywords(self, hint_keyword: str, *, force_refresh: bool = False) -> list[KeywordMetric]:
        # keywordstool rejects hints containing spaces; relKeyword rows come back space-less too.
        params = {"hintKeywords": hint_keyword.replace(" ", ""), "showDetail": 1}
        key = cache_key("searchad", "GET", KEYWORDSTOOL_URI, params, None)

        def send() -> httpx.Response:
            headers = auth_headers(
                "GET", KEYWORDSTOOL_URI, self._api_key, self._secret_key, self._customer_id
            )
            return self._http.get(KEYWORDSTOOL_URI, params=params, headers=headers)

        body, _ = self._gateway.request(
            policy=self._policy, key=key, ttl_seconds=SEARCHAD_TTL, send=send, force_refresh=force_refresh
        )
        data = json.loads(body)
        collected = now_utc()
        metrics = []
        for row in data.get("keywordList", []):
            pc, pc_masked = _parse_volume(row.get("monthlyPcQcCnt"))
            mobile, mobile_masked = _parse_volume(row.get("monthlyMobileQcCnt"))
            metrics.append(
                KeywordMetric(
                    keyword=row.get("relKeyword", ""),
                    monthly_pc_searches=pc,
                    monthly_mobile_searches=mobile,
                    volume_masked=pc_masked or mobile_masked,
                    ad_competition=row.get("compIdx"),
                    ad_click_metrics={f: row.get(f) for f in _CLICK_FIELDS if row.get(f) is not None},
                    collected_at=collected,
                )
            )
        return metrics
