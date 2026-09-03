from __future__ import annotations

from fastapi.testclient import TestClient

from app.db import make_engine, make_session_factory
from app.models_db import Base, Draft, DraftVersion, Keyword, KeywordSnapshot
from app.services.intent import IntentBoardService


def make_sessions(tmp_path):
    engine = make_engine(tmp_path / "intent.db")
    Base.metadata.create_all(engine)
    return make_session_factory(engine)


def seed(sessions) -> int:
    with sessions() as session:
        keyword = Keyword(text="러닝화 비교")
        session.add(keyword)
        session.flush()
        snapshot = KeywordSnapshot(
            keyword_id=keyword.id,
            payload={
                "metric": {"keyword": "러닝화 비교", "monthly_pc_searches": 100, "monthly_mobile_searches": 900, "volume_masked": False, "ad_competition": "높음", "source": "SEARCH_AD"},
                "related_keywords": [
                    {"keyword": " 러닝화　비교 ", "monthly_pc_searches": 1, "monthly_mobile_searches": 2, "volume_masked": False},
                    {"keyword": "러닝화 신청 조건", "monthly_pc_searches": None, "monthly_mobile_searches": None, "volume_masked": True, "ad_competition": None},
                    {"keyword": "러닝화 오류 해결", "monthly_pc_searches": 30, "monthly_mobile_searches": 70, "volume_masked": False, "ad_competition": "낮음"},
                ],
                "trend": {"points": [{"period": "2026-07", "ratio": 30}, {"period": "2026-08", "ratio": 60}], "source": "NAVER_API_HUB"},
                "landscape": {"blog_total": 1234, "cafe_total": 10, "kin_total": 5, "news_total": 2, "source": "NAVER_API_HUB"},
            },
        )
        session.add(snapshot)
        session.commit()
        return snapshot.id


def test_intent_board_is_deterministic_deduped_and_preserves_missing_values(tmp_path):
    sessions = make_sessions(tmp_path)
    snapshot_id = seed(sessions)
    board = IntentBoardService(sessions).get(snapshot_id)
    assert board["intent_version"] == "intent-v1"
    assert [item["keyword"] for item in board["items"]] == [
        "러닝화 비교", "러닝화 신청 조건", "러닝화 오류 해결"
    ]
    root, eligibility, troubleshooting = board["items"]
    assert root["intent"] == "comparison_review"
    assert root["metric"]["total"] == 1000
    assert root["trend"]["latest_ratio"] == 60.0
    assert root["organic"]["blog_total"] == 1234
    assert eligibility["intent"] == "eligibility"
    assert eligibility["metric"]["masked"] is True
    assert eligibility["metric"]["total"] is None
    assert eligibility["trend"] is None
    assert troubleshooting["intent"] == "troubleshooting"
    assert "score" not in root
    assert "합산하지" in root["commercial"]["note"]


def test_intent_board_content_state_uses_local_registry(tmp_path):
    sessions = make_sessions(tmp_path)
    snapshot_id = seed(sessions)
    with sessions() as session:
        keyword = session.query(Keyword).filter(Keyword.text == "러닝화 비교").one()
        draft = Draft(keyword_id=keyword.id, blog_type="COMPARISON", title="초안", plan_payload={})
        session.add(draft)
        session.flush()
        session.add(DraftVersion(draft_id=draft.id, version=1, title="초안", body="본문"))
        session.commit()
    board = IntentBoardService(sessions).get(snapshot_id)
    assert board["items"][0]["content"]["state"] == "draft_only"
    assert board["items"][1]["content"]["state"] == "missing"


def test_intent_board_api_reads_existing_snapshot_only(tmp_path, monkeypatch):
    token = "intent-token"
    monkeypatch.setenv("DB_PATH", str(tmp_path / "api.db"))
    monkeypatch.setenv("LOCAL_CORE_TOKEN", token)
    from app import deps
    from app.main import create_app

    deps.reset_caches()
    app = create_app()
    snapshot_id = seed(deps.get_session_factory())
    client = TestClient(app)
    response = client.get(
        f"/v1/snapshots/{snapshot_id}/intent-board",
        headers={"X-Local-Token": token},
    )
    assert response.status_code == 200
    assert response.json()["items"][0]["intent_version"] == "intent-v1"
    assert client.get("/v1/snapshots/999/intent-board", headers={"X-Local-Token": token}).status_code == 404
    deps.reset_caches()
