from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

TOKEN = "research-api-token"


class FakeResearchService:
    def capabilities(self):
        return {"providers": {}, "searchad_access": "read_only", "collected_at": "now"}

    def snapshot(self, snapshot_id):
        return None if snapshot_id == 404 else {"snapshot_id": snapshot_id}

    def preflight(self, keyword, **_kwargs):
        return {"keyword": keyword, "correction": None, "sensitive": False}

    def suggest(self, query, **_kwargs):
        return {"query": query, "suggestions": [], "status": "ok"}

    def rising(self, **kwargs):
        return {**kwargs, "run_id": 1, "candidates": []}

    def latest_rising(self, **kwargs):
        return {"run": {**kwargs, "run_id": 1}}

    def graph(self, keyword, **_kwargs):
        return {"keyword": keyword, "nodes": [], "edges": [], "status": "ok"}

    def commercial(self, keywords, **_kwargs):
        return {"rows": [{"keyword": keyword} for keyword in keywords]}

    def audience(self, keyword, **_kwargs):
        return {"keyword": keyword, "segments": {}}

    def specialized(self, keyword, mode, **_kwargs):
        return {"keyword": keyword, "mode": mode}

    def list_watchlist(self):
        return {"items": [], "cap": 50}

    def add_watchlist(self, keyword):
        return {"id": 1, "keyword": keyword}

    def delete_watchlist(self, item_id):
        return item_id == 1

    def refresh_watchlist(self, item_ids, **_kwargs):
        return {"item_ids": item_ids}

    def ad_performance(self, since, until, **_kwargs):
        return {"since": since, "until": until, "read_only": True}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "research-api.db"))
    monkeypatch.setenv("LOCAL_CORE_TOKEN", TOKEN)
    from app import api as api_module
    from app import deps
    from app.main import create_app

    deps.reset_caches()
    app = create_app()
    app.dependency_overrides[api_module.get_research_service] = FakeResearchService
    yield TestClient(app)
    deps.reset_caches()


def headers():
    return {"X-Local-Token": TOKEN}


def test_research_routes_require_token_and_validate_boundaries(client):
    assert client.get("/v1/capabilities").status_code == 401
    assert client.get("/v1/capabilities", headers=headers()).status_code == 200
    assert client.post("/v1/keywords/preflight", json={"keyword": "  ＡＢＣ  "}, headers=headers()).json()["keyword"] == "ABC"
    assert client.post("/v1/research/graph", json={"keyword": "키워드", "snapshot_id": 1}, headers=headers()).status_code == 200
    assert client.post("/v1/research/commercial", json={"keywords": []}, headers=headers()).status_code == 422
    assert client.post("/v1/research/specialized", json={"keyword": "신발", "mode": "shopping"}, headers=headers()).status_code == 422
    assert client.post("/v1/research/ad-performance", json={"since": "2026-09-01", "until": "2026-08-01"}, headers=headers()).status_code == 422


def test_watchlist_and_snapshot_http_semantics(client):
    assert client.post("/v1/watchlist", json={"keyword": "테스트"}, headers=headers()).status_code == 201
    assert client.post("/v1/watchlist/refresh", json={"item_ids": [1]}, headers=headers()).status_code == 200
    assert client.delete("/v1/watchlist/1", headers=headers()).status_code == 204
    assert client.delete("/v1/watchlist/2", headers=headers()).status_code == 404
    assert client.get("/v1/snapshots/2", headers=headers()).status_code == 200
    assert client.get("/v1/snapshots/404", headers=headers()).status_code == 404


def test_suggestion_and_rising_routes_validate_mode_boundaries(client):
    assert client.post(
        "/v1/keywords/suggest", json={"query": "가", "limit": 8}, headers=headers()
    ).status_code == 422
    valid = client.post(
        "/v1/keywords/suggest", json={"query": "러닝화", "limit": 8}, headers=headers()
    )
    assert valid.status_code == 200 and valid.json()["query"] == "러닝화"

    assert client.post(
        "/v1/research/rising", json={"mode": "general"}, headers=headers()
    ).status_code == 422
    assert client.post(
        "/v1/research/rising", json={"mode": "local", "region": "성수"}, headers=headers()
    ).status_code == 200
    assert client.post(
        "/v1/research/rising", json={"mode": "shopping", "seed": "신발"}, headers=headers()
    ).status_code == 422
    latest = client.get(
        "/v1/research/rising/latest?mode=general&seed=러닝화", headers=headers()
    )
    assert latest.status_code == 200 and latest.json()["run"]["run_id"] == 1
