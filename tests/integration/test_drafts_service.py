import pytest
from fastapi.testclient import TestClient

from app.db import make_engine, make_session_factory
from app.models_db import Base, Keyword, KeywordSnapshot, PublishJob
from app.services.drafts import DraftService, SqlJobStore, split_generated
from providers.llm.base import LLMError


@pytest.fixture
def sessions(tmp_path):
    engine = make_engine(tmp_path / "drafts.db")
    Base.metadata.create_all(engine)
    return make_session_factory(engine)


class FakeLLM:
    name = "fake"

    def generate(self, prompt: str, *, system: str = "") -> str:
        assert "섹션 순서" in prompt
        return "제목: 애드포스트 승인 조건 총정리\n\n**결론 요약**\n승인 조건은 다음과 같습니다.\n\n조건\n첫째 조건."

    @property
    def model_name(self) -> str:
        return "fake-model"


class FailingLLM:
    name = "failing"
    model_name = ""

    def generate(self, prompt: str, *, system: str = "") -> str:
        raise LLMError("모델 없음")


PLAN_ITEM = {
    "order": 2,
    "title": "애드포스트 승인 조건이 뭔가요?",
    "blog_type": "POLICY",
    "target_keyword": "애드포스트 승인",
    "angle": "실제 질문에 답하는 글",
}


def test_split_generated_parses_title_line():
    title, body = split_generated("제목: 새 제목\n\n본문입니다", "폴백")
    assert (title, body) == ("새 제목", "본문입니다")
    title, body = split_generated("제목 없이 시작", "폴백")
    assert title == "폴백"


def test_create_draft_stores_v1_with_cleaned_markdown(sessions):
    service = DraftService(sessions, FakeLLM())
    draft = service.create_draft("애드포스트 승인", PLAN_ITEM, questions=["얼마나 걸리나요?"])
    assert draft["version"] == 1
    assert draft["title"] == "애드포스트 승인 조건 총정리"
    assert "**" not in draft["body"]  # markdown cleaned before storage

    stored = service.get_draft(draft["draft_id"])
    assert stored["blog_type"] == "POLICY"
    assert stored["versions"][0]["note"] == "V1 원본"
    assert stored["provider"] == "fake"
    assert stored["model"] == "fake-model"
    assert stored["prompt_version"] == "v1"
    assert stored["plan"]["blog_type"] == "POLICY"


def test_version_history_appends_and_keeps_originals(sessions):
    service = DraftService(sessions, FakeLLM())
    draft = service.create_draft("애드포스트 승인", PLAN_ITEM)
    v2 = service.add_version(draft["draft_id"], "수정 제목", "사실확인 반영 본문", note="V2 사실확인")
    assert v2["version"] == 2

    stored = service.get_draft(draft["draft_id"])
    assert [v["version"] for v in stored["versions"]] == [1, 2]
    assert stored["versions"][0]["body"] == draft["body"]  # V1 원본 보존 (복원 가능)
    assert stored["title"] == "수정 제목"


def test_skeleton_draft_without_llm(sessions):
    service = DraftService(sessions, None)
    draft = service.create_draft("애드포스트 승인", PLAN_ITEM)
    assert "결론 요약" in draft["body"]  # template skeleton
    assert draft["title"] == PLAN_ITEM["title"]


def test_sql_job_store_persists_history(sessions):
    store = SqlJobStore(sessions)
    service = DraftService(sessions, None)
    draft = service.create_draft("애드포스트 승인", PLAN_ITEM)

    job_id = store.create(draft["draft_id"])
    store.update(job_id, status="running", stage="health_check", error_code=None, detail="",
                 history_entry={"stage": "health_check", "status": "running", "at": "t1"})
    store.update(job_id, status="failed", stage="health_check", error_code="health_check_failed",
                 detail="draft_save_button", history_entry={"stage": "health_check", "status": "failed", "at": "t2"})

    with sessions() as session:
        job = session.get(PublishJob, job_id)
        assert job.status == "failed"
        assert job.error_code == "health_check_failed"
        assert [h["status"] for h in job.history] == ["running", "failed"]


def test_draft_snapshot_lineage_requires_same_keyword(sessions):
    with sessions() as session:
        keyword = Keyword(text="애드포스트 승인")
        other = Keyword(text="다른 키워드")
        session.add_all([keyword, other])
        session.flush()
        matching = KeywordSnapshot(keyword_id=keyword.id, payload={})
        mismatch = KeywordSnapshot(keyword_id=other.id, payload={})
        session.add_all([matching, mismatch])
        session.commit()

    service = DraftService(sessions, None)
    draft = service.create_draft(
        "애드포스트 승인", PLAN_ITEM, snapshot_id=matching.id
    )
    assert draft["source_snapshot_id"] == matching.id
    assert service.get_draft(draft["draft_id"])["source_snapshot_id"] == matching.id
    with pytest.raises(ValueError, match="does not belong"):
        service.create_draft("애드포스트 승인", PLAN_ITEM, snapshot_id=mismatch.id)


@pytest.fixture
def draft_api(tmp_path, monkeypatch):
    token = "draft-api-token"
    monkeypatch.setenv("DB_PATH", str(tmp_path / "api.db"))
    monkeypatch.setenv("LOCAL_CORE_TOKEN", token)

    from app import api as api_module
    from app import deps
    from app.main import create_app

    deps.reset_caches()
    app = create_app()
    factory = lambda use_llm: DraftService(  # noqa: E731
        deps.get_session_factory(), FakeLLM() if use_llm else None
    )
    app.dependency_overrides[api_module.get_draft_service_factory] = lambda: factory
    yield TestClient(app), token, deps.get_session_factory()
    deps.reset_caches()


def _headers(token):
    return {"X-Local-Token": token}


def test_draft_rest_create_get_and_add_version(draft_api):
    client, token, sessions = draft_api
    with sessions() as session:
        keyword = Keyword(text="애드포스트 승인")
        session.add(keyword)
        session.flush()
        snapshot = KeywordSnapshot(keyword_id=keyword.id, payload={})
        session.add(snapshot)
        session.commit()
        snapshot_id = snapshot.id

    payload = {
        "keyword": "애드포스트 승인",
        "snapshot_id": snapshot_id,
        "plan_item": {**PLAN_ITEM, "generation_status": "ready"},
        "questions": ["얼마나 걸리나요?"],
        "generation_mode": "skeleton",
    }
    created = client.post("/v1/drafts", json=payload, headers=_headers(token))
    assert created.status_code == 201
    body = created.json()
    assert body["provider"] == "skeleton"
    assert body["source_snapshot_id"] == snapshot_id

    fetched = client.get(f"/v1/drafts/{body['draft_id']}", headers=_headers(token))
    assert fetched.status_code == 200
    assert fetched.json()["plan"]["title"] == PLAN_ITEM["title"]

    updated = client.post(
        f"/v1/drafts/{body['draft_id']}/versions",
        json={"title": "수정 제목", "body": "수정 본문", "note": "사실확인"},
        headers=_headers(token),
    )
    assert updated.status_code == 201
    assert updated.json()["version"] == 2


def test_draft_api_rejects_structure_only_llm_before_generation(draft_api):
    client, token, _ = draft_api
    payload = {
        "keyword": "애드포스트 승인",
        "plan_item": {
            **PLAN_ITEM,
            "blog_type": "SERIES",
            "generation_status": "structure_only",
        },
        "generation_mode": "llm",
    }
    response = client.post("/v1/drafts", json=payload, headers=_headers(token))
    assert response.status_code == 422


def test_draft_api_llm_mode_records_provider_and_model(draft_api):
    client, token, _ = draft_api
    payload = {
        "keyword": "애드포스트 승인",
        "plan_item": {**PLAN_ITEM, "generation_status": "ready"},
        "generation_mode": "llm",
    }
    response = client.post("/v1/drafts", json=payload, headers=_headers(token))
    assert response.status_code == 201
    assert response.json()["provider"] == "fake"
    assert response.json()["model"] == "fake-model"


def test_draft_api_maps_llm_unavailable_to_standard_error(draft_api):
    client, token, sessions = draft_api
    from app import api as api_module

    client.app.dependency_overrides[api_module.get_draft_service_factory] = lambda: (
        lambda use_llm: DraftService(sessions, FailingLLM() if use_llm else None)
    )
    payload = {
        "keyword": "애드포스트 승인",
        "plan_item": {**PLAN_ITEM, "generation_status": "ready"},
        "generation_mode": "llm",
    }
    response = client.post("/v1/drafts", json=payload, headers=_headers(token))
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "llm_unavailable"
