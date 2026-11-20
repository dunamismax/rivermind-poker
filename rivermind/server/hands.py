"""The hands each player played, for their hand history (P4.6).

When a hand ends the table records who was dealt into each seat
(``table.Finished``). With a database, ``TableStore.save`` writes those seats
to ``hand_players`` beside the hand's replayable history, and
``DatabaseHands`` reads them back. Without one, ``MemoryHands`` keeps the
newest hands in memory. Either way a player is shown only hands they were
dealt into, and ``views.hand_detail`` leaves out every card they may not see.
Hands from a practice table (P6.0b) are marked ``practice``, to label them and
to keep them out of competitive stats.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from sqlalchemy import Engine, select

from rivermind.db import Hand, HandHistory, HandPlayer, PokerTable
from rivermind.engine.history import hand_record

from .table import Finished

MEMORY_HANDS = 5_000
"""Hands a server without a database keeps, newest first."""
MEMORY_PER_PLAYER = 200


@dataclass(frozen=True, slots=True)
class HandSeatRecord:
    """A seat dealt into a finished hand. ``player_id`` is ``None`` for a bot."""

    seat: int
    player_id: str | None
    name: str
    bot: str | None
    net: int
    """Chips won (positive) or lost in the hand."""


@dataclass(frozen=True, slots=True)
class PlayedHand:
    hand_id: str
    table_id: str
    table_name: str
    hand_no: int
    at: float
    """When the hand ended, in seconds since the epoch."""
    record: dict[str, Any]
    """The ``history.hand_record`` document."""
    seats: tuple[HandSeatRecord, ...]
    practice: bool = False
    """Played at a practice table (P6.0b), so not counted in competitive stats."""

    def seat_of(self, player_id: str) -> int | None:
        return next((s.seat for s in self.seats if s.player_id == player_id), None)


def seat_records(finished: Finished) -> tuple[HandSeatRecord, ...]:
    """Who played each seat dealt into the hand, and what they won or lost."""
    state = finished.state
    records = []
    for seat, who in enumerate(finished.seats):
        if who is None:
            continue
        net = state.stacks[seat] - (state.starting_stacks[seat] or 0)
        records.append(HandSeatRecord(seat, None if who.bot else who.player_id, who.name, who.bot, net))
    return tuple(records)


class HandArchive(Protocol):
    def played(self, player_id: str, limit: int, before: str | None = None) -> list[PlayedHand]:
        """The player's hands, newest first, older than ``before`` if given."""
        ...

    def get(self, hand_id: str) -> PlayedHand | None: ...


class MemoryHands:
    """The newest finished hands, for a server without a database."""

    def __init__(self, limit: int = MEMORY_HANDS, per_player: int = MEMORY_PER_PLAYER) -> None:
        self._hands: OrderedDict[int, PlayedHand] = OrderedDict()
        self._by_player: dict[str, deque[int]] = {}
        self._limit = limit
        self._per_player = per_player
        self._next = 1
        self._lock = threading.Lock()

    def add(self, table_id: str, table_name: str, finished: Finished, practice: bool = False) -> PlayedHand:
        seats = seat_records(finished)
        with self._lock:
            hand_id = self._next
            self._next += 1
            hand = PlayedHand(
                str(hand_id),
                table_id,
                table_name,
                finished.hand_no,
                time.time(),
                hand_record(finished.state),
                seats,
                practice,
            )
            self._hands[hand_id] = hand
            for seat in seats:
                if seat.player_id is not None:
                    self._by_player.setdefault(seat.player_id, deque(maxlen=self._per_player)).append(hand_id)
            while len(self._hands) > self._limit:
                self._hands.popitem(last=False)
        return hand

    def played(self, player_id: str, limit: int, before: str | None = None) -> list[PlayedHand]:
        cutoff = _number(before)
        with self._lock:
            ids = list(self._by_player.get(player_id, ()))
            hands = [self._hands[i] for i in reversed(ids) if i in self._hands and (cutoff is None or i < cutoff)]
        return hands[:limit]

    def get(self, hand_id: str) -> PlayedHand | None:
        number = _number(hand_id)
        with self._lock:
            return None if number is None else self._hands.get(number)


def _number(value: str | None) -> int | None:
    if value is None or not value.isdigit() or len(value) > 18:
        return None
    return int(value)


class DatabaseHands:
    """Finished hands in PostgreSQL (``hands``, ``hand_histories`` and ``hand_players``)."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def _load(self, hand_ids: Sequence[int]) -> list[PlayedHand]:
        if not hand_ids:
            return []
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    Hand.id, Hand.table_id, PokerTable.name, Hand.hand_no, Hand.ended_at, HandHistory.record, PokerTable.practice
                )
                .join(HandHistory, HandHistory.hand_id == Hand.id)
                .join(PokerTable, PokerTable.id == Hand.table_id)
                .where(Hand.id.in_(hand_ids))
            ).all()
            seat_rows = conn.execute(
                select(
                    HandPlayer.hand_id,
                    HandPlayer.seat_no,
                    HandPlayer.player_id,
                    HandPlayer.display_name,
                    HandPlayer.bot_kind,
                    HandPlayer.net,
                )
                .where(HandPlayer.hand_id.in_(hand_ids))
                .order_by(HandPlayer.seat_no)
            ).all()
        seats: dict[int, list[HandSeatRecord]] = {}
        for hand_id, seat_no, player_id, display_name, bot_kind, net in seat_rows:
            seats.setdefault(hand_id, []).append(HandSeatRecord(seat_no, player_id, display_name, bot_kind, net))
        found = {
            hand_id: PlayedHand(
                str(hand_id),
                table_id,
                name,
                hand_no,
                ended_at.timestamp() if ended_at is not None else 0.0,
                record,
                tuple(seats.get(hand_id, ())),
                practice,
            )
            for hand_id, table_id, name, hand_no, ended_at, record, practice in rows
        }
        return [found[i] for i in hand_ids if i in found]

    def played(self, player_id: str, limit: int, before: str | None = None) -> list[PlayedHand]:
        query = select(HandPlayer.hand_id).where(HandPlayer.player_id == player_id)
        cutoff = _number(before)
        if cutoff is not None:
            query = query.where(HandPlayer.hand_id < cutoff)
        with self.engine.connect() as conn:
            ids = list(conn.execute(query.order_by(HandPlayer.hand_id.desc()).limit(limit)).scalars())
        return self._load(ids)

    def get(self, hand_id: str) -> PlayedHand | None:
        number = _number(hand_id)
        if number is None:
            return None
        found = self._load([number])
        return found[0] if found else None
