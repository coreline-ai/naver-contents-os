"""phase8 daily api usage

Revision ID: 8b9f2c1d4e7a
Revises: f2c91d8a7b42
Create Date: 2026-09-02 11:34:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "8b9f2c1d4e7a"
down_revision: Union[str, Sequence[str], None] = "f2c91d8a7b42"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("api_usage", schema=None) as batch_op:
        batch_op.alter_column(
            "period",
            existing_type=sa.String(length=6),
            type_=sa.String(length=8),
            existing_nullable=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("api_usage", schema=None) as batch_op:
        batch_op.alter_column(
            "period",
            existing_type=sa.String(length=8),
            type_=sa.String(length=6),
            existing_nullable=False,
        )
