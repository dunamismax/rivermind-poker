"""Play-chip balances and the ledger (P4.2).

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0003'
down_revision: str | None = '0002'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('players', sa.Column('balance', sa.BigInteger(), server_default='0', nullable=False))
    op.add_column('players', sa.Column('granted_at', sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(op.f('ck_players_balance'), 'players', 'balance >= 0')
    op.create_table('ledger_entries',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('player_id', sa.String(length=64), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('amount', sa.BigInteger(), nullable=False),
    sa.Column('balance_after', sa.BigInteger(), nullable=False),
    sa.Column('table_id', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("(kind IN ('grant', 'top_up', 'cash_out', 'refund')) = (amount > 0)", name=op.f('ck_ledger_entries_direction')),
    sa.CheckConstraint("kind IN ('grant', 'top_up', 'buy_in', 'rebuy', 'cash_out', 'refund')", name=op.f('ck_ledger_entries_kind')),
    sa.CheckConstraint('amount <> 0', name=op.f('ck_ledger_entries_amount')),
    sa.CheckConstraint('balance_after >= 0', name=op.f('ck_ledger_entries_balance_after')),
    sa.ForeignKeyConstraint(['player_id'], ['players.id'], name=op.f('fk_ledger_entries_player_id_players'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_ledger_entries'))
    )
    op.create_index(op.f('ix_ledger_entries_player_id'), 'ledger_entries', ['player_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_ledger_entries_player_id'), table_name='ledger_entries')
    op.drop_table('ledger_entries')
    op.drop_constraint(op.f('ck_players_balance'), 'players', type_='check')
    op.drop_column('players', 'granted_at')
    op.drop_column('players', 'balance')
