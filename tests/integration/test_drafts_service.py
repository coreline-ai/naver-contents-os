from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app.db import make_engine, make_session_factory
from app.models_db import Base, Draft, DraftVersion, Keyword, KeywordSnapshot, PublishJob
from app.services.drafts import DraftService, SqlJobStore, split_generated
from app.services.publishing import PublishService
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


class RecordingLLM(FakeLLM):
    def __init__(self):
        self.calls = 0

    def generate(self, prompt: str, *, system: str = "") -> str:
        self.calls += 1
        return super().generate(prompt, system=system)


class CapturingPublishRunner:
    def __init__(self, store, captured):
        self._store = store
        self._captured = captured

    def run(self, _page, _adapter, **kwargs):
        self._captured.update(kwargs)
        job_id = kwargs["job_id"]
        self._store.update(
            job_id,
            status="draft_saved",
            stage="draft_save",
            error_code=None,
            detail="",
            history_entry={"stage": "draft_save", "status": "draft_saved", "at": "test"},
        )
        return {"job_id": job_id, "status": "draft_saved", "stage": "draft_save"}


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

    assert store.get(job_id)["status"] == "failed"


def test_publish_service_uses_existing_latest_version_without_creating_content(sessions):
    drafts = DraftService(sessions, None)
    created = drafts.create_draft("애드포스트 승인", PLAN_ITEM)
    drafts.add_version(created["draft_id"], "최신 제목", "최신 본문", note="사실확인")
    captured = {}

    @contextmanager
    def fake_page(cdp_url):
        captured["cdp_url"] = cdp_url
        yield object()

    service = PublishService(
        sessions,
        page_factory=fake_page,
        adapter_factory=lambda page: page,
        runner_factory=lambda store: CapturingPublishRunner(store, captured),
    )
    task = service.prepare(
        created["draft_id"],
        blog_id="target_blog",
        tags=[" 태그1 ", "", "태그2"],
        cdp_url="http://127.0.0.1:9222",
    )
    assert task is not None
    assert (task.title, task.body, task.tags) == ("최신 제목", "최신 본문", ["태그1", "태그2"])

    with sessions() as session:
        before = (session.query(Draft).count(), session.query(DraftVersion).count())
    service.run(task)
    with sessions() as session:
        after = (session.query(Draft).count(), session.query(DraftVersion).count())

    assert before == after == (1, 2)
    assert captured["draft_id"] == created["draft_id"]
    assert captured["title"] == "최신 제목"
    assert captured["body"] == "최신 본문"
    assert captured["cdp_url"] == "http://127.0.0.1:9222"
    assert service.get_job(task.job_id)["status"] == "draft_saved"


def test_publish_service_records_browser_attach_failure(sessions):
    created = DraftService(sessions, None).create_draft("애드포스트 승인", PLAN_ITEM)

    @contextmanager
    def unavailable_page(_cdp_url):
        raise ConnectionError("CDP unavailable")
        yield  # pragma: no cover

    service = PublishService(sessions, page_factory=unavailable_page)
    task = service.prepare(
        created["draft_id"],
        blog_id="target_blog",
        tags=[],
        cdp_url="http://127.0.0.1:9222",
    )
    assert task is not None
    service.run(task)

    job = service.get_job(task.job_id)
    assert job["status"] == "failed"
    assert job["stage"] == "browser_attach"
    assert job["error_code"] == "browser_unavailable"
    assert "CDP unavailable" not in job["detail"]


def test_publish_service_distinguishes_unhandled_runner_failure(sessions):
    created = DraftService(sessions, None).create_draft("애드포스트 승인", PLAN_ITEM)

    @contextmanager
    def fake_page(_cdp_url):
        yield object()

    class BrokenRunner:
        def run(self, *_args, **_kwargs):
            raise RuntimeError("sensitive editor detail")

    service = PublishService(
        sessions,
        page_factory=fake_page,
        adapter_factory=lambda page: page,
        runner_factory=lambda _store: BrokenRunner(),
    )
    task = service.prepare(
        created["draft_id"],
        blog_id="target_blog",
        tags=[],
        cdp_url="http://127.0.0.1:9222",
    )
    assert task is not None
    service.run(task)

    job = service.get_job(task.job_id)
    assert job["stage"] == "publisher_runtime"
    assert job["error_code"] == "publisher_error"
    assert "sensitive editor detail" not in job["detail"]


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

    llm = RecordingLLM()
    service = DraftService(sessions, llm)
    with pytest.raises(ValueError, match="does not belong"):
        service.create_draft("애드포스트 승인", PLAN_ITEM, snapshot_id=mismatch.id)
    assert llm.calls == 0  # invalid lineage must not consume an external generation call

    draft = service.create_draft(
        "애드포스트 승인", PLAN_ITEM, snapshot_id=matching.id
    )
    assert llm.calls == 1
    assert draft["source_snapshot_id"] == matching.id
    assert service.get_draft(draft["draft_id"])["source_snapshot_id"] == matching.id


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
    assert response.json()["error"]["provider"] == "failing"
    with sessions() as session:
        assert session.query(Draft).count() == 0
        assert session.query(DraftVersion).count() == 0


def test_publish_job_api_starts_existing_draft_and_exposes_status(draft_api):
    client, token, sessions = draft_api
    from app import api as api_module

    draft = DraftService(sessions, None).create_draft("애드포스트 승인", PLAN_ITEM)
    DraftService(sessions, None).add_version(
        draft["draft_id"], "검수 완료 제목", "검수 완료 본문", note="최종 검수"
    )
    captured = {}

    @contextmanager
    def fake_page(cdp_url):
        captured["cdp_url"] = cdp_url
        yield object()

    publisher = PublishService(
        sessions,
        page_factory=fake_page,
        adapter_factory=lambda page: page,
        runner_factory=lambda store: CapturingPublishRunner(store, captured),
    )
    client.app.dependency_overrides[api_module.get_publish_service] = lambda: publisher

    started = client.post(
        f"/v1/drafts/{draft['draft_id']}/publish-jobs",
        json={"blog_id": "target_blog", "tags": [" 태그1 ", "태그2"]},
        headers=_headers(token),
    )
    assert started.status_code == 202
    job_id = started.json()["job_id"]
    assert started.json()["draft_id"] == draft["draft_id"]

    fetched = client.get(f"/v1/publish-jobs/{job_id}", headers=_headers(token))
    assert fetched.status_code == 200
    assert fetched.json()["status"] == "draft_saved"
    assert captured["title"] == "검수 완료 제목"
    assert captured["body"] == "검수 완료 본문"
    assert captured["tags"] == ["태그1", "태그2"]


def test_publish_job_api_validates_target_and_missing_records(draft_api):
    client, token, _ = draft_api
    invalid = client.post(
        "/v1/drafts/999/publish-jobs",
        json={"blog_id": "잘못된 ID", "tags": []},
        headers=_headers(token),
    )
    assert invalid.status_code == 422

    oversized_tag = client.post(
        "/v1/drafts/999/publish-jobs",
        json={"blog_id": "valid_blog", "tags": ["태" * 51]},
        headers=_headers(token),
    )
    assert oversized_tag.status_code == 422

    missing = client.post(
        "/v1/drafts/999/publish-jobs",
        json={"blog_id": "valid_blog", "tags": []},
        headers=_headers(token),
    )
    assert missing.status_code == 404

    missing_job = client.get("/v1/publish-jobs/999", headers=_headers(token))
    assert missing_job.status_code == 404
