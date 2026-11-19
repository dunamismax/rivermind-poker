"""Table snapshots (P3.5): a table rebuilt from its JSON plays on identically."""

from __future__ import annotations

import json
import random
from typing import Any

import pytest

from rivermind.engine import legal_actions
from rivermind.engine.history import FormatError
from rivermind.server import Table, TableConfig, TableError
from rivermind.server.snapshot import table_from_dict, table_to_dict


def drain(table: Table) -> list[tuple[int, str, dict[str, Any]]]:
    events = [(e.seq, e.kind, e.data) for e in table.drain_events()]
    table.drain_finished()
    table.drain_departures()
    return events


def reload(table: Table, clock: Any) -> Table:
    """Through JSON text, as PostgreSQL stores it."""
    return table_from_dict(json.loads(json.dumps(table_to_dict(table))), clock)


def play(seat_count: int, *, restore_every_step: bool, steps: int = 3_000) -> tuple[list[Any], dict[str, Any], int]:
    """Random seating, connections, clocks and play, optionally reloading the table after every step."""
    rng = random.Random(1000 + seat_count)
    now = [1_000_000.0]

    def clock() -> float:
        return now[0]

    config = TableConfig(seat_count, 5, 10, ante=rng.choice((0, 1)), action_seconds=5, time_bank_seconds=8)
    table = Table(config, clock)
    events: list[Any] = []
    next_id = hands = 0
    for _ in range(steps):
        roll = rng.random()
        seated = [p.player_id for _, p in table.players()]
        try:
            if roll < 0.07:
                next_id += 1
                bot = "random" if rng.random() < 0.3 else None
                amount = rng.randint(config.min_buy_in, config.max_buy_in)
                table.sit(rng.randrange(seat_count), f"n{next_id}", f"N{next_id}", amount, bot=bot)
            elif roll < 0.09 and seated:
                table.leave(rng.choice(seated))
            elif roll < 0.12 and seated:
                table.sit_out(rng.choice(seated))
            elif roll < 0.16 and seated:
                table.sit_in(rng.choice(seated))
            elif roll < 0.19 and seated:
                table.rebuy(rng.choice(seated), rng.randint(1, config.max_buy_in))
            elif roll < 0.24 and seated:
                table.set_connected(rng.choice(seated), rng.random() < 0.5)
            elif roll < 0.30:
                now[0] += rng.choice((1.0, 4.0, 9.0, 20.0))
                table.check_clock()
            elif table.hand_in_progress:
                assert table.hand is not None
                legal = legal_actions(table.hand)
                now[0] += rng.random() * 3
                table.act_seat(legal.seat, rng.choice(legal.options()))
            elif table.can_start():
                table.start_hand(rng)
                hands += 1
        except TableError:
            pass
        events.extend(drain(table))
        if restore_every_step:
            table = reload(table, clock)
    return events, table_to_dict(table), hands


@pytest.mark.parametrize("seat_count", [2, 3, 6, 9])
def test_a_reloaded_table_plays_on_identically(seat_count: int) -> None:
    events, final, hands = play(seat_count, restore_every_step=False)
    reloaded_events, reloaded_final, _ = play(seat_count, restore_every_step=True)
    assert hands > 40
    kinds = {kind for _, kind, _ in events}
    assert {"timed_out", "disconnected", "sat_out", "rebought", "left", "hand_ended"} <= kinds
    assert reloaded_events == events
    assert reloaded_final == final


def test_snapshots_round_trip_mid_hand_with_a_turn() -> None:
    table = Table(TableConfig(6, 50, 100), lambda: 5.0)
    for seat in range(4):
        table.sit(seat, f"p{seat}", f"P{seat}", 10_000, bot="heuristic" if seat else None)
    table.start_hand(random.Random(3))
    drain(table)
    snapshot = table_to_dict(table)
    assert snapshot["format"] == 1 and snapshot["kind"] == "table" and snapshot["turn"] is not None
    again = table_from_dict(json.loads(json.dumps(snapshot)))
    assert table_to_dict(again) == snapshot
    assert again.turn == table.turn and again.hand == table.hand and again.seats == table.seats


def test_a_snapshot_needs_drained_events() -> None:
    table = Table(TableConfig(2, 50, 100))
    table.sit(0, "p0", "P0", 10_000)
    with pytest.raises(ValueError):
        table_to_dict(table)


@pytest.mark.parametrize(
    "change",
    [
        lambda d: d.update(format=2),
        lambda d: d.update(kind="hand_state"),
        lambda d: d.pop("seats"),
        lambda d: d.update(seats=d["seats"][:1]),
        lambda d: d["hand"].update(format=99),
        lambda d: d["seats"][0].update(stack="lots"),
    ],
)
def test_bad_snapshots_are_refused(change: Any) -> None:
    table = Table(TableConfig(2, 50, 100))
    table.sit(0, "p0", "P0", 10_000)
    table.sit(1, "p1", "P1", 10_000)
    table.start_hand(random.Random(0))
    drain(table)
    snapshot = json.loads(json.dumps(table_to_dict(table)))
    change(snapshot)
    with pytest.raises(FormatError):
        table_from_dict(snapshot)
