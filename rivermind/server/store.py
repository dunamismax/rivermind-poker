"""Durable tables in PostgreSQL (P3.5).

``TableStore`` keeps each open table's snapshot (``snapshot.table_to_dict``)
in ``poker_tables.state``, mirrors its occupied seats into ``seats``, records
every hand dealt in ``hands`` and stores each finished hand's replayable
history in ``hand_histories``. ``TableSaver`` is the runner hook that saves a
table after every change and before anyone hears of it, so a player never
sees a state the server could lose. At startup ``load_open`` returns the
tables to restore. A closed table keeps its row and hands but drops its state.

The store is synchronous (SQLAlchemy 2 over psycopg 3). The saver calls it in
a worker thread, so a slow database never blocks other tables' event loop.
If a save fails the table keeps playing from memory, the failure is logged
and the next save catches up, finished hands included.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import Engine, case, delete, func, null, select, update
from sqlalchemy.dialects.postgresql import insert

from rivermind.db import Hand, HandHistory, PokerTable, Seat
from rivermind.engine.history import FORMAT as HISTORY_FORMAT
from rivermind.engine.history import hand_record

from .snapshot import FORMAT as SNAPSHOT_FORMAT
from .snapshot import table_to_dict
from .table import Event, Table

if TYPE_CHECKING:
    from .runner import TableRunner

log = logging.getLogger("rivermind.server")


@dataclass(frozen=True, slots=True)
class FinishedHand:
    hand_no: int
    button: int
    record: dict[str, Any]
    """A ``history.hand_record`` document."""


@dataclass(frozen=True, slots=True)
class SavedTable:
    table_id: str
    name: str
    state: dict[str, Any]


@dataclass(frozen=True, slots=True)
class SeatRow:
    seat_no: int
    display_name: str
    bot_kind: str | None
    stack: int
    sitting_out: bool


def seat_rows(table: Table) -> list[SeatRow]:
    return [
        SeatRow(seat, player.name, player.bot, table.stack_of(seat), player.sitting_out)
        for seat, player in table.players()
    ]


class TableStore:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def save(
        self,
        table_id: str,
        name: str,
        state: dict[str, Any],
        seats: Sequence[SeatRow],
        current: tuple[int, int] | None,
        finished: Sequence[FinishedHand] = (),
    ) -> None:
        """Save a table's snapshot, its seats and its hands in one transaction.

        ``current`` is the hand number and button of the hand in the
        snapshot, if any; ``finished`` are hands that ended since the last save.
        """
        config = state["config"]
        with self.engine.begin() as conn:
            table_row = insert(PokerTable).values(
                id=table_id,
                name=name,
                seat_count=config["seat_count"],
                small_blind=config["small_blind"],
                big_blind=config["big_blind"],
                ante=config["ante"],
                min_buy_in=config["min_buy_in"],
                max_buy_in=config["max_buy_in"],
                status="open",
                state=state,
                state_format=SNAPSHOT_FORMAT,
            )
            conn.execute(
                table_row.on_conflict_do_update(
                    index_elements=[PokerTable.id],
                    set_={"name": name, "state": state, "state_format": SNAPSHOT_FORMAT, "updated_at": func.now()},
                    where=PokerTable.status == "open",
                )
            )
            occupied = [row.seat_no for row in seats]
            conn.execute(delete(Seat).where(Seat.table_id == table_id, Seat.seat_no.not_in(occupied)))
            for row in seats:
                seat = insert(Seat).values(
                    table_id=table_id,
                    seat_no=row.seat_no,
                    display_name=row.display_name,
                    is_bot=row.bot_kind is not None,
                    bot_kind=row.bot_kind,
                    stack=row.stack,
                    sitting_out=row.sitting_out,
                )
                conn.execute(
                    seat.on_conflict_do_update(
                        index_elements=[Seat.table_id, Seat.seat_no],
                        set_={
                            # A different occupant is a new arrival. SET sees the old row.
                            "joined_at": case(
                                (Seat.display_name == seat.excluded.display_name, Seat.joined_at),
                                else_=func.now(),
                            ),
                            "display_name": seat.excluded.display_name,
                            "is_bot": seat.excluded.is_bot,
                            "bot_kind": seat.excluded.bot_kind,
                            "stack": seat.excluded.stack,
                            "sitting_out": seat.excluded.sitting_out,
                        },
                    )
                )
            for hand in finished:
                hand_id = conn.execute(
                    insert(Hand)
                    .values(table_id=table_id, hand_no=hand.hand_no, button=hand.button, ended_at=func.now())
                    .on_conflict_do_update(
                        constraint="uq_hands_table_id_hand_no",
                        set_={"ended_at": func.coalesce(Hand.ended_at, func.now())},
                    )
                    .returning(Hand.id)
                ).scalar_one()
                conn.execute(
                    insert(HandHistory)
                    .values(hand_id=hand_id, format=HISTORY_FORMAT, record=hand.record)
                    .on_conflict_do_nothing(index_elements=[HandHistory.hand_id])
                )
            if current is not None:
                hand_no, button = current
                conn.execute(
                    insert(Hand)
                    .values(table_id=table_id, hand_no=hand_no, button=button)
                    .on_conflict_do_nothing(constraint="uq_hands_table_id_hand_no")
                )

    def close(self, table_id: str) -> None:
        """Mark a table closed: it is not restored again, and its state is dropped."""
        with self.engine.begin() as conn:
            conn.execute(
                update(PokerTable)
                .where(PokerTable.id == table_id)
                .values(status="closed", state=null(), state_format=None, updated_at=func.now())
            )
            conn.execute(delete(Seat).where(Seat.table_id == table_id))

    def load_open(self) -> list[SavedTable]:
        """Every open table with a saved state, oldest first."""
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(PokerTable.id, PokerTable.name, PokerTable.state, PokerTable.state_format)
                .where(PokerTable.status == "open", PokerTable.state.is_not(None))
                .order_by(PokerTable.created_at, PokerTable.id)
            ).all()
        saved = []
        for table_id, name, state, state_format in rows:
            if state_format != SNAPSHOT_FORMAT:
                log.warning("Table %s has snapshot format %s, which this server cannot restore", table_id, state_format)
                continue
            saved.append(SavedTable(table_id, name, state))
        return saved

    def history(self, table_id: str, hand_no: int) -> dict[str, Any] | None:
        """The stored history document of a finished hand."""
        with self.engine.connect() as conn:
            return conn.execute(
                select(HandHistory.record)
                .join(Hand, Hand.id == HandHistory.hand_id)
                .where(Hand.table_id == table_id, Hand.hand_no == hand_no)
            ).scalar_one_or_none()


class TableSaver:
    """A ``before_publish`` hook that saves its table before each change is published."""

    def __init__(self, store: TableStore) -> None:
        self.store = store
        self.pending: list[FinishedHand] = []
        """Finished hands not yet stored, kept until a save succeeds."""
        self.failures = 0

    async def __call__(self, runner: TableRunner, events: Sequence[Event]) -> None:
        table = runner.table
        for hand_no, final in table.drain_finished():
            self.pending.append(FinishedHand(hand_no, final.button, hand_record(final)))
        table.drain_departures()  # chips go back to a wallet from P4.2
        state = table_to_dict(table)
        current = (table.hand_no, table.hand.button) if table.hand is not None else None
        finished = list(self.pending)
        try:
            await asyncio.to_thread(
                self.store.save, runner.table_id, runner.name, state, seat_rows(table), current, finished
            )
        except Exception:
            self.failures += 1
            log.exception("Could not save table %s; it plays on from memory", runner.table_id)
            return
        del self.pending[: len(finished)]


__all__ = ["FinishedHand", "SavedTable", "SeatRow", "TableSaver", "TableStore", "seat_rows"]
