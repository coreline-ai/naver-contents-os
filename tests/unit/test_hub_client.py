import json

import httpx

from providers.gateway import ProviderPolicy
from providers.naver_hub.client import NaverHubSearchClient, NaverHubTrendClient
from tests.conftest import make_gateway

SEARCH_BODY = {
    "total": 20877510,
    "start": 1,
    "display": 2,
    "items": [
        {
            "title": "제목 <b>테스트</b>",
            "link": "https://blog.example/1",
            "description": "설명",
            "bloggername": "블로거",
            "postdate": "20260830",
        }
    ],
}

TREND_BODY = {
    "startDate": "2025-09-01",
    "endDate": "2026-09-01",
    "timeUnit": "month",
    "results": [
        {
            "title": "테스트",
            "keywords": ["테스트"],
            "data": [{"period": "2026-07-01", "ratio": 55.2}, {"period": "2026-08-01", "ratio": 100.0}],
        }
    ],
}


def make_search_client(recorder: list[httpx.Request]) -> NaverHubSearchClient:
    def handler(request: httpx.Request) -> httpx.Response:
        recorder.append(request)
        # Regression: HUB labels JSON bodies as text/plain — the client must not care.
        return httpx.Response(200, text=json.dumps(SEARCH_BODY), headers={"content-type": "text/plain;charset=UTF-8"})

    return NaverHubSearchClient(
        make_gateway(),
        "id",
        "secret",
        search_policy=ProviderPolicy("hub_search", 1000),
        transport=httpx.MockTransport(handler),
    )


def test_search_parses_text_plain_json_body():
    requests: list[httpx.Request] = []
    client = make_search_client(requests)
    result = client.search("blog", "테스트")
    assert result.total == 20877510
    assert result.items[0].author == "블로거"
    assert result.items[0].posted_at == "20260830"
    assert requests[0].headers["X-NCP-APIGW-API-KEY-ID"] == "id"


def test_landscape_queries_five_channels():
    requests: list[httpx.Request] = []
    client = make_search_client(requests)
    landscape = client.landscape("테스트")
    paths = {r.url.path for r in requests}
    assert paths == {
        "/search/v1/blog",
        "/search/v1/cafearticle",
        "/search/v1/kin",
        "/search/v1/webkr",
        "/search/v1/news",
    }
    assert landscape.blog_total == landscape.cafe_total == 20877510
    assert landscape.top_results and landscape.kin_items and landscape.cafe_items


def test_trend_parses_ratio_points():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["timeUnit"] == "month"
        assert body["keywordGroups"] == [{"groupName": "테스트", "keywords": ["테스트"]}]
        return httpx.Response(200, json=TREND_BODY)

    client = NaverHubTrendClient(
        make_gateway(),
        "id",
        "secret",
        trend_policy=ProviderPolicy("hub_trend", 1000),
        transport=httpx.MockTransport(handler),
    )
    series = client.get_search_trend("테스트")
    assert [p.ratio for p in series.points] == [55.2, 100.0]
    assert series.source == "NAVER_API_HUB"
