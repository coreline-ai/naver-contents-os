import pytest

from app.services.composer import BlogComposerService


class FakeAnalyze:
    def __init__(self):
        self.calls = 0

    def analyze(self, keyword, *, force_refresh=False):
        self.calls += 1
        return {
            "keyword": keyword,
            "snapshot_id": 17,
            "metric": {"monthly_total_searches": 1234},
            "related_keywords": [
                {"keyword": "연관 키워드"},
                {"keyword": "두 번째 키워드"},
            ],
            "questions": [{"kind": "question", "text": "무엇을 확인하나요?"}],
            "plan": [
                {
                    "order": 1,
                    "title": "시리즈 허브",
                    "blog_type": "SERIES",
                    "target_keyword": keyword,
                    "angle": "허브",
                    "generation_status": "ready",
                },
                {
                    "order": 2,
                    "title": "독립 안내",
                    "blog_type": "HOWTO",
                    "target_keyword": keyword,
                    "angle": "안내",
                    "generation_status": "ready",
                },
            ],
            "data_status": {"hub_search": "ok"},
        }


class FakeResearch:
    def __init__(self, sensitive=False):
        self.sensitive = sensitive

    def preflight(self, keyword, *, force_refresh=False):
        return {
            "keyword": keyword,
            "correction": None,
            "sensitive": self.sensitive,
            "data_status": {"adult": "ok"},
            "collected_at": "2026-09-04T00:00:00Z",
        }


class FakeFactPacks:
    def create(self, snapshot_id):
        assert snapshot_id == 17
        return {
            "fact_pack_id": 8,
            "versions": [{
                "version": 1,
                "evidence": [
                    {"id": "fresh", "selected": True, "freshness": "fresh"},
                    {"id": "stale", "selected": True, "freshness": "stale"},
                ],
            }],
        }

    def append_version(self, fact_pack_id, *, selected_evidence_ids, status):
        assert fact_pack_id == 8
        assert selected_evidence_ids == ["fresh"]
        assert status == "approved"
        return {"fact_pack_id": 8, "latest_version": 2}


class FakeDrafts:
    def __init__(self):
        self.kwargs = None
        self.plan_item = None
        self.questions = None

    def create_draft(self, keyword, plan_item, questions, **kwargs):
        self.plan_item = plan_item
        self.questions = questions
        self.kwargs = kwargs
        return {
            "draft_id": 31,
            "version": 1,
            "title": "완성 제목",
            "body": "완성 본문",
            "source_snapshot_id": 17,
            "fact_pack_id": 8,
            "fact_pack_version": 2,
            "provider": "fake",
            "model": "fake-model",
            "prompt_version": "v2-complete",
            "quality": {
                "passed": True,
                "score": 100,
                "char_count": 2500,
                "target_chars": 2500,
                "paragraph_count": 10,
                "keyword_count": 3,
                "issues": [],
                "checks": {"length_ready": True},
                "repair_attempted": False,
            },
        }

    def get_draft(self, draft_id):
        if draft_id != 12:
            return None
        return {
            "draft_id": 12,
            "keyword": "테스트 주제",
            "title": "기존 제목",
            "versions": [
                {"version": 1, "title": "예전 제목", "body": "예전 본문"},
                {"version": 2, "title": "최신 제목", "body": "최신 본문 내용"},
            ],
        }


def make_service(*, sensitive=False):
    analyze = FakeAnalyze()
    drafts = FakeDrafts()
    service = BlogComposerService(
        analyze,
        FakeResearch(sensitive),
        FakeFactPacks(),
        lambda _use_llm: drafts,
    )
    return service, analyze, drafts


def test_compose_selects_standalone_plan_and_enforces_quality():
    service, analyze, drafts = make_service()

    result = service.compose(
        keyword="  테스트 주제  ",
        style="product",
        user_notes="직접 제공한 경험",
        target_chars=4000,
    )

    assert analyze.calls == 1
    assert drafts.plan_item["blog_type"] == "PRODUCT"
    assert drafts.plan_item["target_keyword"] == "테스트 주제"
    assert drafts.plan_item["title"] == "테스트 주제 비교와 구매 전 체크리스트"
    assert drafts.kwargs["user_notes"] == "직접 제공한 경험"
    assert drafts.kwargs["target_chars"] == 4000
    assert drafts.kwargs["enforce_quality"] is True
    assert drafts.kwargs["fact_pack_id"] is None
    assert drafts.kwargs["fact_pack_version"] is None
    assert drafts.questions == []
    assert result["suggested_tags"] == ["테스트주제", "연관키워드", "두번째키워드"]
    assert result["quality"]["passed"] is True


def test_compose_uses_latest_linked_draft_as_bounded_improvement_context():
    service, _analyze, drafts = make_service()

    service.compose(keyword="테스트 주제", user_notes="제목을 더 명확하게", source_draft_id=12)

    assert drafts.plan_item["source_draft_id"] == 12
    assert "제목을 더 명확하게" in drafts.kwargs["user_notes"]
    assert "최신 Draft" in drafts.kwargs["user_notes"]
    assert "최신 본문 내용" in drafts.kwargs["user_notes"]


def test_compose_rejects_wrong_source_draft_before_research():
    service, analyze, _drafts = make_service()

    with pytest.raises(ValueError, match="source draft not found"):
        service.compose(keyword="테스트 주제", source_draft_id=999)

    assert analyze.calls == 0


def test_followup_can_reference_another_topic_without_changing_original_draft():
    service, _analyze, drafts = make_service()
    service.compose(keyword="새 후속 주제", source_draft_id=12, source_draft_mode="followup")
    assert drafts.plan_item["source_draft_id"] == 12
    assert drafts.plan_item["source_draft_mode"] == "followup"
    assert "최신 본문 내용" in drafts.kwargs["user_notes"]


def test_revision_still_rejects_different_topic_before_research():
    service, analyze, _drafts = make_service()
    with pytest.raises(ValueError, match="does not belong"):
        service.compose(keyword="다른 주제", source_draft_id=12)
    assert analyze.calls == 0


@pytest.mark.parametrize("sensitive,allow", [(True, True), (None, False)])
def test_sensitive_preflight_blocks_before_analysis(sensitive, allow):
    service, analyze, _ = make_service(sensitive=sensitive)

    with pytest.raises(ValueError, match="민감 키워드"):
        service.compose(keyword="테스트", allow_sensitive_unknown=allow)

    assert analyze.calls == 0
