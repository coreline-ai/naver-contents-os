import json

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from providers.gateway import Gateway, ProviderPolicy

SEARCH_BODY = {
    "total": 12345,
    "items": [
        {"title": "글 제목", "link": "https://blog.example/1", "description": "d", "bloggername": "b", "postdate": "20260830"}
    ],
}
TREND_BODY = {
    "results": [{"title": "kw", "keywords": ["kw"], "data": [{"period": "2026-08-01", "ratio": 100.0}]}]
}
SEARCHAD_BODY = {
    "keywordList": [
        {"relKeyword": "테스트키워드", "monthlyPcQcCnt": 100, "monthlyMobileQcCnt": 900, "compIdx": "낮음"}
    ]
}

TOKEN = "integration-test-token"


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("LOCAL_CORE_TOKEN", TOKEN)
    from app import deps

    deps.reset_caches()
    yield
    deps.reset_caches()


def build_client(env_unused=None, hub_status=200):
    """App wired to mock transports over a tmp, alembic-migrated SQLite DB."""
    from app import api as api_module
    from app import deps, errors
    from app.main import create_app
    from app.services.analyze import AnalyzeService
    from app.stores import SqlCacheStore, SqlUsageStore
    from providers.naver_hub.client import NaverHubSearchClient, NaverHubTrendClient
    from providers.searchad.client import NaverSearchAdClient

    app = create_app()  # runs migrations against DB_PATH
    sessions = deps.get_session_factory()
    calls = {"hub": 0, "trend": 0, "searchad": 0}

    def hub_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/search-trend"):
            calls["trend"] += 1
            return httpx.Response(200, json=TREND_BODY)
        calls["hub"] += 1
        if hub_status != 200:
            return httpx.Response(hub_status)
        return httpx.Response(200, text=json.dumps(SEARCH_BODY), headers={"content-type": "text/plain"})

    def searchad_handler(request: httpx.Request) -> httpx.Response:
        calls["searchad"] += 1
        return httpx.Response(200, json=SEARCHAD_BODY)

    gateway = Gateway(
        cache=SqlCacheStore(sessions),
        usage=SqlUsageStore(sessions),
        auth_error=errors.AuthError,
        request_error=errors.RequestError,
        rate_limit_error=errors.RateLimitError,
        quota_error=errors.QuotaError,
        sleeper=lambda _s: None,
    )
    service = AnalyzeService(
        sessions,
        NaverSearchAdClient(
            gateway, "k", "s", "c",
            policy=ProviderPolicy("searchad", 1000, max_concurrency=1),
            transport=httpx.MockTransport(searchad_handler),
        ),
        NaverHubSearchClient(
            gateway, "i", "s",
            search_policy=ProviderPolicy("hub_search", 1000),
            transport=httpx.MockTransport(hub_handler),
        ),
        NaverHubTrendClient(
            gateway, "i", "s",
            trend_policy=ProviderPolicy("hub_trend", 1000),
            transport=httpx.MockTransport(hub_handler),
        ),
    )
    app.dependency_overrides[api_module.get_analyze_service] = lambda: service
    return TestClient(app), calls, sessions


def analyze(client, keyword="테스트키워드", **extra):
    return client.post(
        "/v1/keywords/analyze",
        json={"keyword": keyword, **extra},
        headers={"X-Local-Token": TOKEN},
    )


def test_missing_or_wrong_token_is_401(env):
    client, _, _ = build_client()
    assert client.post("/v1/keywords/analyze", json={"keyword": "x"}).status_code == 401
    r = client.post(
        "/v1/keywords/analyze", json={"keyword": "x"}, headers={"X-Local-Token": "wrong"}
    )
    assert r.status_code == 401


def test_whitespace_keyword_and_mismatched_serp_are_422(env):
    client, _, _ = build_client()
    assert analyze(client, keyword="   ").status_code == 422
    response = analyze(
        client,
        keyword="테스트키워드",
        serp={
            "query": "다른키워드",
            "results": [],
        },
    )
    assert response.status_code == 422


def test_nfkc_keyword_is_normalized_at_request_boundary(env):
    client, _, _ = build_client()
    body = analyze(client, keyword="  ＡＢＣ　테스트  ").json()
    assert body["keyword"] == "ABC 테스트"


def test_analyze_returns_all_blocks_with_sources(env):
    client, _, _ = build_client()
    body = analyze(client).json()

    assert body["data_status"] == {"searchad": "ok", "hub_search": "ok", "hub_trend": "ok"}
    assert body["metric"]["monthly_pc_searches"] == 100
    assert body["metric"]["source"] == "SEARCH_AD"
    assert body["landscape"]["blog_total"] == 12345
    assert body["landscape"]["source"] == "NAVER_API_HUB"
    assert body["trend"]["points"][0]["ratio"] == 100.0
    assert body["snapshot_id"] >= 1

    # Phase 4 blocks: explainable score + 15-piece plan + clusters
    assert body["score"]["score_version"] == "v1"
    assert body["score"]["value"] is None or 0 <= body["score"]["value"] <= 100
    by_name = {c["component"]: c for c in body["score"]["contributions"]}
    assert by_name["volume"]["status"] == "ok"
    assert len(body["plan"]) == 15
    assert all(p["reason"] for p in body["plan"])
    assert body["clusters"], "related keywords must cluster"


def test_second_call_hits_cache_without_external_calls(env):
    client, calls, _ = build_client()
    analyze(client)
    first = dict(calls)
    body2 = analyze(client).json()
    assert calls == first  # zero additional external calls
    assert body2["data_status"]["hub_search"] == "ok"


def test_force_refresh_calls_external_again(env):
    client, calls, _ = build_client()
    analyze(client)
    first = dict(calls)
    analyze(client, force_refresh=True)
    assert calls["hub"] == first["hub"] * 2
    assert calls["searchad"] == first["searchad"] * 2


def test_upstream_auth_failure_degrades_block_not_request(env):
    client, _, _ = build_client(hub_status=401)
    body = analyze(client).json()
    assert body["data_status"]["hub_search"] == "auth"
    assert body["landscape"] is None
    assert body["data_status"]["searchad"] == "ok"  # other sources unaffected
    assert body["metric"] is not None


def test_missing_exact_searchad_row_does_not_use_first_related_metric(env):
    client, _, _ = build_client()
    body = analyze(client, keyword="정확히없는키워드").json()
    assert body["metric"] is None
    assert body["related_keywords"][0]["keyword"] == "테스트키워드"
    by_name = {c["component"]: c for c in body["score"]["contributions"]}
    assert by_name["volume"]["status"] == "missing"


def test_snapshots_are_persisted(env):
    from app.models_db import KeywordSnapshot

    client, _, sessions = build_client()
    analyze(client)
    analyze(client, force_refresh=True)
    with sessions() as session:
        count = session.scalar(select(func.count(KeywordSnapshot.id)))
    assert count == 2
