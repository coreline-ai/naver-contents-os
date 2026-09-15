from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Keyword(Base):
    __tablename__ = "keywords"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    text: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class KeywordSnapshot(Base):
    """One collection run: normalized metric/landscape/trend payload plus the derived score."""

    __tablename__ = "keyword_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    keyword_id: Mapped[int] = mapped_column(ForeignKey("keywords.id"), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    payload: Mapped[dict] = mapped_column(JSON)
    score: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    score_version: Mapped[str | None] = mapped_column(String(20), nullable=True)


class SerpSnapshot(Base):
    __tablename__ = "serp_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    keyword_id: Mapped[int] = mapped_column(ForeignKey("keywords.id"), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    payload: Mapped[dict] = mapped_column(JSON)


class Draft(Base):
    __tablename__ = "drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    keyword_id: Mapped[int] = mapped_column(ForeignKey("keywords.id"), index=True)
    source_snapshot_id: Mapped[int | None] = mapped_column(
        ForeignKey("keyword_snapshots.id"), nullable=True, index=True
    )
    plan_order: Mapped[int | None] = mapped_column(Integer, nullable=True)
    plan_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    blog_type: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(200))
    provider: Mapped[str] = mapped_column(String(40), default="skeleton")
    model: Mapped[str] = mapped_column(String(100), default="")
    prompt_version: Mapped[str] = mapped_column(String(20), default="v1")
    user_status: Mapped[str] = mapped_column(String(20), default="editing", index=True)
    fact_pack_id: Mapped[int | None] = mapped_column(
        ForeignKey("fact_packs.id"), nullable=True, index=True
    )
    fact_pack_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class DraftVersion(Base):
    """V1 원본 → V2 사실확인 → V3 제목 수정 → V4 최종 (docs/07 draft_versions)."""

    __tablename__ = "draft_versions"
    __table_args__ = (UniqueConstraint("draft_id", "version", name="uq_draft_versions_draft_version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    draft_id: Mapped[int] = mapped_column(ForeignKey("drafts.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class PublishJob(Base):
    __tablename__ = "publish_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    draft_id: Mapped[int] = mapped_column(ForeignKey("drafts.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    stage: Mapped[str] = mapped_column(String(30), default="")
    error_code: Mapped[str | None] = mapped_column(String(40), nullable=True)
    detail: Mapped[str] = mapped_column(Text, default="")
    history: Mapped[list] = mapped_column(JSON, default=list)
    transport: Mapped[str] = mapped_column(String(32), default="dedicated_chrome_cdp")
    draft_version: Mapped[int] = mapped_column(Integer, default=1)
    asset_manifest_version: Mapped[int] = mapped_column(Integer, default=0)
    idempotency_key: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True, index=True)
    request_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    verification: Mapped[dict] = mapped_column(JSON, default=dict)
    lease_owner: Mapped[str | None] = mapped_column(String(100), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)


class DraftAsset(Base):
    """A local, user-approved image fixed to one immutable Draft version."""

    __tablename__ = "draft_assets"
    __table_args__ = (
        UniqueConstraint("draft_id", "draft_version", "position", name="uq_draft_assets_position"),
        UniqueConstraint("draft_id", "draft_version", "sha256", name="uq_draft_assets_sha256"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    draft_id: Mapped[int] = mapped_column(ForeignKey("drafts.id", ondelete="CASCADE"), index=True)
    draft_version: Mapped[int] = mapped_column(Integer)
    filename: Mapped[str] = mapped_column(String(255))
    local_path: Mapped[str] = mapped_column(Text)
    mime_type: Mapped[str] = mapped_column(String(40))
    byte_size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    position: Mapped[int] = mapped_column(Integer)
    anchor_after: Mapped[int] = mapped_column(Integer, default=0)
    rights_status: Mapped[str] = mapped_column(String(20), default="approved")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class ApiCache(Base):
    __tablename__ = "api_cache"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(40), index=True)
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class ApiUsage(Base):
    __tablename__ = "api_usage"
    __table_args__ = (UniqueConstraint("provider", "period", name="uq_api_usage_provider_period"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(40))
    period: Mapped[str] = mapped_column(String(8))  # YYYYMM or YYYYMMDD (UTC)
    count: Mapped[int] = mapped_column(Integer, default=0)


class WatchlistItem(Base):
    """User-curated keyword with manually refreshed, comparable snapshots."""

    __tablename__ = "watchlist_items"
    __table_args__ = (UniqueConstraint("keyword_id", name="uq_watchlist_items_keyword_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    keyword_id: Mapped[int] = mapped_column(ForeignKey("keywords.id"), index=True)
    comparison_key: Mapped[str] = mapped_column(String(100), default="month:12:all")
    previous_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    last_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    last_status: Mapped[str] = mapped_column(String(40), default="never")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class DiscoveryRun(Base):
    """One explicit seed-based rising-keyword collection run."""

    __tablename__ = "discovery_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    seed: Mapped[str] = mapped_column(String(200), index=True)
    mode: Mapped[str] = mapped_column(String(20), index=True)
    region: Mapped[str] = mapped_column(String(100), default="")
    category: Mapped[str] = mapped_column(String(30), default="")
    comparison_key: Mapped[str] = mapped_column(String(100), index=True)
    payload: Mapped[dict] = mapped_column(JSON)
    score_version: Mapped[str] = mapped_column(String(20), default="freshness-v1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, index=True)


class PublishedContent(Base):
    """A public post explicitly confirmed by the user; never inferred from draft-save."""

    __tablename__ = "published_contents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    draft_id: Mapped[int | None] = mapped_column(
        ForeignKey("drafts.id"), nullable=True, unique=True, index=True
    )
    keyword_id: Mapped[int] = mapped_column(ForeignKey("keywords.id"), index=True)
    canonical_url: Mapped[str] = mapped_column(String(1000), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    verified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class FactPack(Base):
    """Versioned, user-reviewed evidence selected from one keyword snapshot."""

    __tablename__ = "fact_packs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("keyword_snapshots.id"), index=True)
    keyword_id: Mapped[int] = mapped_column(ForeignKey("keywords.id"), index=True)
    draft_id: Mapped[int | None] = mapped_column(ForeignKey("drafts.id"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class FactPackVersion(Base):
    __tablename__ = "fact_pack_versions"
    __table_args__ = (
        UniqueConstraint("fact_pack_id", "version", name="uq_fact_pack_versions_pack_version"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fact_pack_id: Mapped[int] = mapped_column(ForeignKey("fact_packs.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class AdPerformanceSnapshot(Base):
    """Sanitized local recommendations from an explicit ad-performance lookup."""

    __tablename__ = "ad_performance_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    since: Mapped[str] = mapped_column(String(10))
    until: Mapped[str] = mapped_column(String(10))
    payload: Mapped[dict] = mapped_column(JSON)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, index=True)


class OwnedChannel(Base):
    """A user-declared reporting scope; never stores Naver credentials or cookies."""

    __tablename__ = "owned_channels"
    __table_args__ = (
        UniqueConstraint("source", "display_name", name="uq_owned_channels_source_name"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[str] = mapped_column(String(30), index=True)
    channel_kind: Mapped[str] = mapped_column(String(20))
    display_name: Mapped[str] = mapped_column(String(100))
    site_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    ownership_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class PerformanceImportRun(Base):
    """One sanitized aggregate import. Raw files and original account payloads are not stored."""

    __tablename__ = "performance_import_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("owned_channels.id"), index=True)
    source: Mapped[str] = mapped_column(String(30), index=True)
    data_kind: Mapped[str] = mapped_column(String(30), index=True)
    period_start: Mapped[date] = mapped_column(Date, index=True)
    period_end: Mapped[date] = mapped_column(Date, index=True)
    grain: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(20), default="ready", index=True)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    warning_count: Mapped[int] = mapped_column(Integer, default=0)
    input_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class ContentPerformanceSnapshot(Base):
    __tablename__ = "content_performance_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    import_run_id: Mapped[int] = mapped_column(
        ForeignKey("performance_import_runs.id", ondelete="CASCADE"), index=True
    )
    channel_id: Mapped[int] = mapped_column(ForeignKey("owned_channels.id"), index=True)
    published_content_id: Mapped[int | None] = mapped_column(
        ForeignKey("published_contents.id", ondelete="SET NULL"), nullable=True, index=True
    )
    dedupe_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    canonical_url: Mapped[str | None] = mapped_column(String(1000), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    period_start: Mapped[date] = mapped_column(Date, index=True)
    period_end: Mapped[date] = mapped_column(Date, index=True)
    grain: Mapped[str] = mapped_column(String(10))
    data_state: Mapped[str] = mapped_column(String(20), index=True)
    views: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impressions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    inflows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ctr: Mapped[float | None] = mapped_column(Float, nullable=True)
    average_rank: Mapped[float | None] = mapped_column(Float, nullable=True)
    likes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    comments: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class QueryPerformanceSnapshot(Base):
    __tablename__ = "query_performance_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    import_run_id: Mapped[int] = mapped_column(
        ForeignKey("performance_import_runs.id", ondelete="CASCADE"), index=True
    )
    channel_id: Mapped[int] = mapped_column(ForeignKey("owned_channels.id"), index=True)
    published_content_id: Mapped[int | None] = mapped_column(
        ForeignKey("published_contents.id", ondelete="SET NULL"), nullable=True, index=True
    )
    dedupe_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    query: Mapped[str] = mapped_column(String(200), index=True)
    canonical_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    period_start: Mapped[date] = mapped_column(Date, index=True)
    period_end: Mapped[date] = mapped_column(Date, index=True)
    grain: Mapped[str] = mapped_column(String(10))
    data_state: Mapped[str] = mapped_column(String(20), index=True)
    impressions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    inflows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ctr: Mapped[float | None] = mapped_column(Float, nullable=True)
    average_rank: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class PerformanceTrackingLink(Base):
    """A user-created SmartStore tracking combination linked to an optional publication."""

    __tablename__ = "performance_tracking_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tracking_id: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    published_content_id: Mapped[int | None] = mapped_column(
        ForeignKey("published_contents.id", ondelete="SET NULL"), nullable=True, index=True
    )
    destination_url: Mapped[str] = mapped_column(String(1000))
    parameters: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class CommerceAttributionSnapshot(Base):
    __tablename__ = "commerce_attribution_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    import_run_id: Mapped[int] = mapped_column(
        ForeignKey("performance_import_runs.id", ondelete="CASCADE"), index=True
    )
    channel_id: Mapped[int] = mapped_column(ForeignKey("owned_channels.id"), index=True)
    published_content_id: Mapped[int | None] = mapped_column(
        ForeignKey("published_contents.id", ondelete="SET NULL"), nullable=True, index=True
    )
    dedupe_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    tracking_id: Mapped[str] = mapped_column(String(100), index=True)
    destination_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    period_start: Mapped[date] = mapped_column(Date, index=True)
    period_end: Mapped[date] = mapped_column(Date, index=True)
    grain: Mapped[str] = mapped_column(String(10))
    data_state: Mapped[str] = mapped_column(String(20), index=True)
    inflows: Mapped[int | None] = mapped_column(Integer, nullable=True)
    product_views: Mapped[int | None] = mapped_column(Integer, nullable=True)
    orders: Mapped[int | None] = mapped_column(Integer, nullable=True)
    conversion_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    attributed_revenue: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class SitePerformanceSnapshot(Base):
    __tablename__ = "site_performance_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    import_run_id: Mapped[int] = mapped_column(
        ForeignKey("performance_import_runs.id", ondelete="CASCADE"), index=True
    )
    channel_id: Mapped[int] = mapped_column(ForeignKey("owned_channels.id"), index=True)
    dedupe_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    page_url: Mapped[str] = mapped_column(String(1000), index=True)
    period_start: Mapped[date] = mapped_column(Date, index=True)
    period_end: Mapped[date] = mapped_column(Date, index=True)
    grain: Mapped[str] = mapped_column(String(10))
    data_state: Mapped[str] = mapped_column(String(20), index=True)
    collected_pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    indexed_pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impressions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    clicks: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ctr: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class PerformanceRecommendation(Base):
    """Versioned, explainable suggestions generated from sanitized snapshots only."""

    __tablename__ = "performance_recommendations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recommendation_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("owned_channels.id"), index=True)
    source_snapshot_type: Mapped[str] = mapped_column(String(30))
    source_snapshot_id: Mapped[int] = mapped_column(Integer, index=True)
    published_content_id: Mapped[int | None] = mapped_column(
        ForeignKey("published_contents.id", ondelete="CASCADE"), nullable=True, index=True
    )
    keyword: Mapped[str] = mapped_column(String(200), index=True)
    rule_code: Mapped[str] = mapped_column(String(40), index=True)
    action: Mapped[str] = mapped_column(String(30))
    reason: Mapped[str] = mapped_column(String(500))
    confidence: Mapped[str] = mapped_column(String(20))
    calculation_version: Mapped[str] = mapped_column(String(20), default="performance-v2")
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    evidence: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
