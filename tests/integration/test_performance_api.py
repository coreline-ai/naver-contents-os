from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def performance_api(tmp_path, monkeypatch):
    from app.services import performance
    monkeypatch.setattr(performance, "_utcnow", lambda: datetime(2026, 9, 6, tzinfo=timezone.utc))
    token = "performance-api-token"
    monkeypatch.setenv("DB_PATH", str(tmp_path / "api.db"))
    monkeypatch.setenv("LOCAL_CORE_TOKEN", token)
    from app import deps
    from app.main import create_app

    deps.reset_caches()
    yield TestClient(create_app()), {"X-Local-Token": token}
    deps.reset_caches()


def test_performance_import_api_preview_create_list_overview_and_delete(performance_api):
    client, headers = performance_api
    channel = client.post(
        "/v1/performance/channels",
        headers=headers,
        json={"source": "creator_advisor", "display_name": "내 블로그"},
    )
    assert channel.status_code == 201
    channel_id = channel.json()["id"]
    payload = {
        "channel_id": channel_id,
        "source": "creator_advisor",
        "data_kind": "content_performance",
        "period_start": "2026-08-24",
        "period_end": "2026-08-30",
        "grain": "weekly",
        "rows": [{"title": "API 성과 글", "views": 300, "impressions": 200, "inflows": 2}],
    }
    preview = client.post("/v1/performance/imports/preview", headers=headers, json=payload)
    assert preview.status_code == 200
    assert preview.json()["rows"][0]["ctr"] == 1.0
    assert client.get("/v1/performance/imports", headers=headers).json()["items"] == []

    created = client.post("/v1/performance/imports", headers=headers, json=payload)
    assert created.status_code == 201
    import_id = created.json()["id"]
    assert client.post("/v1/performance/imports", headers=headers, json=payload).json()["duplicate"] is True
    assert client.get("/v1/performance/overview", headers=headers).json()["creator"]["metrics"]["impressions"] == 200
    assert client.get("/v1/performance/contents", headers=headers).json()["items"][0]["data_state"] == "partial"
    assert client.get("/v1/performance/recommendations", headers=headers).json()["items"][0]["rule_code"] == "high_impressions_low_ctr"

    deleted = client.delete(f"/v1/performance/imports/{import_id}", headers=headers)
    assert deleted.status_code == 204
    assert client.get("/v1/performance/contents", headers=headers).json()["items"] == []
    assert client.get("/v1/performance/recommendations", headers=headers).json()["items"] == []


def test_api_rejects_unknown_or_customer_level_fields_before_service(performance_api):
    client, headers = performance_api
    channel_id = client.post(
        "/v1/performance/channels",
        headers=headers,
        json={"source": "biz_advisor", "display_name": "스토어"},
    ).json()["id"]
    payload = {
        "channel_id": channel_id,
        "source": "biz_advisor",
        "data_kind": "commerce_attribution",
        "period_start": date(2026, 8, 24).isoformat(),
        "period_end": date(2026, 8, 30).isoformat(),
        "grain": "weekly",
        "rows": [{"tracking_id": "naver.blog.social", "orders": 1, "customer_name": "저장 금지"}],
    }
    response = client.post("/v1/performance/imports", headers=headers, json=payload)
    assert response.status_code == 422
    assert "customer_name" in str(response.json())
    assert client.get("/v1/performance/imports", headers=headers).json()["items"] == []


def test_tracking_link_api_uses_official_character_rules(performance_api):
    client, headers = performance_api
    channel = client.post(
        "/v1/performance/channels",
        headers=headers,
        json={"source": "biz_advisor", "display_name": "추적 스토어"},
    )
    assert channel.status_code == 201
    response = client.post(
        "/v1/performance/tracking-links",
        headers=headers,
        json={
            "destination_url": "https://smartstore.naver.com/store/products/1?x=1",
            "nt_source": "naver.blog",
            "nt_medium": "social",
            "nt_detail": "sence4u",
            "nt_keyword": "후쿠오카여행",
        },
    )
    assert response.status_code == 200
    assert response.json()["url"].startswith("https://smartstore.naver.com/")
    assert "nt_medium=social" in response.json()["url"]
    invalid = client.post(
        "/v1/performance/tracking-links",
        headers=headers,
        json={
            "destination_url": "https://smartstore.naver.com/store/products/1",
            "nt_source": "네이버 블로그",
            "nt_medium": "social",
        },
    )
    assert invalid.status_code == 422


def test_channel_feature_flags_hide_unconfigured_optional_sections(performance_api):
    client, headers = performance_api
    initial = client.get("/v1/performance/channels", headers=headers).json()
    assert initial["features"] == {"creator": False, "commerce": False, "website": False}
    created = client.post(
        "/v1/performance/channels",
        headers=headers,
        json={
            "source": "search_advisor",
            "display_name": "회사 사이트",
            "site_url": "https://example.com",
            "ownership_confirmed": True,
        },
    ).json()
    assert created["ownership_confirmed"] is True
    assert client.get("/v1/performance/channels", headers=headers).json()["features"]["website"] is True
    disabled = client.patch(
        f"/v1/performance/channels/{created['id']}", headers=headers, json={"enabled": False}
    )
    assert disabled.status_code == 200
    assert client.get("/v1/performance/channels", headers=headers).json()["features"]["website"] is False


def test_scoped_performance_routes_validate_query_and_keep_old_client_compatible(performance_api):
    client, headers = performance_api
    routes = ['imports','overview','contents','queries','recommendations']
    for route in routes:
        assert client.get(f'/v1/performance/{route}?channel_id=0', headers=headers).status_code == 422
        assert client.get(f'/v1/performance/{route}?channel_id=1').status_code == 401
        assert client.get(f'/v1/performance/{route}', headers=headers).status_code == 200
        response=client.get(f'/v1/performance/{route}?channel_id=999', headers=headers)
        assert response.status_code == 200
        assert response.json().get('items',[]) == []
    assert client.get('/v1/performance/overview?import_id=999', headers=headers).status_code == 404
