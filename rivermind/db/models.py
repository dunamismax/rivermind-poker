"""The initial schema: tables, seats, hands and hand histories (P3.1).

Chips are whole numbers stored as ``bigint``. Table state and hand histories
are versioned JSON documents from ``rivermind.engine.history`` (D-4), stored
as ``jsonb`` with their format number beside them. Anonymous players (P4.1,
migration ``0002``) have a random display handle; their session cookie is
signed by the server, so no session rows are stored. Each player's play-chip
balance (P4.2, migration ``0003``) changes only together with a row in
``ledger_entries``, so the entries always add up to the balance (D-1: the
chips have no cash value). Reports, mutes and blocks between players and
collusion signals (P4.5, migration ``0004``) are kept for review; signals hold
keyed hashes of network addresses, never the addresses. Each finished hand
lists who played each seat (P4.6, migration ``0005``), so players can find the
hands they played.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Integer,
    MetaData,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

NAMING = {
    "ix": "ix_%(table_name)s_%(column_0_name)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


def _now() -> Any:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Player(Base):
    """An anonymous player, made on their first visit (P4.1)."""

    __tablename__ = "players"
    __table_args__ = (
        UniqueConstraint("handle", name="uq_players_handle"),
        CheckConstraint("char_length(handle) BETWEEN 1 AND 32", name="handle"),
        CheckConstraint("balance >= 0", name="balance"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    handle: Mapped[str] = mapped_column(Text, nullable=False)
    balance: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    granted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    """When the starting grant or the last daily top-up was paid."""
    created_at: Mapped[datetime] = _now()
    last_seen_at: Mapped[datetime] = _now()


LEDGER_KINDS = ("grant", "top_up", "buy_in", "rebuy", "cash_out", "refund")


class LedgerEntry(Base):
    """One change to a player's play-chip balance (P4.2)."""

    __tablename__ = "ledger_entries"
    __table_args__ = (
        CheckConstraint("kind IN ('grant', 'top_up', 'buy_in', 'rebuy', 'cash_out', 'refund')", name="kind"),
        CheckConstraint("amount <> 0", name="amount"),
        CheckConstraint("balance_after >= 0", name="balance_after"),
        CheckConstraint(
            "(kind IN ('grant', 'top_up', 'cash_out', 'refund')) = (amount > 0)", name="direction"
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    player_id: Mapped[str] = mapped_column(ForeignKey("players.id", ondelete="CASCADE"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance_after: Mapped[int] = mapped_column(BigInteger, nullable=False)
    table_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = _now()


REPORT_REASONS = ("handle", "abuse", "collusion", "other")


class PlayerReport(Base):
    """One player reporting another, for review (P4.5)."""

    __tablename__ = "player_reports"
    __table_args__ = (
        CheckConstraint("reason IN ('handle', 'abuse', 'collusion', 'other')", name="reason"),
        CheckConstraint("status IN ('open', 'reviewed')", name="status"),
        CheckConstraint("reporter_id <> target_id", name="not_self"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    reporter_id: Mapped[str] = mapped_column(ForeignKey("players.id", ondelete="CASCADE"), nullable=False, index=True)
    target_id: Mapped[str] = mapped_column(ForeignKey("players.id", ondelete="CASCADE"), nullable=False, index=True)
    target_handle: Mapped[str] = mapped_column(Text, nullable=False)
    """The handle when reported, which a rename may change."""
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
    table_id: Mapped[str | None] = mapped_column(String(64))
    hand_no: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="open")
    created_at: Mapped[datetime] = _now()


class PlayerRelation(Base):
    """A player muting or blocking another (P4.5)."""

    __tablename__ = "player_relations"
    __table_args__ = (
        CheckConstraint("kind IN ('mute', 'block')", name="kind"),
        CheckConstraint("player_id <> target_id", name="not_self"),
    )

    player_id: Mapped[str] = mapped_column(ForeignKey("players.id", ondelete="CASCADE"), primary_key=True)
    target_id: Mapped[str] = mapped_column(ForeignKey("players.id", ondelete="CASCADE"), primary_key=True, index=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = _now()


class SafetySignal(Base):
    """Something worth reviewing for collusion, such as two people at a table from one address (P4.5)."""

    __tablename__ = "safety_signals"
    __table_args__ = (CheckConstraint("kind IN ('same_address')", name="kind"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    table_id: Mapped[str | None] = mapped_column(String(64))
    player_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    created_at: Mapped[datetime] = _now()


class PokerTable(Base):
    """A table's configuration and, from P3.5, its saved state."""

    __tablename__ = "poker_tables"
    __table_args__ = (
        CheckConstraint("seat_count BETWEEN 2 AND 9", name="seat_count"),
        CheckConstraint("small_blind > 0 AND big_blind >= small_blind", name="blinds"),
        CheckConstraint("ante >= 0", name="ante"),
        CheckConstraint("min_buy_in > 0 AND max_buy_in >= min_buy_in", name="buy_in"),
        CheckConstraint("status IN ('open', 'closed')", name="status"),
        CheckConstraint("(state IS NULL) = (state_format IS NULL)", name="state_format"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    seat_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    small_blind: Mapped[int] = mapped_column(BigInteger, nullable=False)
    big_blind: Mapped[int] = mapped_column(BigInteger, nullable=False)
    ante: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    min_buy_in: Mapped[int] = mapped_column(BigInteger, nullable=False)
    max_buy_in: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="open")
    state: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    state_format: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()

    seats: Mapped[list[Seat]] = relationship(back_populates="table", cascade="all, delete-orphan", order_by="Seat.seat_no")
    hands: Mapped[list[Hand]] = relationship(back_populates="table", cascade="all, delete-orphan", order_by="Hand.hand_no")


class Seat(Base):
    """An occupied seat. Empty seats have no row."""

    __tablename__ = "seats"
    __table_args__ = (
        CheckConstraint("seat_no BETWEEN 0 AND 8", name="seat_no"),
        CheckConstraint("stack >= 0", name="stack"),
        CheckConstraint("is_bot = (bot_kind IS NOT NULL)", name="bot_kind"),
    )

    table_id: Mapped[str] = mapped_column(ForeignKey("poker_tables.id", ondelete="CASCADE"), primary_key=True)
    seat_no: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    is_bot: Mapped[bool] = mapped_column(Boolean, nullable=False)
    bot_kind: Mapped[str | None] = mapped_column(String(64))
    stack: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sitting_out: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    joined_at: Mapped[datetime] = _now()

    table: Mapped[PokerTable] = relationship(back_populates="seats")


class Hand(Base):
    """One hand dealt at a table."""

    __tablename__ = "hands"
    __table_args__ = (
        UniqueConstraint("table_id", "hand_no", name="uq_hands_table_id_hand_no"),
        CheckConstraint("hand_no >= 1", name="hand_no"),
        CheckConstraint("button BETWEEN 0 AND 8", name="button"),
        CheckConstraint("ended_at IS NULL OR ended_at >= started_at", name="ended_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    table_id: Mapped[str] = mapped_column(ForeignKey("poker_tables.id", ondelete="CASCADE"), nullable=False, index=True)
    hand_no: Mapped[int] = mapped_column(Integer, nullable=False)
    button: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    started_at: Mapped[datetime] = _now()
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    table: Mapped[PokerTable] = relationship(back_populates="hands")
    history: Mapped[HandHistory | None] = relationship(back_populates="hand", cascade="all, delete-orphan")


class HandPlayer(Base):
    """Who played a seat in a finished hand, and what they won or lost (P4.6).

    ``player_id`` is a person's id, or null for a bot. It is not a foreign
    key: people seated before P4.1 may have no ``players`` row.
    """

    __tablename__ = "hand_players"
    __table_args__ = (
        CheckConstraint("seat_no BETWEEN 0 AND 8", name="seat_no"),
        CheckConstraint("(player_id IS NULL) = (bot_kind IS NOT NULL)", name="bot_kind"),
    )

    hand_id: Mapped[int] = mapped_column(ForeignKey("hands.id", ondelete="CASCADE"), primary_key=True)
    seat_no: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    player_id: Mapped[str | None] = mapped_column(String(64), index=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    bot_kind: Mapped[str | None] = mapped_column(String(64))
    net: Mapped[int] = mapped_column(BigInteger, nullable=False)
    """Chips won (positive) or lost in the hand."""


class HandHistory(Base):
    """The replayable record of a finished hand (``history.hand_record``)."""

    __tablename__ = "hand_histories"
    __table_args__ = (CheckConstraint("format >= 1", name="format"),)

    hand_id: Mapped[int] = mapped_column(ForeignKey("hands.id", ondelete="CASCADE"), primary_key=True)
    format: Mapped[int] = mapped_column(Integer, nullable=False)
    record: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = _now()

    hand: Mapped[Hand] = relationship(back_populates="history")
