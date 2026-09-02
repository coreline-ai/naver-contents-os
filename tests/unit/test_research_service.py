from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import sessionmaker

from app.errors import RequestError
from app.db import make_engine
from app.models_db import Base
from app.services.research import ResearchService
from providers.models import KeywordMetric, SearchChannelResult, TrendPoint, TrendSeries


def sessions(tmp_path) -> sessionmaker:
    engine = make_engine(tmp_path / "research.db")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)


class FakeSearchAd:
    def __init__(self):
        self.related_calls = 0

    def get_related_keywords(self, keyword: str, **_kwargs):
        self.related_calls += 1
        rows = [KeywordMetric(keyword=keyword, monthly_pc_searches=100, monthly_mobile_searches=900)]
        rows.extend(
            KeywordMetric(
                keyword=f"{keyword}{index}",
                monthly_pc_searches=index,
                monthly_mobile_searches=index * 10,
                ad_competition="높음" if index % 2 else "낮음",
            )
            for index in range(1, 45)
        )
        return rows

    def estimate_average_position_bid(self, keywords, **_kwargs):
        return {"items": [{"keyword": keyword, "bid": 1200} for keyword in keywords]}

    def estimate_exposure_minimum_bid(self, keywords, **_kwargs):
        return {"items": [{"keyword": keyword, "bid": 300} for keyword in keywords]}

    def estimate_median_bid(self, keywords, **_kwargs):
        return {"items": [{"keyword": keyword, "bid": 800} for keyword in keywords]}

    def estimate_performance_bulk(self, items, **_kwargs):
        return {"items": [{"keyword": row["keyword"], "impCnt": 500, "clkCnt": 12} for row in items]}

    def list_campaigns(self, **_kwargs):
        return [{"nccCampaignId": "cmp-1"}]

    def list_adgroups(self, **_kwargs):
        return [{"nccAdgroupId": "grp-1"}]

    def list_keywords(self, _adgroup_id, **_kwargs):
        return [{"nccKeywordId": "kw-1", "keyword": "성과키워드"}]

    def get_stats(self, _ids, _since, _until, **_kwargs):
        return [{"id": "kw-1", "impCnt": 1000, "clkCnt": 30, "ctr": 3, "cpc": 500, "ccnt": 2, "ror": 180}]


class FakeHubSearch:
    def search(self, _channel, _keyword, **_kwargs):
        return SearchChannelResult(channel="blog", total=1234)

    def get_errata(self, _keyword, **_kwargs):
        return {"value": "교정어", "from_cache": False, "collected_at": "2026-09-02"}

    def is_adult(self, _keyword, **_kwargs):
        return {"value": True, "from_cache": False, "collected_at": "2026-09-02"}

    def search_local(self, _keyword, **_kwargs):
        return {"items": [{"title": "장소"}], "total": 1}

    def search_images(self, _keyword, **_kwargs):
        return {"items": [{"title": "사진", "link": "https://image"}], "total": 1}


class FakeTrend:
    def __init__(self):
        self.calls = 0

    def get_search_trends(self, groups, **filters):
        self.calls += 1
        return [
            TrendSeries(
                keyword_group=name,
                keywords=keywords,
                points=[TrendPoint(period="2026-07", ratio=20), TrendPoint(period="2026-08", ratio=70)],
                device=filters.get("device", ""),
                gender=filters.get("gender", ""),
                ages=filters.get("ages", []),
            )
            for name, keywords in groups
        ]

    def get_search_trend(self, keyword, **_kwargs):
        self.calls += 1
        return TrendSeries(
            keyword_group=keyword,
            keywords=[keyword],
            points=[TrendPoint(period="2026-07", ratio=20), TrendPoint(period="2026-08", ratio=70)],
        )


class FakeShopping:
    def get_keyword_trends(self, _category, keywords, **_kwargs):
        return [{"title": keywords[0], "points": [{"period": "2026-08", "ratio": 80}]}]


def make_service(tmp_path):
    searchad = FakeSearchAd()
    trend = FakeTrend()
    service = ResearchService(sessions(tmp_path), searchad, FakeHubSearch(), trend, FakeShopping())
    return service, searchad, trend


def test_graph_caps_calls_deduplicates_and_enriches(tmp_path):
    service, searchad, _ = make_service(tmp_path)
    graph = service.graph("테스트")
    assert graph["status"] == "ok"
    assert len(graph["nodes"]) <= 80
    assert searchad.related_calls == 6
    assert graph["call_budget"]["actual"] <= graph["call_budget"]["maximum"]
    assert len({node["id"] for node in graph["nodes"]}) == len(graph["nodes"])
    assert all(edge["source"] != edge["target"] for edge in graph["edges"])
    depths = {node["id"]: node["depth"] for node in graph["nodes"]}
    assert all(depths[edge["source"]] < depths[edge["target"]] for edge in graph["edges"])
    assert any(node["blog_total"] == 1234 for node in graph["nodes"])


def test_preflight_commercial_audience_and_specialized_semantics(tmp_path):
    service, _, trend = make_service(tmp_path)
    preflight = service.preflight("원문")
    assert preflight["correction"] == "교정어" and preflight["sensitive"] is True

    commercial = service.commercial(["러닝화"])
    row = commercial["rows"][0]
    assert row["median_bid"] == 800
    assert row["commercial_score"] is not None
    assert "합산하지" in commercial["score_note"]

    audience = service.audience("러닝화")
    assert len(audience["segments"]["device"]) == 2
    assert len(audience["segments"]["gender"]) == 2
    assert len(audience["segments"]["age"]) == 11
    assert trend.calls == 15
    assert audience["normalization"] == "independent"
    assert "인구 비중이 아닙니다" in audience["warning"]

    image = service.specialized("러닝화", "image")
    assert image["items"] and "권리를 확인" in image["rights_notice"]
    shopping = service.specialized("러닝화", "shopping", category="50000000")
    assert shopping["series"] and shopping["plan_candidates"] == ["제품 비교", "실사용 리뷰", "구매 가이드"]


def test_watchlist_is_manual_idempotent_and_only_compares_matching_snapshots(tmp_path):
    service, _, _ = make_service(tmp_path)
    first = service.add_watchlist("키워드")
    duplicate = service.add_watchlist("키워드")
    assert first["id"] == duplicate["id"]
    assert service.list_watchlist()["items"][0]["last_snapshot"] is None

    refreshed = service.refresh_watchlist([first["id"]])["items"][0]
    assert refreshed["status"] == "ok"
    assert refreshed["direction"] == "비교 불가"
    second = service.refresh_watchlist([first["id"]])["items"][0]
    assert second["direction"] == "보합" and second["delta"] == 0
    assert service.delete_watchlist(first["id"]) is True
    assert service.delete_watchlist(first["id"]) is False


def test_ad_performance_recommends_clicked_keyword_without_content(tmp_path):
    service, _, _ = make_service(tmp_path)
    result = service.ad_performance("2026-08-01", "2026-08-31")
    assert result["read_only"] is True
    assert result["rows"][0]["clicks"] == 30
    assert result["rows"][0]["content"]["state"] == "missing"
    assert result["recommendations"][0]["keyword"] == "성과키워드"


def test_unconfigured_providers_return_explicit_empty_states(tmp_path):
    service = ResearchService(sessions(tmp_path), None, None, None, None)
    assert service.graph("키워드")["status"] == "unconfigured"
    assert service.commercial(["키워드"])["status"] == "unconfigured"
    assert service.audience("키워드")["status"] == "unconfigured"
    assert service.ad_performance("2026-08-01", "2026-08-31")["read_only"] is True


def test_graph_preserves_provider_failure_as_top_level_status(tmp_path):
    class FailingSearchAd(FakeSearchAd):
        def get_related_keywords(self, keyword: str, **_kwargs):
            raise RequestError("bad request", provider="searchad")

    service = ResearchService(sessions(tmp_path), FailingSearchAd(), FakeHubSearch(), FakeTrend())
    graph = service.graph("키워드")
    assert graph["status"] == "request"
    assert len(graph["nodes"]) == 1
