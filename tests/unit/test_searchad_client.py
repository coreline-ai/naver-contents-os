import json

import httpx
import pytest

from app.errors import SchemaError
from providers.gateway import ProviderPolicy
from providers.searchad.client import NaverSearchAdClient
from providers.searchad.signature import build_signature

BODY = {
    "keywordList": [
        {
            "relKeyword": "애드포스트",
            "monthlyPcQcCnt": 1200,
            "monthlyMobileQcCnt": 6800,
            "compIdx": "낮음",
            "plAvgDepth": 15,
        },
        {
            "relKeyword": "애드포스트 승인",
            "monthlyPcQcCnt": "< 10",
            "monthlyMobileQcCnt": "< 10",
            "compIdx": "낮음",
        },
    ]
}


def make_client(recorder: list[httpx.Request]):
    from tests.conftest import make_gateway

    def handler(request: httpx.Request) -> httpx.Response:
        recorder.append(request)
        return httpx.Response(200, text=json.dumps(BODY, ensure_ascii=False))

    return NaverSearchAdClient(
        make_gateway(),
        "api-key",
        "secret-key",
        "12345",
        policy=ProviderPolicy("searchad", 1000, max_concurrency=1),
        transport=httpx.MockTransport(handler),
    )


def test_hint_keyword_spaces_are_stripped():
    requests: list[httpx.Request] = []
    client = make_client(requests)
    client.get_related_keywords("애드포스트 승인")
    assert "%EC%8A%B9%EC%9D%B8" in str(requests[0].url.query)  # 승인
    assert "+" not in str(requests[0].url.query) and "%20" not in str(requests[0].url.query)


def test_signature_signs_bare_path_not_query():
    requests: list[httpx.Request] = []
    client = make_client(requests)
    client.get_related_keywords("애드포스트")

    request = requests[0]
    assert request.url.path == "/keywordstool"
    assert "hintKeywords" in str(request.url.query)
    ts = request.headers["X-Timestamp"]
    assert request.headers["X-Signature"] == build_signature(ts, "GET", "/keywordstool", "secret-key")
    assert request.headers["X-API-KEY"] == "api-key"
    assert request.headers["X-Customer"] == "12345"


def test_volume_parsing_and_masking():
    client = make_client([])
    rows = client.get_related_keywords("애드포스트")

    exact = rows[0]
    assert exact.monthly_pc_searches == 1200
    assert exact.monthly_total_searches == 8000
    assert exact.mobile_share == 6800 / 8000
    assert exact.volume_masked is False
    assert exact.ad_competition == "낮음"

    masked = rows[1]
    assert masked.monthly_pc_searches is None
    assert masked.monthly_total_searches is None  # masked stays missing, never zero
    assert masked.volume_masked is True


def test_cache_hit_preserves_original_collection_time():
    requests: list[httpx.Request] = []
    client = make_client(requests)
    first = client.get_related_keywords("애드포스트")
    second = client.get_related_keywords("애드포스트")
    assert len(requests) == 1
    assert first[0].from_cache is False and second[0].from_cache is True
    assert first[0].collected_at == second[0].collected_at


def test_invalid_keyword_list_schema_is_mapped():
    from tests.conftest import make_gateway

    client = NaverSearchAdClient(
        make_gateway(),
        "api-key",
        "secret-key",
        "12345",
        policy=ProviderPolicy("searchad_invalid", 1000),
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json={"keywordList": "not-a-list"})
        ),
    )
    with pytest.raises(SchemaError):
        client.get_related_keywords("애드포스트")


def test_read_only_estimate_and_account_endpoints_sign_bare_uri():
    from tests.conftest import make_gateway

    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/ncc/campaigns":
            return httpx.Response(200, json=[{"nccCampaignId": "cmp-1"}])
        if request.url.path == "/ncc/adgroups":
            return httpx.Response(200, json=[{"nccAdgroupId": "grp-1"}])
        if request.url.path == "/ncc/keywords":
            return httpx.Response(200, json=[{"nccKeywordId": "kw-1", "keyword": "러닝화"}])
        if request.url.path == "/stats":
            return httpx.Response(200, json={"data": [{"id": "kw-1", "clkCnt": 3}]})
        return httpx.Response(200, json={"items": [{"keyword": "러닝화", "bid": 700}]})

    client = NaverSearchAdClient(
        make_gateway(), "api-key", "secret-key", "12345",
        policy=ProviderPolicy("searchad_read_only", 1000),
        transport=httpx.MockTransport(handler),
    )
    assert client.estimate_median_bid(["러닝화"])["items"][0]["bid"] == 700
    assert client.list_campaigns()[0]["nccCampaignId"] == "cmp-1"
    assert client.list_adgroups()[0]["nccAdgroupId"] == "grp-1"
    assert client.list_keywords("grp-1")[0]["nccKeywordId"] == "kw-1"
    assert client.get_stats(["kw-1"], "2026-08-01", "2026-08-31")[0]["clkCnt"] == 3
    for request in requests:
        signature = request.headers["X-Signature"]
        timestamp = request.headers["X-Timestamp"]
        assert signature == build_signature(timestamp, request.method, request.url.path, "secret-key")


def test_searchad_client_has_no_account_mutation_transport_calls():
    source = __import__("pathlib").Path("python/providers/searchad/client.py").read_text(encoding="utf-8")
    assert "self._http.put(" not in source
    assert "self._http.delete(" not in source
    assert '"POST", "/ncc/' not in source
