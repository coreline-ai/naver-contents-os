from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.db import make_engine, make_session_factory
from app.models_db import Base, Keyword, KeywordSnapshot
from app.services.drafts import DraftService
from app.services.factpacks import FactPackService


@pytest.fixture
def sessions(tmp_path):
    engine = make_engine(tmp_path / "factpacks.db")
    Base.metadata.create_all(engine)
    return make_session_factory(engine)


def snapshot_payload(collected_at: datetime) -> dict:
    iso = collected_at.isoformat()
    return {
        "metric": {
            "source": "SEARCH_AD",
            "collected_at": iso,
            "from_cache": True,
            "keyword": "러닝화 비교",
            "monthly_pc_searches": 120,
            "monthly_mobile_searches": 880,
            "volume_masked": False,
            "ad_competition": "높음",
            "ad_click_metrics": {"private": "DO_NOT_COPY"},
        },
        "related_keywords": [],
        "trend": {
            "source": "NAVER_API_HUB",
            "collected_at": iso,
            "keyword_group": "러닝화 비교",
            "keywords": ["러닝화 비교"],
            "points": [
                {"period": "2026-07-01", "ratio": 40},
                {"period": "2026-08-01", "ratio": 80},
            ],
        },
        "landscape": {
            "source": "NAVER_API_HUB",
            "collected_at": iso,
            "keyword": "러닝화 비교",
            "blog_total": 100,
            "cafe_total": 20,
            "kin_total": 10,
            "web_total": 5,
            "news_total": 2,
            "top_results": [{
                "title": "러닝화 실제 비교",
                "link": "https://example.com/post",
                "description": "SECRET_FULL_PROVIDER_BODY",
                "author": "private-author",
                "posted_at": "20260830",
            }],
            "kin_items": [{
                "title": "러닝화는 어떻게 비교하나요?",
                "link": "https://example.com/question",
                "description": "private question body",
                "posted_at": "20260829",
            }],
            "cafe_items": [],
            "news_items": [],
        },
        "raw_secret": "NEVER_EXPOSE_RAW_PAYLOAD",
    }


def seed_snapshot(sessions, *, old: bool = False, payload: dict | None = None) -> int:
    now = datetime(2026, 9, 3, tzinfo=timezone.utc)
    collected = now - timedelta(days=31 if old else 1)
    with sessions() as session:
        keyword = Keyword(text="러닝화 비교")
        session.add(keyword)
        session.flush()
        snapshot = KeywordSnapshot(
            keyword_id=keyword.id,
            collected_at=collected,
            payload=snapshot_payload(collected) if payload is None else payload,
            score={"value": 73, "confidence": "high"},
            score_version="v1",
        )
        session.add(snapshot)
        session.commit()
        return snapshot.id


def test_builder_rejects_missing_snapshot_and_marks_partial_sources(sessions):
    service = FactPackService(sessions)
    with pytest.raises(ValueError, match="snapshot not found"):
        service.create(999)

    snapshot_id = seed_snapshot(sessions, payload={"metric": None})
    pack = service.create(snapshot_id)
    latest = pack["versions"][-1]
    assert latest["status"] == "draft"
    assert any("검색량" in warning for warning in latest["warnings"])
    assert any("검색 추세" in warning for warning in latest["warnings"])
    assert any("검색 결과" in warning for warning in latest["warnings"])


def test_builder_preserves_compact_provenance_and_stale_cache_without_raw_body(sessions):
    snapshot_id = seed_snapshot(sessions, old=True)
    now = datetime(2026, 9, 3, tzinfo=timezone.utc)
    pack = FactPackService(sessions, now=lambda: now).create(snapshot_id)
    latest = pack["versions"][-1]
    metric = next(item for item in latest["evidence"] if item["id"] == "metric:volume")
    result = next(item for item in latest["evidence"] if item["id"] == "search:blog:1")
    assert metric["from_cache"] is True
    assert metric["freshness"] == "stale"
    assert result["source_url"] == "https://example.com/post"
    assert result["value"] == {"title": "러닝화 실제 비교", "posted_at": "20260830"}
    serialized = str(pack)
    assert "SECRET_FULL_PROVIDER_BODY" not in serialized
    assert "NEVER_EXPOSE_RAW_PAYLOAD" not in serialized
    assert any("30일" in warning for warning in latest["warnings"])


def test_append_is_immutable_and_approval_requires_known_selected_evidence(sessions):
    pack = FactPackService(sessions).create(seed_snapshot(sessions))
    service = FactPackService(sessions)
    updated = service.append_version(
        pack["fact_pack_id"], selected_evidence_ids=["metric:volume"], status="approved"
    )
    assert updated is not None
    assert updated["latest_version"] == 2
    first, second = updated["versions"]
    assert next(item for item in first["evidence"] if item["id"] == "trend:summary")["selected"] is True
    assert next(item for item in second["evidence"] if item["id"] == "trend:summary")["selected"] is False
    with pytest.raises(ValueError, match="requires selected"):
        service.append_version(pack["fact_pack_id"], selected_evidence_ids=[], status="approved")
    with pytest.raises(ValueError, match="unknown evidence"):
        service.append_version(pack["fact_pack_id"], selected_evidence_ids=["raw:secret"], status="draft")


class CapturingLLM:
    name = "capture"
    model_name = "capture-model"

    def __init__(self):
        self.prompts: list[str] = []

    def generate(self, prompt: str, *, system: str = "") -> str:
        self.prompts.append(prompt)
        return "제목: 승인 근거 초안\n\n검토된 내용입니다."


PLAN_ITEM = {
    "order": 1,
    "title": "러닝화 비교 가이드",
    "blog_type": "COMPARISON",
    "target_keyword": "러닝화 비교",
    "angle": "근거 중심",
}


def test_unapproved_or_mismatched_factpack_is_blocked_before_llm_and_prompt_is_private(sessions):
    snapshot_id = seed_snapshot(sessions)
    fact_service = FactPackService(sessions)
    pack = fact_service.create(snapshot_id)
    llm = CapturingLLM()
    drafts = DraftService(sessions, llm)
    with pytest.raises(ValueError, match="not approved"):
        drafts.create_draft(
            "러닝화 비교", PLAN_ITEM, snapshot_id=snapshot_id,
            fact_pack_id=pack["fact_pack_id"], fact_pack_version=1,
        )
    assert llm.prompts == []

    approved = fact_service.append_version(
        pack["fact_pack_id"], selected_evidence_ids=["metric:volume"], status="approved"
    )
    created = drafts.create_draft(
        "러닝화 비교", PLAN_ITEM, snapshot_id=snapshot_id,
        fact_pack_id=pack["fact_pack_id"], fact_pack_version=approved["latest_version"],
    )
    assert len(llm.prompts) == 1
    prompt = llm.prompts[0]
    assert "월간 PC·모바일 검색량" in prompt
    assert "러닝화 실제 비교" not in prompt  # unselected search-result metadata
    assert "SECRET_FULL_PROVIDER_BODY" not in prompt
    assert "NEVER_EXPOSE_RAW_PAYLOAD" not in prompt
    stored = drafts.get_draft(created["draft_id"])
    assert stored["fact_pack_id"] == pack["fact_pack_id"]
    assert stored["fact_pack_version"] == approved["latest_version"]

    with sessions() as session:
        other = Keyword(text="다른 키워드")
        session.add(other)
        session.flush()
        mismatch = KeywordSnapshot(keyword_id=other.id, payload={})
        session.add(mismatch)
        session.commit()
    with pytest.raises(ValueError, match="snapshot_id does not belong"):
        drafts.create_draft(
            "러닝화 비교", PLAN_ITEM, snapshot_id=mismatch.id,
            fact_pack_id=pack["fact_pack_id"], fact_pack_version=approved["latest_version"],
        )
    assert len(llm.prompts) == 1


def test_skeleton_draft_preserves_approved_factpack_lineage(sessions):
    snapshot_id = seed_snapshot(sessions)
    facts = FactPackService(sessions)
    pack = facts.create(snapshot_id)
    approved = facts.append_version(
        pack["fact_pack_id"], selected_evidence_ids=["trend:summary"], status="approved"
    )
    created = DraftService(sessions, None).create_draft(
        "러닝화 비교", PLAN_ITEM, snapshot_id=snapshot_id,
        fact_pack_id=pack["fact_pack_id"], fact_pack_version=approved["latest_version"],
    )
    assert created["fact_pack_id"] == pack["fact_pack_id"]
    assert created["fact_pack_version"] == 2


def test_factpack_rest_create_get_and_append(tmp_path, monkeypatch):
    token = "factpack-token"
    monkeypatch.setenv("DB_PATH", str(tmp_path / "api.db"))
    monkeypatch.setenv("LOCAL_CORE_TOKEN", token)
    from app import deps
    from app.main import create_app

    deps.reset_caches()
    app = create_app()
    sessions = deps.get_session_factory()
    snapshot_id = seed_snapshot(sessions)
    client = TestClient(app)
    headers = {"X-Local-Token": token}

    created = client.post("/v1/factpacks", json={"snapshot_id": snapshot_id}, headers=headers)
    assert created.status_code == 201
    pack = created.json()
    evidence_id = pack["versions"][0]["evidence"][0]["id"]
    approved = client.post(
        f"/v1/factpacks/{pack['fact_pack_id']}/versions",
        json={"selected_evidence_ids": [evidence_id], "status": "approved"},
        headers=headers,
    )
    assert approved.status_code == 201
    assert approved.json()["latest_status"] == "approved"
    fetched = client.get(f"/v1/factpacks/{pack['fact_pack_id']}", headers=headers)
    assert fetched.status_code == 200
    assert len(fetched.json()["versions"]) == 2
    deps.reset_caches()
