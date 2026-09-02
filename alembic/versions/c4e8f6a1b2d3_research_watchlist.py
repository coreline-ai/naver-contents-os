"""research watchlist

Revision ID: c4e8f6a1b2d3
Revises: 8b9f2c1d4e7a
Create Date: 2026-09-02 14:05:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c4e8f6a1b2d3"
down_revision: Union[str, Sequence[str], None] = "8b9f2c1d4e7a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "watchlist_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("keyword_id", sa.Integer(), nullable=False),
        sa.Column("comparison_key", sa.String(length=100), nullable=False),
        sa.Column("previous_snapshot", sa.JSON(), nullable=True),
        sa.Column("last_snapshot", sa.JSON(), nullable=True),
        sa.Column("last_status", sa.String(length=40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["keyword_id"], ["keywords.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("keyword_id", name="uq_watchlist_items_keyword_id"),
    )
    op.create_index("ix_watchlist_items_keyword_id", "watchlist_items", ["keyword_id"])


def downgrade() -> None:
    op.drop_index("ix_watchlist_items_keyword_id", table_name="watchlist_items")
    op.drop_table("watchlist_items")
