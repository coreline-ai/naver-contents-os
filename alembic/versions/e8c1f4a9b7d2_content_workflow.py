"""content workflow, publication registry, and fact packs

Revision ID: e8c1f4a9b7d2
Revises: d73a91c5e4f2
Create Date: 2026-09-03 09:15:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e8c1f4a9b7d2"
down_revision: Union[str, Sequence[str], None] = "d73a91c5e4f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("drafts", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("user_status", sa.String(length=20), nullable=False, server_default="editing")
        )
        batch_op.create_index("ix_drafts_user_status", ["user_status"], unique=False)

    op.create_table(
        "published_contents",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("draft_id", sa.Integer(), nullable=True),
        sa.Column("keyword_id", sa.Integer(), nullable=False),
        sa.Column("canonical_url", sa.String(length=1000), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["draft_id"], ["drafts.id"]),
        sa.ForeignKeyConstraint(["keyword_id"], ["keywords.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("canonical_url", name="uq_published_contents_canonical_url"),
        sa.UniqueConstraint("draft_id", name="uq_published_contents_draft_id"),
    )
    op.create_index("ix_published_contents_draft_id", "published_contents", ["draft_id"])
    op.create_index("ix_published_contents_keyword_id", "published_contents", ["keyword_id"])
    op.create_index("ix_published_contents_canonical_url", "published_contents", ["canonical_url"])
    op.create_index("ix_published_contents_published_at", "published_contents", ["published_at"])

    op.create_table(
        "fact_packs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("keyword_id", sa.Integer(), nullable=False),
        sa.Column("draft_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["snapshot_id"], ["keyword_snapshots.id"]),
        sa.ForeignKeyConstraint(["keyword_id"], ["keywords.id"]),
        sa.ForeignKeyConstraint(["draft_id"], ["drafts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_fact_packs_snapshot_id", "fact_packs", ["snapshot_id"])
    op.create_index("ix_fact_packs_keyword_id", "fact_packs", ["keyword_id"])
    op.create_index("ix_fact_packs_draft_id", "fact_packs", ["draft_id"])

    op.create_table(
        "fact_pack_versions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("fact_pack_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["fact_pack_id"], ["fact_packs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("fact_pack_id", "version", name="uq_fact_pack_versions_pack_version"),
    )
    op.create_index("ix_fact_pack_versions_fact_pack_id", "fact_pack_versions", ["fact_pack_id"])
    op.create_index("ix_fact_pack_versions_status", "fact_pack_versions", ["status"])

    with op.batch_alter_table("drafts", schema=None) as batch_op:
        batch_op.add_column(sa.Column("fact_pack_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("fact_pack_version", sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            "fk_drafts_fact_pack_id_fact_packs", "fact_packs", ["fact_pack_id"], ["id"]
        )
        batch_op.create_index("ix_drafts_fact_pack_id", ["fact_pack_id"], unique=False)

    op.create_table(
        "ad_performance_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("since", sa.String(length=10), nullable=False),
        sa.Column("until", sa.String(length=10), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("collected_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_ad_performance_snapshots_collected_at",
        "ad_performance_snapshots",
        ["collected_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_ad_performance_snapshots_collected_at", table_name="ad_performance_snapshots"
    )
    op.drop_table("ad_performance_snapshots")

    with op.batch_alter_table("drafts", schema=None) as batch_op:
        batch_op.drop_index("ix_drafts_fact_pack_id")
        batch_op.drop_constraint("fk_drafts_fact_pack_id_fact_packs", type_="foreignkey")
        batch_op.drop_column("fact_pack_version")
        batch_op.drop_column("fact_pack_id")

    op.drop_index("ix_fact_pack_versions_status", table_name="fact_pack_versions")
    op.drop_index("ix_fact_pack_versions_fact_pack_id", table_name="fact_pack_versions")
    op.drop_table("fact_pack_versions")
    op.drop_index("ix_fact_packs_draft_id", table_name="fact_packs")
    op.drop_index("ix_fact_packs_keyword_id", table_name="fact_packs")
    op.drop_index("ix_fact_packs_snapshot_id", table_name="fact_packs")
    op.drop_table("fact_packs")
    op.drop_index("ix_published_contents_published_at", table_name="published_contents")
    op.drop_index("ix_published_contents_canonical_url", table_name="published_contents")
    op.drop_index("ix_published_contents_keyword_id", table_name="published_contents")
    op.drop_index("ix_published_contents_draft_id", table_name="published_contents")
    op.drop_table("published_contents")

    with op.batch_alter_table("drafts", schema=None) as batch_op:
        batch_op.drop_index("ix_drafts_user_status")
        batch_op.drop_column("user_status")
