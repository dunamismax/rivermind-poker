"""Mark guests' practice tables (P6.0b).

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0006'
down_revision: str | None = '0005'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('poker_tables', sa.Column('practice', sa.Boolean(), server_default='false', nullable=False))


def downgrade() -> None:
    op.drop_column('poker_tables', 'practice')
