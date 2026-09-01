"""phase7 draft lineage

Revision ID: f2c91d8a7b42
Revises: a60d442bc8dd
Create Date: 2026-09-01 22:30:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f2c91d8a7b42"
down_revision: Union[str, Sequence[str], None] = "a60d442bc8dd"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("drafts", schema=None) as batch_op:
        batch_op.add_column(sa.Column("source_snapshot_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("plan_payload", sa.JSON(), nullable=False, server_default="{}"))
        batch_op.add_column(sa.Column("provider", sa.String(length=40), nullable=False, server_default="skeleton"))
        batch_op.add_column(sa.Column("model", sa.String(length=100), nullable=False, server_default=""))
        batch_op.add_column(sa.Column("prompt_version", sa.String(length=20), nullable=False, server_default="v1"))
        batch_op.create_foreign_key(
            "fk_drafts_source_snapshot_id_keyword_snapshots",
            "keyword_snapshots",
            ["source_snapshot_id"],
            ["id"],
        )
        batch_op.create_index("ix_drafts_source_snapshot_id", ["source_snapshot_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("drafts", schema=None) as batch_op:
        batch_op.drop_index("ix_drafts_source_snapshot_id")
        batch_op.drop_constraint("fk_drafts_source_snapshot_id_keyword_snapshots", type_="foreignkey")
        batch_op.drop_column("prompt_version")
        batch_op.drop_column("model")
        batch_op.drop_column("provider")
        batch_op.drop_column("plan_payload")
        batch_op.drop_column("source_snapshot_id")
