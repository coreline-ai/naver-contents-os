from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.db import make_engine, make_session_factory
from app.models_db import (
    AdPerformanceSnapshot,
    Base,
    DiscoveryRun,
    Draft,
    DraftVersion,
    Keyword,
    PublishedContent,
    PublishJob,
    WatchlistItem,
)
from app.services.work import TodayWorkService

NOW = datetime(2026, 9, 3, 12, tzinfo=timezone.utc)


@pytest.fixture
def sessions(tmp_path):
    engine = make_engine(tmp_path / "today.db")
    Base.metadata.create_all(engine)
    return make_session_factory(engine)


def add_draft(session, keyword_text: str, *, status: str = "editing", job: str | None = None):
    keyword = Keyword(text=keyword_text)
    session.add(keyword)
    session.flush()
    draft = Draft(keyword_id=keyword.id, blog_type="HOWTO", title=f"{keyword_text} 초안", plan_payload={}, user_status=status)
    session.add(draft)
    session.flush()
    session.add(DraftVersion(draft_id=draft.id, version=1, title=draft.title, body="본문"))
    session.flush()
    publish_job = None
    if job:
        publish_job = PublishJob(draft_id=draft.id, status=job, stage="input_body", detail="실패")
        session.add(publish_job)
        session.flush()
    return keyword, draft, publish_job


def test_priority_order_dedupe_and_maximum_five(sessions):
    with sessions() as session:
        _keyword1, failed, failed_job = add_draft(session, "오류 키워드", status="review_ready", job="failed")
        _keyword2, review, _ = add_draft(session, "검수 키워드", status="review_ready")
        _keyword3, saved, saved_job = add_draft(session, "임시저장 키워드", job="draft_saved")
        stale_keyword = Keyword(text="노후 키워드")
        session.add(stale_keyword)
        session.flush()
        stale = PublishedContent(keyword_id=stale_keyword.id, canonical_url="https://example.com/old", title="노후 글", published_at=NOW - timedelta(days=90))
        session.add(stale)
        watch_keyword = Keyword(text="상승 Watchlist")
        session.add(watch_keyword)
        session.flush()
        watch = WatchlistItem(
            keyword_id=watch_keyword.id,
            comparison_key="same",
            previous_snapshot={"comparison_key": "same", "latest_ratio": 20, "collected_at": (NOW - timedelta(hours=2)).isoformat()},
            last_snapshot={"comparison_key": "same", "latest_ratio": 40, "collected_at": (NOW - timedelta(hours=1)).isoformat()},
            last_status="ok",
        )
        session.add(watch)
        session.add(AdPerformanceSnapshot(since="2026-08-01", until="2026-09-01", collected_at=NOW, payload={"recommendations": [{"keyword": "광고 키워드", "reason": "고성과", "content_state": "missing"}]}))
        session.commit()

    result = TodayWorkService(sessions, now=lambda: NOW).list(limit=5)
    assert len(result["items"]) == 5
    assert [item["priority"] for item in result["items"]] == [1, 2, 3, 4, 5]
    assert result["items"][0]["draft_id"] == failed.id
    assert result["items"][0]["publish_job_id"] == failed_job.id
    assert sum(item["keyword"] == "오류 키워드" for item in result["items"]) == 1
    assert result["items"][2]["draft_id"] == saved.id
    assert result["items"][2]["publish_job_id"] == saved_job.id
    assert result["items"][4]["action"] == "open_analysis"
    with pytest.raises(ValueError, match="between 1 and 5"):
        TodayWorkService(sessions).list(limit=6)


def test_registered_publication_removes_draft_saved_recommendation(sessions):
    with sessions() as session:
        keyword, draft, _ = add_draft(session, "공개 완료", job="draft_saved")
        session.add(PublishedContent(draft_id=draft.id, keyword_id=keyword.id, canonical_url="https://example.com/live", title="공개 글", published_at=NOW))
        session.commit()
    assert TodayWorkService(sessions, now=lambda: NOW).list()["items"] == []


def test_stale_or_partial_external_sources_only_recommend_refresh(sessions):
    with sessions() as session:
        watch_keyword = Keyword(text="부분 Watchlist")
        session.add(watch_keyword)
        session.flush()
        session.add(WatchlistItem(
            keyword_id=watch_keyword.id,
            comparison_key="same",
            previous_snapshot={"comparison_key": "same", "latest_ratio": 10},
            last_snapshot={"comparison_key": "same", "latest_ratio": 30, "collected_at": (NOW - timedelta(days=2)).isoformat()},
            last_status="partial",
        ))
        session.add(DiscoveryRun(
            seed="주제", mode="general", comparison_key="date:test", created_at=NOW,
            payload={"candidates": [{"keyword": "부분 급상승", "direction": "rising", "freshness_score": None, "data_status": {"trend": "partial"}}]},
        ))
        session.add(AdPerformanceSnapshot(
            since="2026-08-01", until="2026-09-01", collected_at=NOW - timedelta(days=2),
            payload={"recommendations": [{"keyword": "오래된 광고", "content_state": "missing", "reason": "고성과"}]},
        ))
        session.commit()
    items = TodayWorkService(sessions, now=lambda: NOW).list()["items"]
    assert {item["keyword"] for item in items} == {"부분 Watchlist", "부분 급상승", "오래된 광고"}
    assert all(item["action"] == "refresh_data" and item["stale"] for item in items)


def test_reading_today_work_does_not_mutate_jobs_or_drafts(sessions):
    with sessions() as session:
        add_draft(session, "읽기 전용", status="review_ready", job="failed")
        session.commit()
        before = (session.query(Draft).count(), session.query(PublishJob).count(), session.query(PublishedContent).count())
    TodayWorkService(sessions, now=lambda: NOW).list()
    with sessions() as session:
        after = (session.query(Draft).count(), session.query(PublishJob).count(), session.query(PublishedContent).count())
    assert before == after


def test_today_work_api_is_local_and_capped(tmp_path, monkeypatch):
    token = "today-token"
    monkeypatch.setenv("DB_PATH", str(tmp_path / "api.db"))
    monkeypatch.setenv("LOCAL_CORE_TOKEN", token)
    from app import api as api_module
    from app import deps
    from app.main import create_app

    deps.reset_caches()
    app = create_app()
    sessions = deps.get_session_factory()
    with sessions() as session:
        add_draft(session, "API 검수", status="review_ready")
        session.commit()
    app.dependency_overrides[api_module.get_today_work_service] = lambda: TodayWorkService(sessions, now=lambda: NOW)
    client = TestClient(app)
    headers = {"X-Local-Token": token}
    response = client.get("/v1/work/today?limit=5", headers=headers)
    assert response.status_code == 200
    assert response.json()["items"][0]["action"] == "resume_draft"
    assert client.get("/v1/work/today?limit=6", headers=headers).status_code == 422
    deps.reset_caches()
