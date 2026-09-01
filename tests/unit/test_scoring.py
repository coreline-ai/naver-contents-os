from datetime import date

from intelligence.scoring import SCORE_VERSION, OpportunityScorer
from providers.models import KeywordMetric, SearchItem, SearchLandscape, TrendPoint, TrendSeries

TODAY = date(2026, 9, 1)


def make_metric(pc=1000, mobile=3000, masked=False):
    return KeywordMetric(
        keyword="애드포스트 승인",
        monthly_pc_searches=pc,
        monthly_mobile_searches=mobile,
        volume_masked=masked,
    )


def make_landscape(blog_total=30000, titles_dates=None):
    titles_dates = titles_dates if titles_dates is not None else [
        ("애드포스트 승인 조건 정리", "20260830"),
        ("애드포스트 후기", "20240101"),
        ("<b>애드포스트 승인</b> 방법", "20230515"),
    ]
    return SearchLandscape(
        keyword="애드포스트 승인",
        blog_total=blog_total,
        top_results=[SearchItem(title=t, posted_at=d) for t, d in titles_dates],
    )


def make_trend(ratios):
    return TrendSeries(
        keyword_group="애드포스트 승인",
        keywords=["애드포스트 승인"],
        points=[TrendPoint(period=f"2026-{i + 1:02d}-01", ratio=r) for i, r in enumerate(ratios)],
    )


def full_inputs():
    return dict(
        keyword="애드포스트 승인",
        metric=make_metric(),
        landscape=make_landscape(),
        trend=make_trend([10, 20, 30, 40, 60, 80]),
        serp=None,
        today=TODAY,
    )


def test_score_is_deterministic():
    scorer = OpportunityScorer()
    a = scorer.score(**full_inputs())
    b = scorer.score(**full_inputs())
    assert a == b
    assert a["score_version"] == SCORE_VERSION
    assert 0 <= a["value"] <= 100


def test_v1_declares_unavailable_components_missing():
    result = OpportunityScorer().score(**full_inputs())
    assert "top10_strength" in result["missing"]
    assert "intent_match" in result["missing"]
    by_name = {c["component"]: c for c in result["contributions"]}
    assert by_name["top10_strength"]["status"] == "missing"
    assert by_name["volume"]["status"] == "ok"


def test_missing_volume_stays_missing_and_weights_renormalize():
    inputs = full_inputs()
    inputs["metric"] = make_metric(pc=None, mobile=None, masked=True)
    result = OpportunityScorer().score(**inputs)
    by_name = {c["component"]: c for c in result["contributions"]}
    assert by_name["volume"]["status"] == "missing"
    assert by_name["volume"]["raw"] == "masked (< 10)"
    assert result["value"] is not None  # other components still score
    ok_points = [c["points"] for c in result["contributions"] if c["status"] == "ok"]
    assert abs(sum(ok_points) - result["value"]) < 0.5  # renormalized to ~100 scale


def test_all_missing_returns_none_value():
    result = OpportunityScorer().score("kw", None, None, None, today=TODAY)
    assert result["value"] is None
    assert len(result["missing"]) == len(result["contributions"])


def test_rising_trend_scores_higher_than_falling():
    scorer = OpportunityScorer()
    rising = full_inputs()
    rising["trend"] = make_trend([10, 20, 30, 60, 80, 100])
    falling = full_inputs()
    falling["trend"] = make_trend([100, 80, 60, 30, 20, 10])
    assert scorer.score(**rising)["value"] > scorer.score(**falling)["value"]


def test_freshness_and_exact_title_from_landscape():
    result = OpportunityScorer().score(**full_inputs())
    by_name = {c["component"]: c for c in result["contributions"]}
    # 2 of 3 dates older than a year (normalized is rounded to 4 decimals)
    assert by_name["top10_freshness"]["status"] == "ok"
    assert abs(by_name["top10_freshness"]["normalized"] - 2 / 3) < 1e-3
    # 2 of 3 titles contain the exact (space-insensitive) keyword -> 1 - 2/3
    assert abs(by_name["exact_title_ratio"]["normalized"] - (1 - 2 / 3)) < 1e-3


def test_short_trend_series_is_missing_not_zero():
    inputs = full_inputs()
    inputs["trend"] = make_trend([50, 60])
    result = OpportunityScorer().score(**inputs)
    by_name = {c["component"]: c for c in result["contributions"]}
    assert by_name["trend"]["status"] == "missing"
