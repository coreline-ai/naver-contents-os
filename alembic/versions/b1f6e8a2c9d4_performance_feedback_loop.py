"""performance feedback loop

Revision ID: b1f6e8a2c9d4
Revises: e8c1f4a9b7d2
Create Date: 2026-09-06 09:20:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b1f6e8a2c9d4"
down_revision: Union[str, Sequence[str], None] = "e8c1f4a9b7d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "owned_channels",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=30), nullable=False),
        sa.Column("channel_kind", sa.String(length=20), nullable=False),
        sa.Column("display_name", sa.String(length=100), nullable=False),
        sa.Column("site_url", sa.String(length=1000), nullable=True),
        sa.Column("ownership_confirmed", sa.Boolean(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source", "display_name", name="uq_owned_channels_source_name"),
    )
    op.create_index("ix_owned_channels_source", "owned_channels", ["source"])
    op.create_index("ix_owned_channels_enabled", "owned_channels", ["enabled"])

    op.create_table(
        "performance_tracking_links",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tracking_id", sa.String(length=100), nullable=False),
        sa.Column("published_content_id", sa.Integer(), nullable=True),
        sa.Column("destination_url", sa.String(length=1000), nullable=False),
        sa.Column("parameters", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["published_content_id"], ["published_contents.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_performance_tracking_links_tracking_id",
        "performance_tracking_links",
        ["tracking_id"],
        unique=True,
    )
    op.create_index(
        "ix_performance_tracking_links_published_content_id",
        "performance_tracking_links",
        ["published_content_id"],
    )

    op.create_table(
        "performance_import_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=30), nullable=False),
        sa.Column("data_kind", sa.String(length=30), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("grain", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("row_count", sa.Integer(), nullable=False),
        sa.Column("warning_count", sa.Integer(), nullable=False),
        sa.Column("input_hash", sa.String(length=64), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("collected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["channel_id"], ["owned_channels.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_performance_import_runs_channel_id", "performance_import_runs", ["channel_id"])
    op.create_index("ix_performance_import_runs_source", "performance_import_runs", ["source"])
    op.create_index("ix_performance_import_runs_data_kind", "performance_import_runs", ["data_kind"])
    op.create_index("ix_performance_import_runs_period_start", "performance_import_runs", ["period_start"])
    op.create_index("ix_performance_import_runs_period_end", "performance_import_runs", ["period_end"])
    op.create_index("ix_performance_import_runs_status", "performance_import_runs", ["status"])
    op.create_index("ix_performance_import_runs_input_hash", "performance_import_runs", ["input_hash"], unique=True)

    _create_content_snapshots()
    _create_query_snapshots()
    _create_commerce_snapshots()
    _create_site_snapshots()
    _create_recommendations()


def _create_content_snapshots() -> None:
    op.create_table(
        "content_performance_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("import_run_id", sa.Integer(), nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("published_content_id", sa.Integer(), nullable=True),
        sa.Column("dedupe_key", sa.String(length=64), nullable=False),
        sa.Column("canonical_url", sa.String(length=1000), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("grain", sa.String(length=10), nullable=False),
        sa.Column("data_state", sa.String(length=20), nullable=False),
        sa.Column("views", sa.Integer(), nullable=True),
        sa.Column("impressions", sa.Integer(), nullable=True),
        sa.Column("inflows", sa.Integer(), nullable=True),
        sa.Column("ctr", sa.Float(), nullable=True),
        sa.Column("average_rank", sa.Float(), nullable=True),
        sa.Column("likes", sa.Integer(), nullable=True),
        sa.Column("comments", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["import_run_id"], ["performance_import_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["channel_id"], ["owned_channels.id"]),
        sa.ForeignKeyConstraint(["published_content_id"], ["published_contents.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    for name, columns, unique in (
        ("ix_content_performance_snapshots_import_run_id", ["import_run_id"], False),
        ("ix_content_performance_snapshots_channel_id", ["channel_id"], False),
        ("ix_content_performance_snapshots_published_content_id", ["published_content_id"], False),
        ("ix_content_performance_snapshots_dedupe_key", ["dedupe_key"], True),
        ("ix_content_performance_snapshots_canonical_url", ["canonical_url"], False),
        ("ix_content_performance_snapshots_period_start", ["period_start"], False),
        ("ix_content_performance_snapshots_period_end", ["period_end"], False),
        ("ix_content_performance_snapshots_data_state", ["data_state"], False),
    ):
        op.create_index(name, "content_performance_snapshots", columns, unique=unique)


def _create_query_snapshots() -> None:
    op.create_table(
        "query_performance_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("import_run_id", sa.Integer(), nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("published_content_id", sa.Integer(), nullable=True),
        sa.Column("dedupe_key", sa.String(length=64), nullable=False),
        sa.Column("query", sa.String(length=200), nullable=False),
        sa.Column("canonical_url", sa.String(length=1000), nullable=True),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("grain", sa.String(length=10), nullable=False),
        sa.Column("data_state", sa.String(length=20), nullable=False),
        sa.Column("impressions", sa.Integer(), nullable=True),
        sa.Column("inflows", sa.Integer(), nullable=True),
        sa.Column("ctr", sa.Float(), nullable=True),
        sa.Column("average_rank", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["import_run_id"], ["performance_import_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["channel_id"], ["owned_channels.id"]),
        sa.ForeignKeyConstraint(["published_content_id"], ["published_contents.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    for name, columns, unique in (
        ("ix_query_performance_snapshots_import_run_id", ["import_run_id"], False),
        ("ix_query_performance_snapshots_channel_id", ["channel_id"], False),
        ("ix_query_performance_snapshots_published_content_id", ["published_content_id"], False),
        ("ix_query_performance_snapshots_dedupe_key", ["dedupe_key"], True),
        ("ix_query_performance_snapshots_query", ["query"], False),
        ("ix_query_performance_snapshots_period_start", ["period_start"], False),
        ("ix_query_performance_snapshots_period_end", ["period_end"], False),
        ("ix_query_performance_snapshots_data_state", ["data_state"], False),
    ):
        op.create_index(name, "query_performance_snapshots", columns, unique=unique)


def _create_commerce_snapshots() -> None:
    op.create_table(
        "commerce_attribution_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("import_run_id", sa.Integer(), nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("published_content_id", sa.Integer(), nullable=True),
        sa.Column("dedupe_key", sa.String(length=64), nullable=False),
        sa.Column("tracking_id", sa.String(length=100), nullable=False),
        sa.Column("destination_url", sa.String(length=1000), nullable=True),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("grain", sa.String(length=10), nullable=False),
        sa.Column("data_state", sa.String(length=20), nullable=False),
        sa.Column("inflows", sa.Integer(), nullable=True),
        sa.Column("product_views", sa.Integer(), nullable=True),
        sa.Column("orders", sa.Integer(), nullable=True),
        sa.Column("conversion_rate", sa.Float(), nullable=True),
        sa.Column("attributed_revenue", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["import_run_id"], ["performance_import_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["channel_id"], ["owned_channels.id"]),
        sa.ForeignKeyConstraint(["published_content_id"], ["published_contents.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    for name, columns, unique in (
        ("ix_commerce_attribution_snapshots_import_run_id", ["import_run_id"], False),
        ("ix_commerce_attribution_snapshots_channel_id", ["channel_id"], False),
        ("ix_commerce_attribution_snapshots_published_content_id", ["published_content_id"], False),
        ("ix_commerce_attribution_snapshots_dedupe_key", ["dedupe_key"], True),
        ("ix_commerce_attribution_snapshots_tracking_id", ["tracking_id"], False),
        ("ix_commerce_attribution_snapshots_period_start", ["period_start"], False),
        ("ix_commerce_attribution_snapshots_period_end", ["period_end"], False),
        ("ix_commerce_attribution_snapshots_data_state", ["data_state"], False),
    ):
        op.create_index(name, "commerce_attribution_snapshots", columns, unique=unique)


def _create_site_snapshots() -> None:
    op.create_table(
        "site_performance_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("import_run_id", sa.Integer(), nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("dedupe_key", sa.String(length=64), nullable=False),
        sa.Column("page_url", sa.String(length=1000), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("grain", sa.String(length=10), nullable=False),
        sa.Column("data_state", sa.String(length=20), nullable=False),
        sa.Column("collected_pages", sa.Integer(), nullable=True),
        sa.Column("indexed_pages", sa.Integer(), nullable=True),
        sa.Column("impressions", sa.Integer(), nullable=True),
        sa.Column("clicks", sa.Integer(), nullable=True),
        sa.Column("ctr", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["import_run_id"], ["performance_import_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["channel_id"], ["owned_channels.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    for name, columns, unique in (
        ("ix_site_performance_snapshots_import_run_id", ["import_run_id"], False),
        ("ix_site_performance_snapshots_channel_id", ["channel_id"], False),
        ("ix_site_performance_snapshots_dedupe_key", ["dedupe_key"], True),
        ("ix_site_performance_snapshots_page_url", ["page_url"], False),
        ("ix_site_performance_snapshots_period_start", ["period_start"], False),
        ("ix_site_performance_snapshots_period_end", ["period_end"], False),
        ("ix_site_performance_snapshots_data_state", ["data_state"], False),
    ):
        op.create_index(name, "site_performance_snapshots", columns, unique=unique)


def _create_recommendations() -> None:
    op.create_table(
        "performance_recommendations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("recommendation_key", sa.String(length=64), nullable=False),
        sa.Column("channel_id", sa.Integer(), nullable=False),
        sa.Column("source_snapshot_type", sa.String(length=30), nullable=False),
        sa.Column("source_snapshot_id", sa.Integer(), nullable=False),
        sa.Column("published_content_id", sa.Integer(), nullable=True),
        sa.Column("keyword", sa.String(length=200), nullable=False),
        sa.Column("rule_code", sa.String(length=40), nullable=False),
        sa.Column("action", sa.String(length=30), nullable=False),
        sa.Column("reason", sa.String(length=500), nullable=False),
        sa.Column("confidence", sa.String(length=20), nullable=False),
        sa.Column("calculation_version", sa.String(length=20), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["channel_id"], ["owned_channels.id"]),
        sa.ForeignKeyConstraint(["published_content_id"], ["published_contents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    for name, columns, unique in (
        ("ix_performance_recommendations_recommendation_key", ["recommendation_key"], True),
        ("ix_performance_recommendations_channel_id", ["channel_id"], False),
        ("ix_performance_recommendations_source_snapshot_id", ["source_snapshot_id"], False),
        ("ix_performance_recommendations_published_content_id", ["published_content_id"], False),
        ("ix_performance_recommendations_keyword", ["keyword"], False),
        ("ix_performance_recommendations_rule_code", ["rule_code"], False),
        ("ix_performance_recommendations_status", ["status"], False),
    ):
        op.create_index(name, "performance_recommendations", columns, unique=unique)


def downgrade() -> None:
    for table in (
        "performance_recommendations",
        "site_performance_snapshots",
        "commerce_attribution_snapshots",
        "query_performance_snapshots",
        "content_performance_snapshots",
        "performance_import_runs",
        "performance_tracking_links",
        "owned_channels",
    ):
        op.drop_table(table)
