from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.db import make_engine, make_session_factory
from app.models_db import (
    Base,
    CommerceAttributionSnapshot,
    ContentPerformanceSnapshot,
    Keyword,
    KeywordSnapshot,
    PerformanceImportRun,
    PerformanceTrackingLink,
    PublishedContent,
)
from app.services.performance import PerformanceService


@pytest.fixture
def sessions(tmp_path):
    engine = make_engine(tmp_path / "performance.db")
    Base.metadata.create_all(engine)
    return make_session_factory(engine)


@pytest.fixture
def service(sessions, monkeypatch):
    from app.services import performance
    monkeypatch.setattr(performance, "_utcnow", lambda: datetime(2026, 9, 6, tzinfo=timezone.utc))
    return PerformanceService(sessions)


def _channel(service, source="creator_advisor", name="내 블로그", site_url=None):
    return service.create_channel(
        source=source,
        display_name=name,
        site_url=site_url,
        ownership_confirmed=source == "search_advisor",
    )


def _content_import(service, channel_id, start, end, rows):
    return service.create_import(
        channel_id=channel_id,
        source="creator_advisor",
        data_kind="content_performance",
        period_start=start,
        period_end=end,
        grain="weekly",
        rows=rows,
    )


def test_preview_normalizes_ctr_and_preserves_zero_state_without_raw_payload(service):
    channel = _channel(service)
    preview = service.preview_import(
        channel_id=channel["id"],
        source="creator_advisor",
        data_kind="content_performance",
        period_start=date(2026, 8, 24),
        period_end=date(2026, 8, 30),
        grain="weekly",
        rows=[
            {
                "canonical_url": "HTTPS://BLOG.NAVER.COM/me/1/#fragment",
                "title": "테스트 글",
                "views": 0,
                "impressions": 100,
                "inflows": 4,
                "ctr": 99,
                "average_rank": 5,
                "likes": 0,
                "comments": 0,
            }
        ],
    )
    row = preview["rows"][0]
    assert row["canonical_url"] == "https://blog.naver.com/me/1"
    assert row["ctr"] == 4.0
    assert row["data_state"] == "ready"
    assert preview["warnings"] == ["1행 CTR을 노출·유입 기준으로 다시 계산했습니다."]
    assert "raw" not in preview

    zero = service.preview_import(
        channel_id=channel["id"],
        source="creator_advisor",
        data_kind="query_performance",
        period_start=date(2026, 8, 24),
        period_end=date(2026, 8, 30),
        grain="weekly",
        rows=[{"query": "제로 검색어", "impressions": 0, "inflows": 0, "ctr": 0, "average_rank": 0}],
    )
    assert zero["rows"][0]["data_state"] == "observed_zero"


def test_import_is_idempotent_and_overlapping_target_is_not_duplicated(service, sessions):
    channel = _channel(service)
    args = dict(
        channel_id=channel["id"],
        start=date(2026, 8, 24),
        end=date(2026, 8, 30),
        rows=[{"title": "같은 글", "impressions": 200, "inflows": 10}],
    )
    first = _content_import(service, **args)
    second = _content_import(service, **args)
    assert first["id"] == second["id"]
    assert second["duplicate"] is True

    changed = _content_import(
        service,
        channel["id"],
        date(2026, 8, 24),
        date(2026, 8, 30),
        [{"title": "같은 글", "impressions": 300, "inflows": 12}],
    )
    assert changed["id"] == first["id"]
    assert changed["duplicate"] is True
    assert "중복 저장하지 않았습니다" in changed["warnings"][-1]
    with sessions() as session:
        assert session.scalar(select(func.count(ContentPerformanceSnapshot.id))) == 1
        assert session.scalar(select(func.count(PerformanceImportRun.id))) == 1


def test_invalid_later_row_rolls_back_entire_import(service, sessions):
    channel = _channel(service)
    with pytest.raises(ValueError, match="must not be negative"):
        _content_import(
            service,
            channel["id"],
            date(2026, 8, 24),
            date(2026, 8, 30),
            [
                {"title": "정상 행", "impressions": 100, "inflows": 1},
                {"title": "오류 행", "impressions": -1, "inflows": 0},
            ],
        )
    with sessions() as session:
        assert session.scalar(select(func.count(PerformanceImportRun.id))) == 0
        assert session.scalar(select(func.count(ContentPerformanceSnapshot.id))) == 0


def test_duplicate_targets_in_one_import_are_rejected_before_storage(service, sessions):
    channel = _channel(service)
    with pytest.raises(ValueError, match="duplicate target"):
        _content_import(
            service,
            channel["id"],
            date(2026, 8, 24),
            date(2026, 8, 30),
            [
                {"title": "중복 글", "impressions": 100, "inflows": 1},
                {"title": "중복 글", "impressions": 120, "inflows": 2},
            ],
        )
    with sessions() as session:
        assert session.scalar(select(func.count(PerformanceImportRun.id))) == 0


def test_old_performance_period_does_not_create_actionable_recommendation(service):
    channel = _channel(service)
    _content_import(
        service,
        channel["id"],
        date(2025, 1, 1),
        date(2025, 1, 7),
        [{"title": "오래된 성과", "impressions": 1000, "inflows": 1}],
    )
    assert service.recommendations()["items"] == []


def test_creator_recommendations_mapping_and_market_context_are_explainable(service, sessions):
    channel = _channel(service)
    with sessions() as session:
        keyword = Keyword(text="후쿠오카 여행")
        session.add(keyword)
        session.flush()
        publication = PublishedContent(
            keyword_id=keyword.id,
            canonical_url="https://blog.naver.com/me/fukuoka",
            title="후쿠오카 여행기",
            published_at=datetime.now(timezone.utc) - timedelta(days=120),
        )
        session.add(publication)
        session.add(
            KeywordSnapshot(
                keyword_id=keyword.id,
                payload={
                    "metric": {
                        "monthly_pc_searches": 500,
                        "monthly_mobile_searches": 1500,
                    },
                    "trend": {"points": [{"period": "2026-08-01", "ratio": 80}]},
                },
            )
        )
        session.flush()
        publication_id = publication.id
        session.commit()

    _content_import(
        service,
        channel["id"],
        date(2026, 8, 17),
        date(2026, 8, 23),
        [{"canonical_url": "https://blog.naver.com/me/fukuoka", "impressions": 800, "inflows": 40, "average_rank": 4}],
    )
    _content_import(
        service,
        channel["id"],
        date(2026, 8, 24),
        date(2026, 8, 30),
        [{"canonical_url": "https://blog.naver.com/me/fukuoka", "impressions": 600, "inflows": 6, "average_rank": 8}],
    )

    contents = service.contents()["items"]
    assert contents[0]["published_content_id"] == publication_id
    assert contents[0]["metrics"]["ctr"] == 1.0
    assert contents[0]["previous_metrics"]["average_rank"] == 4.0
    assert contents[0]["market"]["searchad"]["monthly_searches"] == 2000
    assert contents[0]["market"]["trend"]["latest_ratio"] == 80
    assert contents[0]["market"]["searchad"]["source"] == "SEARCH_AD"

    recommendations = service.recommendations()["items"]
    assert {item["rule_code"] for item in recommendations} >= {
        "high_impressions_low_ctr",
        "rank_drop_or_stale",
    }
    assert all(item["calculation_version"] == "performance-v2" for item in recommendations)
    assert all(item["evidence"]["sources_combined"] is False for item in recommendations)


def test_content_mapping_never_guesses_and_rejects_explicit_url_conflicts(service, sessions):
    channel = _channel(service)
    with sessions() as session:
        keyword = Keyword(text="매핑 테스트")
        session.add(keyword)
        session.flush()
        first = PublishedContent(
            keyword_id=keyword.id,
            canonical_url="https://blog.naver.com/me/mapping-1",
            title="첫 글",
            published_at=datetime.now(timezone.utc),
        )
        second = PublishedContent(
            keyword_id=keyword.id,
            canonical_url="https://blog.naver.com/me/mapping-2",
            title="둘째 글",
            published_at=datetime.now(timezone.utc),
        )
        session.add_all([first, second])
        session.flush()
        first_id, second_id = first.id, second.id
        session.commit()

    preview = service.preview_import(
        channel_id=channel["id"], source="creator_advisor", data_kind="content_performance",
        period_start=date(2026, 8, 24), period_end=date(2026, 8, 30), grain="weekly",
        rows=[{"title": "제목만 같을 수 있는 글", "impressions": 1}],
    )
    assert preview["rows"][0]["published_content_id"] is None

    matched = service.preview_import(
        channel_id=channel["id"], source="creator_advisor", data_kind="content_performance",
        period_start=date(2026, 8, 24), period_end=date(2026, 8, 30), grain="weekly",
        rows=[{"canonical_url": "https://blog.naver.com/me/mapping-1", "impressions": 1}],
    )
    assert matched["rows"][0]["published_content_id"] == first_id

    with pytest.raises(ValueError, match="conflicts"):
        service.preview_import(
            channel_id=channel["id"], source="creator_advisor", data_kind="content_performance",
            period_start=date(2026, 8, 24), period_end=date(2026, 8, 30), grain="weekly",
            rows=[{
                "canonical_url": "https://blog.naver.com/me/mapping-1",
                "published_content_id": second_id,
                "impressions": 1,
            }],
        )


def test_rising_query_creates_followup_only_with_comparable_previous_period(service):
    channel = _channel(service)
    common = {
        "channel_id": channel["id"],
        "source": "creator_advisor",
        "data_kind": "query_performance",
        "grain": "weekly",
    }
    service.create_import(
        **common,
        period_start=date(2026, 8, 17),
        period_end=date(2026, 8, 23),
        rows=[{"query": "후쿠오카 맛집", "impressions": 100, "inflows": 10}],
    )
    service.create_import(
        **common,
        period_start=date(2026, 8, 24),
        period_end=date(2026, 8, 30),
        rows=[{"query": "후쿠오카 맛집", "impressions": 200, "inflows": 20}],
    )
    rows = service.recommendations()["items"]
    followup = next(row for row in rows if row["rule_code"] == "rising_query_followup")
    assert followup["action"] == "create_followup"
    assert followup["confidence"] == "medium"


def test_commerce_and_search_advisor_stay_separate_and_reject_private_or_wrong_scope(service):
    commerce = _channel(service, "biz_advisor", "내 스토어")
    with pytest.raises(ValueError, match="confirm that you own"):
        service.create_channel(
            source="search_advisor",
            display_name="미확인 사이트",
            site_url="https://example.org",
        )
    website = _channel(service, "search_advisor", "회사 사이트", "https://example.com")
    with pytest.raises(ValueError, match="independently owned"):
        _channel(service, "search_advisor", "네이버 블로그", "https://blog.naver.com/me")

    service.create_import(
        channel_id=commerce["id"],
        source="biz_advisor",
        data_kind="commerce_attribution",
        period_start=date(2026, 8, 24),
        period_end=date(2026, 8, 30),
        grain="weekly",
        rows=[{"tracking_id": "naver.blog.social", "inflows": 100, "product_views": 80, "orders": 4, "attributed_revenue": 120000}],
    )
    service.create_import(
        channel_id=website["id"],
        source="search_advisor",
        data_kind="site_performance",
        period_start=date(2026, 8, 1),
        period_end=date(2026, 8, 30),
        grain="monthly",
        rows=[{"page_url": "https://example.com/guide", "collected_pages": 3, "indexed_pages": 2, "impressions": 500, "clicks": 20}],
    )
    overview = service.overview()
    assert overview["commerce"]["source"] == "biz_advisor"
    assert overview["commerce"]["metrics"]["conversion_rate"] == 4.0
    assert overview["website"]["source"] == "search_advisor"
    assert overview["website"]["metrics"]["ctr"] == 4.0
    assert overview["sources_combined"] is False

    with pytest.raises(ValueError, match="configured website"):
        service.preview_import(
            channel_id=website["id"], source="search_advisor", data_kind="site_performance",
            period_start=date(2026, 8, 1), period_end=date(2026, 8, 30), grain="monthly",
            rows=[{"page_url": "https://attacker.example/path", "impressions": 1}],
        )
    with pytest.raises(ValueError, match="90 days or fewer"):
        service.preview_import(
            channel_id=website["id"], source="search_advisor", data_kind="site_performance",
            period_start=date(2026, 1, 1), period_end=date(2026, 4, 1), grain="monthly",
            rows=[{"page_url": "https://example.com/guide", "impressions": 1}],
        )


def test_tracking_link_preserves_query_replaces_nt_values_and_validates_rules(service, sessions):
    with pytest.raises(ValueError, match="enabled SmartStore"):
        service.build_tracking_link(
            destination_url="https://smartstore.naver.com/shop/products/1",
            nt_source="naver.blog",
            nt_medium="social",
        )
    _channel(service, "biz_advisor", "추적 스토어")
    result = service.build_tracking_link(
        destination_url="https://m.smartstore.naver.com/shop/products/1?utm_source=old&nt_source=replace#frag",
        nt_source="naver.blog",
        nt_medium="social",
        nt_detail="sence4u",
        nt_keyword="후쿠오카여행",
    )
    assert result["url"].count("?") == 1
    assert "utm_source=old" in result["url"]
    assert result["url"].count("nt_source=") == 1
    assert "nt_source=naver.blog" in result["url"]
    assert "%ED%9B%84%EC%BF%A0%EC%98%A4%EC%B9%B4%EC%97%AC%ED%96%89" in result["url"]
    assert "직접 매출" in result["attribution_note"]
    assert result["id"] > 0

    with sessions() as session:
        stored = session.scalar(
            select(PerformanceTrackingLink).where(
                PerformanceTrackingLink.tracking_id == result["tracking_id"]
            )
        )
        assert stored is not None
        assert stored.destination_url == result["url"]

    with pytest.raises(ValueError, match="SmartStore"):
        service.build_tracking_link(
            destination_url="https://evil.example/redirect", nt_source="naver.blog", nt_medium="social"
        )
    with pytest.raises(ValueError, match="nt_source"):
        service.build_tracking_link(
            destination_url="https://smartstore.naver.com/shop", nt_source="한글", nt_medium="social"
        )
    with pytest.raises(ValueError, match="nt_medium"):
        service.build_tracking_link(
            destination_url="https://smartstore.naver.com/shop", nt_source="naver.blog", nt_medium="bad value"
        )


def test_tracking_link_maps_later_aggregate_to_published_content(service, sessions):
    channel = _channel(service, "biz_advisor", "연결 스토어")
    with sessions() as session:
        keyword = Keyword(text="스토어 연결")
        session.add(keyword)
        session.flush()
        publication = PublishedContent(
            keyword_id=keyword.id,
            canonical_url="https://blog.naver.com/me/store-link",
            title="스토어 연결 글",
            published_at=datetime.now(timezone.utc),
        )
        session.add(publication)
        session.flush()
        publication_id = publication.id
        session.commit()

    link = service.build_tracking_link(
        destination_url="https://smartstore.naver.com/shop/products/2",
        nt_source="naver.blog",
        nt_medium="social",
        nt_detail="post-2",
        published_content_id=publication_id,
    )
    service.create_import(
        channel_id=channel["id"],
        source="biz_advisor",
        data_kind="commerce_attribution",
        period_start=date(2026, 8, 24),
        period_end=date(2026, 8, 30),
        grain="weekly",
        rows=[{"tracking_id": link["tracking_id"], "inflows": 10, "orders": 1}],
    )
    with sessions() as session:
        snapshot = session.scalar(select(CommerceAttributionSnapshot))
        assert snapshot is not None
        assert snapshot.published_content_id == publication_id


def test_scoped_reads_never_mix_channels_or_accept_a_foreign_import(service):
    a, b = _channel(service, name="채널 A"), _channel(service, name="채널 B")
    start, end = date(2026, 8, 24), date(2026, 8, 30)
    ra = _content_import(service, a["id"], start, end, [{"title": "A 원고", "impressions": 100, "inflows": 1}])
    rb = _content_import(service, b["id"], start, end, [{"title": "B 원고", "impressions": 900, "inflows": 9}])
    assert service.overview(channel_id=a["id"])["creator"]["metrics"]["impressions"] == 100
    assert service.overview(channel_id=b["id"])["creator"]["metrics"]["impressions"] == 900
    assert [i["title"] for i in service.contents(channel_id=a["id"])["items"]] == ["A 원고"]
    assert [i["id"] for i in service.list_imports(channel_id=a["id"])["items"]] == [ra["id"]]
    assert all(i["channel_id"] == a["id"] for i in service.recommendations(channel_id=a["id"])["items"])
    with pytest.raises(ValueError):
        service.contents(channel_id=a["id"], import_id=rb["id"])
    with pytest.raises(ValueError):
        service.overview(channel_id=a["id"], import_id=rb["id"])
    assert service.overview(channel_id=9999)["creator"] is None
    assert service.contents(channel_id=9999)["items"] == []


def test_selected_overview_period_stays_in_its_scope_and_disabled_channel_stays_empty(service):
    channel = _channel(service)
    old = _content_import(service, channel["id"], date(2026,8,17), date(2026,8,23), [{"title":"같은 글", "impressions": 100}])
    _content_import(service, channel["id"], date(2026,8,24), date(2026,8,30), [{"title":"같은 글", "impressions": 300}])
    assert service.overview(channel_id=channel["id"])["creator"]["metrics"]["impressions"] == 300
    selected = service.overview(channel_id=channel["id"], import_id=old["id"])
    assert selected["creator"]["metrics"]["impressions"] == 100
    assert selected["creator"]["period"]["end"] == "2026-08-23"
    service.update_channel(channel["id"], enabled=False)
    assert service.overview(channel_id=channel["id"], import_id=old["id"])["creator"] is None
    assert service.contents(channel_id=channel["id"])["items"] == []
    assert service.recommendations(channel_id=channel["id"])["items"] == []


def test_query_filters_use_the_channel_and_reject_other_channel_imports(service):
    channels = [_channel(service, name=n) for n in ["A", "B"]]
    runs = [service.create_import(channel_id=c["id"], source="creator_advisor", data_kind="query_performance", period_start=date(2026,8,24), period_end=date(2026,8,30), grain="weekly", rows=[{"query": name,"impressions":200,"inflows":1}]) for c, name in zip(channels, ["A 검색어", "B 검색어"])]
    assert [i["query"] for i in service.queries(channel_id=channels[0]["id"])["items"]] == ["A 검색어"]
    with pytest.raises(ValueError):
        service.queries(channel_id=channels[0]["id"], import_id=runs[1]["id"])


def test_scoped_optional_summaries_keep_store_and_site_separate(service):
    store=_channel(service, source="biz_advisor", name="스토어")
    site=_channel(service, source="search_advisor", name="사이트",site_url="https://example.com")
    for c, kind, row in [(store,"commerce_attribution",{"tracking_id":"a.b", "inflows":20,"orders":1}), (site,"site_performance",{"page_url":"https://example.com/a","impressions":300,"clicks":4})]:
        service.create_import(channel_id=c["id"],source=c["source"], data_kind=kind,period_start=date(2026,8,17),period_end=date(2026,8,23),grain="weekly",rows=[row])
    assert service.overview(channel_id=store["id"])["commerce"]["metrics"]["orders"] == 1
    assert service.overview(channel_id=store["id"])["website"] is None
    assert service.overview(channel_id=site["id"])["website"]["metrics"]["clicks"] == 4
    assert service.overview(channel_id=site["id"])["commerce"] is None
