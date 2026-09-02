from __future__ import annotations

from datetime import date, timedelta

from app.services.freshness import combine_freshness, comparison_window, summarize_news, summarize_trend


TODAY = date(2026, 9, 3)


def points(previous: float, recent: float, *, count: int = 14):
    window = comparison_window(TODAY)
    rows = []
    for index in range(count):
        period = window["start_date"] + timedelta(days=index)
        rows.append({"period": period.isoformat(), "ratio": previous if index < 7 else recent})
    return rows


def test_completed_kst_window_and_growth_boundaries():
    window = comparison_window(TODAY)
    assert window == {
        "start_date": date(2026, 8, 20),
        "recent_start": date(2026, 8, 27),
        "end_date": date(2026, 9, 2),
    }
    result = summarize_trend(points(10, 20), today=TODAY)
    assert result["recent7_avg"] == 20
    assert result["previous7_avg"] == 10
    assert result["growth_rate"] == 100
    assert result["direction"] == "rising"
    assert result["trend_score"] == 50


def test_new_zero_and_missing_periods_are_not_infinite_or_fabricated():
    emerging = summarize_trend(points(0, 35), today=TODAY)
    assert emerging["direction"] == "new"
    assert emerging["growth_rate"] is None
    assert emerging["trend_score"] == 35

    zero = summarize_trend(points(0, 0), today=TODAY)
    assert zero["direction"] == "steady" and zero["growth_rate"] == 0

    insufficient = summarize_trend(points(10, 20, count=11), today=TODAY)
    assert insufficient["direction"] == "insufficient"
    assert insufficient["trend_score"] is None
    assert insufficient["coverage"]["observed_days"] == 11


def test_news_sample_dedupes_links_and_reports_cap():
    rows = [
        {
            "title": f"기사 {index}",
            "original_link": f"https://news.example/{index}?tracking=1",
            "published_at": "Wed, 02 Sep 2026 12:00:00 +0900",
        }
        for index in range(100)
    ]
    result = summarize_news(rows, today=TODAY)
    assert result["news_7d_sample_count"] == 100
    assert result["sample_capped"] is True
    assert result["news_volume_score"] == 100
    assert result["latest_news_at"].startswith("2026-09-02T12:00:00")

    duplicate = summarize_news(
        [rows[0], {**rows[0], "original_link": "https://news.example/0?other=2"}],
        today=TODAY,
    )
    assert duplicate["news_7d_sample_count"] == 1


def test_freshness_requires_both_signals_and_exposes_confidence():
    trend = summarize_trend(points(10, 30), today=TODAY)
    news = summarize_news(
        [{
            "title": "최신 기사",
            "link": "https://news.example/latest",
            "published_at": "Wed, 02 Sep 2026 20:00:00 +0900",
        }],
        today=TODAY,
    )
    complete = combine_freshness(trend, news, mode="general", volume_masked=False)
    assert complete["freshness_score"] is not None
    assert complete["confidence"] == "high"
    assert complete["components"]["trend_weight"] == 0.65

    partial = combine_freshness(trend, None, mode="news", volume_masked=False)
    assert partial["freshness_score"] is None
    assert partial["confidence"] == "unavailable"
    assert partial["components"]["reason"] == "news_unavailable"
