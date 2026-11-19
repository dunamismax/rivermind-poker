"""Reports, mutes and blocks, and collusion signals (P4.5).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0004'
down_revision: str | None = '0003'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('player_reports',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('reporter_id', sa.String(length=64), nullable=False),
    sa.Column('target_id', sa.String(length=64), nullable=False),
    sa.Column('target_handle', sa.Text(), nullable=False),
    sa.Column('reason', sa.String(length=16), nullable=False),
    sa.Column('table_id', sa.String(length=64), nullable=True),
    sa.Column('hand_no', sa.Integer(), nullable=True),
    sa.Column('status', sa.String(length=16), server_default='open', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("reason IN ('handle', 'abuse', 'collusion', 'other')", name=op.f('ck_player_reports_reason')),
    sa.CheckConstraint("status IN ('open', 'reviewed')", name=op.f('ck_player_reports_status')),
    sa.CheckConstraint('reporter_id <> target_id', name=op.f('ck_player_reports_not_self')),
    sa.ForeignKeyConstraint(['reporter_id'], ['players.id'], name=op.f('fk_player_reports_reporter_id_players'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['target_id'], ['players.id'], name=op.f('fk_player_reports_target_id_players'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_player_reports'))
    )
    op.create_index(op.f('ix_player_reports_reporter_id'), 'player_reports', ['reporter_id'], unique=False)
    op.create_index(op.f('ix_player_reports_target_id'), 'player_reports', ['target_id'], unique=False)
    op.create_table('player_relations',
    sa.Column('player_id', sa.String(length=64), nullable=False),
    sa.Column('target_id', sa.String(length=64), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("kind IN ('mute', 'block')", name=op.f('ck_player_relations_kind')),
    sa.CheckConstraint('player_id <> target_id', name=op.f('ck_player_relations_not_self')),
    sa.ForeignKeyConstraint(['player_id'], ['players.id'], name=op.f('fk_player_relations_player_id_players'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['target_id'], ['players.id'], name=op.f('fk_player_relations_target_id_players'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('player_id', 'target_id', name=op.f('pk_player_relations'))
    )
    op.create_index(op.f('ix_player_relations_target_id'), 'player_relations', ['target_id'], unique=False)
    op.create_table('safety_signals',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('table_id', sa.String(length=64), nullable=True),
    sa.Column('player_ids', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('detail', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("kind IN ('same_address')", name=op.f('ck_safety_signals_kind')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_safety_signals'))
    )


def downgrade() -> None:
    op.drop_table('safety_signals')
    op.drop_index(op.f('ix_player_relations_target_id'), table_name='player_relations')
    op.drop_table('player_relations')
    op.drop_index(op.f('ix_player_reports_target_id'), table_name='player_reports')
    op.drop_index(op.f('ix_player_reports_reporter_id'), table_name='player_reports')
    op.drop_table('player_reports')
