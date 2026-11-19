"""Anonymous players with random display handles (P4.1).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0002'
down_revision: str | None = '0001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('players',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('handle', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('char_length(handle) BETWEEN 1 AND 32', name=op.f('ck_players_handle')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_players')),
    sa.UniqueConstraint('handle', name='uq_players_handle')
    )


def downgrade() -> None:
    op.drop_table('players')
