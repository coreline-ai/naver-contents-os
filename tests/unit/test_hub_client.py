import json

import httpx
import pytest

from app.errors import SchemaError
from providers.gateway import ProviderPolicy
from providers.naver_hub.client import NaverHubSearchClient, NaverHubShoppingClient, NaverHubTrendClient
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


def test_news_latest_uses_date_sort_and_preserves_original_link():
    requests: list[httpx.Request] = []
    body = {
        "total": 1,
        "items": [{
            "title": "최신 뉴스",
            "link": "https://naver.example/1",
            "originallink": "https://publisher.example/1",
            "description": "설명",
            "pubDate": "Wed, 02 Sep 2026 12:00:00 +0900",
        }],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, text=json.dumps(body), headers={"content-type": "text/plain"})

    client = NaverHubSearchClient(
        make_gateway(), "id", "secret",
        search_policy=ProviderPolicy("hub_latest_news", 1000),
        transport=httpx.MockTransport(handler),
    )
    result = client.search_news_latest("테스트")
    assert requests[0].url.params["sort"] == "date"
    assert requests[0].url.params["display"] == "100"
    assert result["items"][0]["original_link"] == "https://publisher.example/1"


def test_cache_hit_preserves_original_collection_time():
    requests: list[httpx.Request] = []
    client = make_search_client(requests)
    first = client.search("blog", "테스트")
    second = client.search("blog", "테스트")
    assert len(requests) == 1
    assert first.from_cache is False and second.from_cache is True
    assert first.collected_at == second.collected_at


def test_invalid_json_is_schema_error():
    client = NaverHubSearchClient(
        make_gateway(),
        "id",
        "secret",
        search_policy=ProviderPolicy("hub_search_invalid", 1000),
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, text="not-json")),
    )
    with pytest.raises(SchemaError):
        client.search("blog", "테스트")


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


def test_trend_accepts_an_exact_completed_date_window():
    bodies = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"results": []})

    client = NaverHubTrendClient(
        make_gateway(), "id", "secret",
        trend_policy=ProviderPolicy("hub_exact_trend", 1000),
        transport=httpx.MockTransport(handler),
    )
    client.get_search_trend(
        "테스트", time_unit="date", start_date="2026-08-20", end_date="2026-09-02"
    )
    assert bodies[0]["startDate"] == "2026-08-20"
    assert bodies[0]["endDate"] == "2026-09-02"
    assert bodies[0]["timeUnit"] == "date"


def test_trend_missing_ratio_is_schema_error():
    body = {"results": [{"data": [{"period": "2026-08-01"}]}]}
    client = NaverHubTrendClient(
        make_gateway(),
        "id",
        "secret",
        trend_policy=ProviderPolicy("hub_trend_invalid", 1000),
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=body)),
    )
    with pytest.raises(SchemaError):
        client.get_search_trend("테스트")


def test_empty_trend_results_return_explicit_empty_series():
    client = NaverHubTrendClient(
        make_gateway(),
        "id",
        "secret",
        trend_policy=ProviderPolicy("hub_trend_empty", 1000),
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"results": []})),
    )
    series = client.get_search_trend("테스트")
    assert series.keyword_group == "테스트"
    assert series.points == []


def test_preflight_local_and_image_contracts():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/errata"):
            return httpx.Response(200, text='{"errata":"네이버"}')
        if request.url.path.endswith("/adult"):
            return httpx.Response(200, json={"adult": "1"})
        if request.url.path.endswith("/local"):
            return httpx.Response(200, json={"total": 1, "items": [{"title": "카페", "roadAddress": "서울", "mapx": "1", "mapy": "2"}]})
        return httpx.Response(200, json={"total": 1, "items": [{"title": "사진", "link": "https://image", "thumbnail": "https://thumb", "sizewidth": "800", "sizeheight": "bad"}]})

    client = NaverHubSearchClient(
        make_gateway(), "id", "secret",
        search_policy=ProviderPolicy("hub_special", 1000),
        transport=httpx.MockTransport(handler),
    )
    assert client.get_errata("spdlqj")["value"] == "네이버"
    assert client.is_adult("테스트")["value"] is True
    assert client.search_local("카페")["items"][0]["road_address"] == "서울"
    image = client.search_images("사진")["items"][0]
    assert image["width"] == 800 and image["height"] is None
    assert {request.url.path for request in requests} == {
        "/search/v1/errata", "/search/v1/adult", "/search/v1/local", "/search/v1/image"
    }


def test_multi_group_segment_trends_and_limits():
    bodies = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        return httpx.Response(200, json={"results": [
            {"title": group["groupName"], "keywords": group["keywords"], "data": [{"period": "2026-08", "ratio": 10}]}
            for group in body["keywordGroups"]
        ]})

    client = NaverHubTrendClient(
        make_gateway(), "id", "secret",
        trend_policy=ProviderPolicy("hub_multi_trend", 1000),
        transport=httpx.MockTransport(handler),
    )
    rows = client.get_search_trends(
        [("A", ["a"]), ("B", ["b"])], device="mo", gender="f", ages=["3"]
    )
    assert [row.keyword_group for row in rows] == ["A", "B"]
    assert rows[0].device == "mo" and rows[0].gender == "f" and rows[0].ages == ["3"]
    assert bodies[0]["device"] == "mo"
    with pytest.raises(ValueError):
        client.get_search_trends([(str(i), [str(i)]) for i in range(6)])


def test_shopping_keyword_trends_use_official_contract():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"results": [{"title": "러닝화", "keyword": ["러닝화"], "data": [{"period": "2026-08", "ratio": 44.5}]}]})

    client = NaverHubShoppingClient(
        make_gateway(), "id", "secret",
        shopping_policy=ProviderPolicy("hub_shopping", 1000),
        transport=httpx.MockTransport(handler),
    )
    rows = client.get_keyword_trends("50000000", ["러닝화"])
    body = json.loads(requests[0].content)
    assert requests[0].url.path == "/shopping/v1/category/keywords"
    assert body["category"] == "50000000"
    assert body["keyword"] == [{"name": "러닝화", "param": ["러닝화"]}]
    assert rows[0]["points"][0]["ratio"] == 44.5
