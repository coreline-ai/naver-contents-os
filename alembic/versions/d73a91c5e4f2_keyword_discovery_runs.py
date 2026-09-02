"""keyword discovery runs

Revision ID: d73a91c5e4f2
Revises: c4e8f6a1b2d3
Create Date: 2026-09-02 22:45:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d73a91c5e4f2"
down_revision: Union[str, Sequence[str], None] = "c4e8f6a1b2d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "discovery_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("seed", sa.String(length=200), nullable=False),
        sa.Column("mode", sa.String(length=20), nullable=False),
        sa.Column("region", sa.String(length=100), nullable=False),
        sa.Column("category", sa.String(length=30), nullable=False),
        sa.Column("comparison_key", sa.String(length=100), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("score_version", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_discovery_runs_seed", "discovery_runs", ["seed"])
    op.create_index("ix_discovery_runs_mode", "discovery_runs", ["mode"])
    op.create_index("ix_discovery_runs_comparison_key", "discovery_runs", ["comparison_key"])
    op.create_index("ix_discovery_runs_created_at", "discovery_runs", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_discovery_runs_created_at", table_name="discovery_runs")
    op.drop_index("ix_discovery_runs_comparison_key", table_name="discovery_runs")
    op.drop_index("ix_discovery_runs_mode", table_name="discovery_runs")
    op.drop_index("ix_discovery_runs_seed", table_name="discovery_runs")
    op.drop_table("discovery_runs")
