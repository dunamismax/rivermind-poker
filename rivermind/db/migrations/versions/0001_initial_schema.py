"""Initial schema: poker tables, seats, hands and hand histories (P3.1).

Revision ID: 0001
Revises: none
Create Date: 2026-11-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0001'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('poker_tables',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('seat_count', sa.SmallInteger(), nullable=False),
    sa.Column('small_blind', sa.BigInteger(), nullable=False),
    sa.Column('big_blind', sa.BigInteger(), nullable=False),
    sa.Column('ante', sa.BigInteger(), server_default='0', nullable=False),
    sa.Column('min_buy_in', sa.BigInteger(), nullable=False),
    sa.Column('max_buy_in', sa.BigInteger(), nullable=False),
    sa.Column('status', sa.String(length=16), server_default='open', nullable=False),
    sa.Column('state', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('state_format', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("status IN ('open', 'closed')", name=op.f('ck_poker_tables_status')),
    sa.CheckConstraint('(state IS NULL) = (state_format IS NULL)', name=op.f('ck_poker_tables_state_format')),
    sa.CheckConstraint('ante >= 0', name=op.f('ck_poker_tables_ante')),
    sa.CheckConstraint('min_buy_in > 0 AND max_buy_in >= min_buy_in', name=op.f('ck_poker_tables_buy_in')),
    sa.CheckConstraint('seat_count BETWEEN 2 AND 9', name=op.f('ck_poker_tables_seat_count')),
    sa.CheckConstraint('small_blind > 0 AND big_blind >= small_blind', name=op.f('ck_poker_tables_blinds')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_poker_tables'))
    )
    op.create_table('hands',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('table_id', sa.String(length=64), nullable=False),
    sa.Column('hand_no', sa.Integer(), nullable=False),
    sa.Column('button', sa.SmallInteger(), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('ended_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint('button BETWEEN 0 AND 8', name=op.f('ck_hands_button')),
    sa.CheckConstraint('ended_at IS NULL OR ended_at >= started_at', name=op.f('ck_hands_ended_at')),
    sa.CheckConstraint('hand_no >= 1', name=op.f('ck_hands_hand_no')),
    sa.ForeignKeyConstraint(['table_id'], ['poker_tables.id'], name=op.f('fk_hands_table_id_poker_tables'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_hands')),
    sa.UniqueConstraint('table_id', 'hand_no', name='uq_hands_table_id_hand_no')
    )
    op.create_index(op.f('ix_hands_table_id'), 'hands', ['table_id'], unique=False)
    op.create_table('seats',
    sa.Column('table_id', sa.String(length=64), nullable=False),
    sa.Column('seat_no', sa.SmallInteger(), nullable=False),
    sa.Column('display_name', sa.Text(), nullable=False),
    sa.Column('is_bot', sa.Boolean(), nullable=False),
    sa.Column('bot_kind', sa.String(length=64), nullable=True),
    sa.Column('stack', sa.BigInteger(), nullable=False),
    sa.Column('sitting_out', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('joined_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('is_bot = (bot_kind IS NOT NULL)', name=op.f('ck_seats_bot_kind')),
    sa.CheckConstraint('seat_no BETWEEN 0 AND 8', name=op.f('ck_seats_seat_no')),
    sa.CheckConstraint('stack >= 0', name=op.f('ck_seats_stack')),
    sa.ForeignKeyConstraint(['table_id'], ['poker_tables.id'], name=op.f('fk_seats_table_id_poker_tables'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('table_id', 'seat_no', name=op.f('pk_seats'))
    )
    op.create_table('hand_histories',
    sa.Column('hand_id', sa.BigInteger(), nullable=False),
    sa.Column('format', sa.Integer(), nullable=False),
    sa.Column('record', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('format >= 1', name=op.f('ck_hand_histories_format')),
    sa.ForeignKeyConstraint(['hand_id'], ['hands.id'], name=op.f('fk_hand_histories_hand_id_hands'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('hand_id', name=op.f('pk_hand_histories'))
    )


def downgrade() -> None:
    op.drop_table('hand_histories')
    op.drop_table('seats')
    op.drop_index(op.f('ix_hands_table_id'), table_name='hands')
    op.drop_table('hands')
    op.drop_table('poker_tables')
