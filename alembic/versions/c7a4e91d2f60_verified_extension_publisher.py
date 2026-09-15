"""verified current-Chrome publisher and draft image assets

Revision ID: c7a4e91d2f60
Revises: b1f6e8a2c9d4
Create Date: 2026-09-15 00:05:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c7a4e91d2f60"
down_revision: Union[str, Sequence[str], None] = "b1f6e8a2c9d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("publish_jobs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("transport", sa.String(length=32), nullable=False, server_default="dedicated_chrome_cdp"))
        batch_op.add_column(sa.Column("draft_version", sa.Integer(), nullable=False, server_default="1"))
        batch_op.add_column(sa.Column("asset_manifest_version", sa.Integer(), nullable=False, server_default="0"))
        batch_op.add_column(sa.Column("idempotency_key", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("request_payload", sa.JSON(), nullable=False, server_default="{}"))
        batch_op.add_column(sa.Column("verification", sa.JSON(), nullable=False, server_default="{}"))
        batch_op.add_column(sa.Column("lease_owner", sa.String(length=100), nullable=True))
        batch_op.add_column(sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.create_index("ix_publish_jobs_idempotency_key", ["idempotency_key"], unique=True)

    op.create_table(
        "draft_assets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("draft_id", sa.Integer(), nullable=False),
        sa.Column("draft_version", sa.Integer(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("local_path", sa.Text(), nullable=False),
        sa.Column("mime_type", sa.String(length=40), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("anchor_after", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rights_status", sa.String(length=20), nullable=False, server_default="approved"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["draft_id"], ["drafts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("draft_id", "draft_version", "position", name="uq_draft_assets_position"),
        sa.UniqueConstraint("draft_id", "draft_version", "sha256", name="uq_draft_assets_sha256"),
    )
    op.create_index("ix_draft_assets_draft_id", "draft_assets", ["draft_id"])


def downgrade() -> None:
    op.drop_index("ix_draft_assets_draft_id", table_name="draft_assets")
    op.drop_table("draft_assets")
    with op.batch_alter_table("publish_jobs", schema=None) as batch_op:
        batch_op.drop_index("ix_publish_jobs_idempotency_key")
        batch_op.drop_column("lease_expires_at")
        batch_op.drop_column("lease_owner")
        batch_op.drop_column("verification")
        batch_op.drop_column("request_payload")
        batch_op.drop_column("idempotency_key")
        batch_op.drop_column("asset_manifest_version")
        batch_op.drop_column("draft_version")
        batch_op.drop_column("transport")
