"""Who played each seat of a finished hand (P4.6).

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0005'
down_revision: str | None = '0004'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('hand_players',
    sa.Column('hand_id', sa.BigInteger(), nullable=False),
    sa.Column('seat_no', sa.SmallInteger(), nullable=False),
    sa.Column('player_id', sa.String(length=64), nullable=True),
    sa.Column('display_name', sa.Text(), nullable=False),
    sa.Column('bot_kind', sa.String(length=64), nullable=True),
    sa.Column('net', sa.BigInteger(), nullable=False),
    sa.CheckConstraint('(player_id IS NULL) = (bot_kind IS NOT NULL)', name=op.f('ck_hand_players_bot_kind')),
    sa.CheckConstraint('seat_no BETWEEN 0 AND 8', name=op.f('ck_hand_players_seat_no')),
    sa.ForeignKeyConstraint(['hand_id'], ['hands.id'], name=op.f('fk_hand_players_hand_id_hands'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('hand_id', 'seat_no', name=op.f('pk_hand_players'))
    )
    op.create_index(op.f('ix_hand_players_player_id'), 'hand_players', ['player_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_hand_players_player_id'), table_name='hand_players')
    op.drop_table('hand_players')
