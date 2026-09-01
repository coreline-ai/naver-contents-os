import pytest

from app.db import make_engine, make_session_factory
from app.models_db import Base, PublishJob
from app.services.drafts import DraftService, SqlJobStore, split_generated


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
