"""Regression cases found by the independent performance review (offline)."""
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import select

from app.db import make_engine, make_session_factory
from app.models_db import Base, ContentPerformanceSnapshot, Draft, Keyword, KeywordSnapshot, PerformanceRecommendation, PublishedContent
from app.services import performance
from app.services.performance import PerformanceService


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setattr(performance, "_utcnow", lambda: datetime(2026, 9, 6, tzinfo=timezone.utc))
    engine = make_engine(tmp_path / "review.db")
    Base.metadata.create_all(engine)
    return PerformanceService(make_session_factory(engine))


def channel(service, source="creator_advisor"):
    return service.create_channel(source=source, display_name="검증 채널")["id"]


def ingest(service, channel_id, rows, **overrides):
    args = dict(channel_id=channel_id, source="creator_advisor", data_kind="content_performance",
                period_start=date(2026, 8, 24), period_end=date(2026, 8, 30), grain="weekly", rows=rows)
    return service.create_import(**(args | overrides))


def test_distinct_title_only_posts_are_not_collapsed(service):
    cid = channel(service)
    ingest(service, cid, [{"title": "여행 준비", "views": 10}, {"title": "맛집 탐방", "views": 20}])
    assert {item["title"] for item in service.contents()["items"]} == {"여행 준비", "맛집 탐방"}


def test_summary_uses_all_batches_in_same_scope_and_preserves_missing(service):
    cid = channel(service)
    ingest(service, cid, [{"canonical_url": "https://example.com/a", "impressions": 100, "inflows": 10}])
    ingest(service, cid, [{"canonical_url": "https://example.com/b", "impressions": 300}])
    summary = service.overview()["creator"]
    assert summary["row_count"] == 2
    assert summary["metrics"]["impressions"] == 400
    assert summary["metrics"]["inflows"] is None
    assert summary["metrics"]["ctr"] is None
    assert summary["metrics"]["views"] is None
    assert summary["status"] == "partial"


def test_pending_values_are_not_measured_zero(service):
    ingest(service, channel(service), [{"title": "반영 전", "impressions": 0, "inflows": 0, "data_state": "pending"}])
    summary = service.overview()["creator"]
    assert summary["metrics"]["impressions"] is None
    assert summary["status"] == "pending"


def test_average_rank_is_impression_weighted(service):
    ingest(service, channel(service), [
        {"canonical_url": "https://example.com/a", "impressions": 100, "average_rank": 10},
        {"canonical_url": "https://example.com/b", "impressions": 900, "average_rank": 2},
    ])
    assert service.overview()["creator"]["metrics"]["average_rank"] == 2.8


@pytest.mark.parametrize("start,end,grain", [
    (date(2026, 8, 23), date(2026, 8, 23), "daily"),
    (date(2026, 8, 1), date(2026, 8, 23), "weekly"),
    (date(2026, 8, 10), date(2026, 8, 16), "weekly"),
])
def test_non_comparable_periods_do_not_produce_deltas_or_rank_decline(service, start, end, grain):
    cid = channel(service)
    row = {"canonical_url": "https://example.com/a", "impressions": 100, "inflows": 10, "average_rank": 2}
    ingest(service, cid, [row], period_start=start, period_end=end, grain=grain)
    ingest(service, cid, [row | {"average_rank": 8}])
    assert service.contents()["items"][0]["previous_metrics"] is None
    assert service.overview()["creator"]["previous_metrics"] is None
    assert not any(r["rule_code"] == "rank_drop_or_stale" for r in service.recommendations()["items"])


def test_query_growth_never_compares_different_posts(service):
    cid = channel(service)
    ingest(service, cid, [{"query": "여행", "canonical_url": "https://example.com/a", "inflows": 10}],
           data_kind="query_performance", period_start=date(2026, 8, 17), period_end=date(2026, 8, 23))
    ingest(service, cid, [{"query": "여행", "canonical_url": "https://example.com/b", "inflows": 50}],
           data_kind="query_performance")
    assert service.recommendations()["items"] == []


@pytest.mark.parametrize("pc", ["< 10", None])
def test_masked_market_searches_are_not_numeric_totals(service, pc):
    with service._sessions() as session:
        keyword = Keyword(text="검증 여행")
        session.add(keyword)
        session.flush()
        session.add(KeywordSnapshot(keyword_id=keyword.id, payload={"metric": {
            "monthly_pc_searches": pc, "monthly_mobile_searches": 1500}}))
        session.flush()
        assert service._market_context(session, keyword.id)["searchad"]["monthly_searches"] is None


def test_improved_period_supersedes_old_action_without_deleting_history(service):
    cid = channel(service)
    row = {"canonical_url": "https://example.com/a", "impressions": 1000, "inflows": 1}
    ingest(service, cid, [row])
    assert service.recommendations()["items"]
    ingest(service, cid, [row | {"inflows": 100}], period_start=date(2026, 8, 31), period_end=date(2026, 9, 6))
    assert service.recommendations()["items"] == []


def test_old_action_expires_on_read_without_an_import(service, monkeypatch):
    ingest(service, channel(service), [{"title": "만료", "impressions": 1000, "inflows": 1}])
    assert service.recommendations()["items"]
    monkeypatch.setattr(performance, "_utcnow", lambda: datetime(2027, 1, 1, tzinfo=timezone.utc))
    assert service.recommendations()["items"] == []


def test_archived_publication_does_not_stay_in_action_queue(service):
    cid = channel(service)
    with service._sessions() as session:
        keyword = Keyword(text="보관 여행")
        session.add(keyword)
        session.flush()
        post = PublishedContent(keyword_id=keyword.id, title="보관 글", canonical_url="https://example.com/a",
                                published_at=performance._utcnow())
        session.add(post)
        session.commit()
        post_id = post.id
    ingest(service, cid, [{"canonical_url": "https://example.com/a", "impressions": 1000, "inflows": 1}])
    with service._sessions() as session:
        session.get(PublishedContent, post_id).archived_at = performance._utcnow()
        session.commit()
    assert service.recommendations()["items"] == []


def test_tracking_parameter_boundaries_and_store_identity_cannot_collide(service):
    channel(service, "biz_advisor")
    common = dict(destination_url="https://smartstore.naver.com/shop/products/1")
    variants = [dict(nt_source="a.b", nt_medium="c"), dict(nt_source="a", nt_medium="b.c"),
                dict(nt_source="a", nt_medium="b", nt_detail="c"),
                dict(nt_source="a", nt_medium="b", nt_keyword="c"),
                dict(nt_source="a.b", nt_medium="c", destination_url="https://smartstore.naver.com/other/products/1")]
    ids = [service.build_tracking_link(**(common | item))["tracking_id"] for item in variants]
    assert len(set(ids)) == len(ids)
    long = service.build_tracking_link(**common, nt_source="a" * 100, nt_medium="b" * 100)
    assert len(long["tracking_id"]) <= 100


def test_pending_previous_snapshot_cannot_drive_query_growth(service):
    cid = channel(service)
    ingest(service, cid, [{"query": "여행", "inflows": 10, "data_state": "pending"}],
           data_kind="query_performance", period_start=date(2026, 8, 17), period_end=date(2026, 8, 23))
    ingest(service, cid, [{"query": "여행", "inflows": 50}], data_kind="query_performance")
    assert service.recommendations()["items"] == []


def test_legacy_title_dedupe_key_does_not_duplicate_existing_data(service):
    cid = channel(service)
    args = [{"title": "기존 원고", "views": 10}]
    first = ingest(service, cid, args)
    with service._sessions() as session:
        row = session.scalar(select(ContentPerformanceSnapshot))
        row.dedupe_key = performance._hash_payload({"channel_id": cid, "kind": "content_performance",
            "period_start": "2026-08-24", "period_end": "2026-08-30", "grain": "weekly", "target": "publication:None"})
        session.commit()
    assert ingest(service, cid, [{"title": "기존 원고", "views": 20}])["id"] == first["id"]
    assert len(service.contents()["items"]) == 1


def test_previous_summary_requires_same_target_coverage(service):
    cid = channel(service)
    ingest(service, cid, [{"canonical_url": "https://example.com/a", "impressions": 100}],
           period_start=date(2026, 8, 17), period_end=date(2026, 8, 23))
    ingest(service, cid, [{"canonical_url": "https://example.com/b", "impressions": 1000}])
    assert service.overview()["creator"]["previous_metrics"] is None


def test_old_calculation_is_hidden_and_explicit_duplicate_import_rebuilds_it(service):
    cid = channel(service)
    rows = [{"title": "계산 갱신", "impressions": 1000, "inflows": 1}]
    first = ingest(service, cid, rows)
    with service._sessions() as session:
        old = session.scalar(select(PerformanceRecommendation))
        old.calculation_version = "obsolete"
        old.recommendation_key = "old-key"
        session.commit()
    assert service.recommendations()["items"] == []
    assert ingest(service, cid, rows)["id"] == first["id"]
    assert len(service.recommendations()["items"]) == 1
    assert service.recommendations()["items"][0]["calculation_version"] == performance.CALCULATION_VERSION


@pytest.mark.parametrize("status", ["done", "dismissed"])
def test_recalculation_preserves_the_users_existing_decision(service, status):
    cid = channel(service)
    rows = [{"title": "결정 보존", "impressions": 1000, "inflows": 1}]
    ingest(service, cid, rows)
    with service._sessions() as session:
        old = session.scalar(select(PerformanceRecommendation))
        old.calculation_version = "obsolete"
        old.recommendation_key = "old-key"
        old.status = status
        session.commit()
    ingest(service, cid, rows)
    assert service.recommendations()["items"] == []
    assert any(item["calculation_version"] == performance.CALCULATION_VERSION
               for item in service.recommendations(status=status)["items"])


def test_today_work_applies_the_same_expiry_and_supersession_rules(service):
    from app.services.work import TodayWorkService
    cid = channel(service)
    rows = [{"title": "대기열 검증", "impressions": 1000, "inflows": 1}]
    ingest(service, cid, rows)
    work = TodayWorkService(service._sessions, now=performance._utcnow)
    assert any(item["source_type"] == "performance_recommendation" for item in work.list(limit=3)["items"])
    ingest(service, cid, [rows[0] | {"inflows": 100}], period_start=date(2026, 8, 31), period_end=date(2026, 9, 6))
    assert not any(item["source_type"] == "performance_recommendation" for item in work.list(limit=3)["items"])


def publication(service, url="https://example.com/owned"):
    with service._sessions() as session:
        keyword = Keyword(text=url)
        session.add(keyword)
        session.flush()
        post = PublishedContent(keyword_id=keyword.id, title="검증 게시물", canonical_url=url, published_at=performance._utcnow())
        session.add(post)
        session.commit()
        return post.id


def test_explicit_publication_id_cannot_claim_an_unregistered_conflicting_url(service):
    cid = channel(service)
    pid = publication(service)
    with pytest.raises(ValueError, match="conflicts"):
        ingest(service, cid, [{"published_content_id": pid, "canonical_url": "https://example.com/not-owned", "views": 1}])


def test_manual_mapping_cannot_change_the_identity_of_a_known_url(service):
    cid = channel(service)
    pid = publication(service)
    ingest(service, cid, [{"canonical_url": "https://example.com/not-owned", "views": 1}])
    snapshot = service.contents()["items"][0]
    with pytest.raises(ValueError, match="conflicts"):
        service.map_content_snapshot(snapshot["id"], pid)
    assert service.contents()["items"][0]["published_content_id"] is None


def test_tracking_import_cannot_override_a_different_linked_publication(service):
    cid = channel(service, "biz_advisor")
    first = publication(service)
    other = publication(service, "https://example.com/other")
    link = service.build_tracking_link(destination_url="https://smartstore.naver.com/shop/products/1",
                                       nt_source="test", nt_medium="blog", published_content_id=first)
    with pytest.raises(ValueError, match="conflicts"):
        ingest(service, cid, [{"tracking_id": link["tracking_id"], "published_content_id": other, "orders": 1}],
               source="biz_advisor", data_kind="commerce_attribution")


@pytest.mark.parametrize("existing_before_import", [True, False])
def test_existing_followup_draft_suppresses_repeated_new_article_actions(service, existing_before_import):
    cid = channel(service)
    def add_followup():
        with service._sessions() as session:
            keyword = Keyword(text="여행 후속")
            session.add(keyword)
            session.flush()
            session.add(Draft(keyword_id=keyword.id, title="이미 작성한 후속 글", blog_type="HOWTO"))
            session.commit()
    if existing_before_import:
        add_followup()
    ingest(service, cid, [{"query": "여행 후속", "inflows": 10}], data_kind="query_performance",
           period_start=date(2026, 8, 17), period_end=date(2026, 8, 23))
    ingest(service, cid, [{"query": "여행 후속", "inflows": 50}], data_kind="query_performance")
    if not existing_before_import:
        assert service.recommendations()["items"]
        add_followup()
    assert service.recommendations()["items"] == []
