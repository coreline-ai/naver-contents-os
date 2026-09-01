from planner.series import build_content_plan, infer_blog_type
from planner.types import BlogType
from providers.models import KeywordMetric, SearchItem, SearchLandscape


def metric(kw, vol, comp="낮음"):
    return KeywordMetric(
        keyword=kw, monthly_pc_searches=vol, monthly_mobile_searches=0, ad_competition=comp
    )


QUESTIONS = [
    {"text": "애드포스트 승인 조건이 뭔가요?", "kind": "question", "channel": "kin"},
    {"text": "애드포스트 승인 후기", "kind": "review", "channel": "cafe"},
]


def build(n=15):
    return build_content_plan(
        "애드포스트 승인",
        metric("애드포스트승인", 650),
        [metric("애드포스트승인조건", 900), metric("애드포스트수익", 4000), metric("애드포스트승인", 650)],
        SearchLandscape(keyword="애드포스트 승인", blog_total=69449, news_total=121,
                        news_items=[SearchItem(title="관련 뉴스")]),
        None,
        QUESTIONS,
        n=n,
    )


def test_blog_type_inference():
    assert infer_blog_type("애드포스트 승인 조건") == BlogType.POLICY
    assert infer_blog_type("에어랩 vs 다이슨 비교") == BlogType.COMPARISON
    assert infer_blog_type("한달 사용 후기") == BlogType.REVIEW
    assert infer_blog_type("블로그 시작") == BlogType.HOWTO


def test_plan_has_exactly_15_items_with_reasons_and_types():
    plan = build()
    assert len(plan) == 15
    assert [p["order"] for p in plan] == list(range(1, 16))
    assert all(p["reason"] and p["blog_type"] and p["target_keyword"] for p in plan)
    assert plan[0]["blog_type"] == BlogType.SERIES.value
    assert "월간 검색량 650" in plan[0]["reason"]
    assert "블로그 문서 69,449건" in plan[0]["reason"]


def test_plan_uses_real_questions_and_related_volume():
    plan = build()
    titles = [p["title"] for p in plan]
    assert "애드포스트 승인 조건이 뭔가요?" in titles
    reasons = " ".join(p["reason"] for p in plan)
    assert "지식iN" in reasons
    assert "월간 검색량 4,000" in reasons  # 애드포스트수익
    # main keyword itself is not duplicated as a related item
    assert sum(1 for p in plan if p["target_keyword"] == "애드포스트승인") == 0


def test_plan_is_deterministic():
    assert build() == build()


def test_series_links_are_chained():
    plan = build()
    assert plan[0]["series_prev"] is None
    assert plan[0]["series_next"] == 2
    assert plan[-1]["series_next"] is None
    assert plan[7]["series_prev"] == 7
