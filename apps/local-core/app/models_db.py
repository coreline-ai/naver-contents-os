from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)


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
