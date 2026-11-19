"""Held seats and the waitlist in the table core (P4.3, rule 2.4).

Each case drives a ``Table`` directly with a clock the test moves, so holds
run out exactly when the rule says.
"""

from __future__ import annotations

import random

import pytest

from rivermind.server import ErrorCode, Table, TableConfig, TableError
from rivermind.server.snapshot import table_from_dict, table_to_dict
from rivermind.server.table import RESERVE_SECONDS

CONFIG = TableConfig(seat_count=3, small_blind=50, big_blind=100)


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def make_table(people: list[int] = (), bots: list[int] = ()) -> tuple[Table, Clock]:  # type: ignore[assignment]
    clock = Clock()
    table = Table(CONFIG, clock)
    for seat in people:
        table.sit(seat, f"p{seat}", f"Player {seat}", 5_000)
    for seat in bots:
        table.sit(seat, f"bot:random:{seat}", f"Bot {seat}", 5_000, bot="random")
    table.drain_events()
    return table, clock


def kinds(table: Table) -> list[str]:
    return [event.kind for event in table.drain_events()]


def code_of(call) -> ErrorCode:  # type: ignore[no-untyped-def]
    with pytest.raises(TableError) as caught:
        call()
    return caught.value.code


def test_an_empty_seat_is_held_for_its_player_only() -> None:
    table, clock = make_table(people=[0])
    assert table.reserve("x", "X") == 1  # the first empty seat
    hold = table.reservations[1]
    assert hold.ready and hold.until == clock.now + RESERVE_SECONDS
    assert kinds(table) == ["reserved"]
    assert table.free_seats() == [2]
    assert code_of(lambda: table.sit(1, "y", "Y", 5_000)) is ErrorCode.SEAT_TAKEN
    assert code_of(lambda: table.reserve("y", "Y", 1)) is ErrorCode.SEAT_TAKEN
    assert code_of(lambda: table.reserve("p0", "Player 0")) is ErrorCode.ALREADY_SEATED
    assert table.reserve("x", "X") == 1  # asking again returns the same hold
    table.sit(1, "x", "X", 5_000)
    assert table.reservations == {} and kinds(table) == ["seated"]


def test_a_hold_runs_out_and_can_be_moved_or_given_up() -> None:
    table, clock = make_table(people=[0])
    table.reserve("x", "X", 2)
    assert table.reserve("x", "X", 1) == 1  # moving gives up the old hold
    assert sorted(table.reservations) == [1] and kinds(table) == ["reserved", "reservation_ended", "reserved"]
    clock.now += RESERVE_SECONDS - 1
    table.settle_seats()
    assert 1 in table.reservations
    clock.now += 1
    table.settle_seats()
    assert table.reservations == {}
    events = table.drain_events()
    assert [(e.kind, e.data) for e in events] == [("reservation_ended", {"seat": 1, "reason": "expired"})]
    table.reserve("x", "X")
    table.cancel_reservation("x")
    assert table.reservations == {} and kinds(table)[-1] == "reservation_ended"
    table.cancel_reservation("x")  # nothing held: nothing happens
    assert kinds(table) == []


def test_a_bot_gives_up_its_seat_at_once_between_hands() -> None:
    table, _ = make_table(people=[0], bots=[1, 2])
    assert table.free_seats() == [] and table.bot_seats() == [1, 2]
    seat = table.reserve("x", "X")
    assert seat == 1 and table.seats[1] is None and table.reservations[1].ready
    events = table.drain_events()
    assert [e.kind for e in events] == ["reserved", "left"]
    assert table.departures[-1].bot and table.departures[-1].chips == 5_000


def test_a_bot_in_a_hand_plays_it_out_before_giving_up_its_seat() -> None:
    table, clock = make_table(people=[0], bots=[1, 2])
    table.start_hand(random.Random(3))
    table.drain_events()
    seat = table.reserve("x", "X")
    hold = table.reservations[seat]
    assert not hold.ready and hold.until is None and hold.bot == f"bot:random:{seat}"
    bot = table.seats[seat]
    assert bot is not None and not bot.leaving  # the bot is not folded out of the hand
    assert table.bot_seats() == [s for s in (1, 2) if s != seat]
    assert code_of(lambda: table.sit(seat, "x", "X", 5_000)) is ErrorCode.SEAT_TAKEN
    clock.now += 500  # time does not run on a hold that is not ready
    table.settle_seats()
    assert seat in table.reservations
    while table.hand_in_progress:
        table.time_out()
    assert table.seats[seat] is None
    assert table.reservations[seat].ready and table.reservations[seat].until == clock.now + RESERVE_SECONDS
    table.sit(seat, "x", "X", 4_000)
    assert table.seats[seat] is not None and table.seats[seat].name == "X"  # type: ignore[union-attr]


def test_giving_up_a_hold_on_a_bot_seat_keeps_the_bot() -> None:
    table, _ = make_table(people=[0], bots=[1, 2])
    table.start_hand(random.Random(1))
    seat = table.reserve("x", "X")
    table.cancel_reservation("x")
    while table.hand_in_progress:
        table.time_out()
    bot = table.seats[seat]
    assert bot is not None and bot.is_bot


def test_the_waitlist_is_first_come_first_served() -> None:
    table, clock = make_table(people=[0, 1])
    assert code_of(lambda: table.join_waitlist("w1", "W1")) is ErrorCode.BAD_REQUEST  # seat 2 is free
    table.sit(2, "p2", "Player 2", 5_000)
    assert code_of(lambda: table.join_waitlist("p2", "Player 2")) is ErrorCode.ALREADY_SEATED
    assert table.join_waitlist("w1", "W1") == 1
    assert table.join_waitlist("w2", "W2") == 2
    assert table.join_waitlist("w1", "W1") == 1  # joining twice keeps the place
    table.drain_events()
    table.leave("p1")
    table.settle_seats()
    assert table.reservations[1].player_id == "w1" and table.waitlist_position("w2") == 1
    assert kinds(table) == ["left", "reserved", "waitlist"]
    # W1 does not come: the seat passes to W2 when the hold runs out.
    clock.now += RESERVE_SECONDS
    table.settle_seats()
    assert table.reservations[1].player_id == "w2" and table.waitlist == []
    table.sit(1, "w2", "W2", 5_000)
    assert table.reservations == {} and table.free_seats() == []


def test_sitting_gives_up_other_holds_and_the_waitlist() -> None:
    table, _ = make_table(people=[0, 1, 2])
    table.join_waitlist("w", "W")
    table.leave_waitlist("w")
    assert table.waitlist == []
    table.leave_waitlist("w")
    table.leave("p2")
    table.reserve("w", "W", 2)
    assert code_of(lambda: table.join_waitlist("w", "W")) is ErrorCode.BAD_REQUEST  # already holds a seat
    table.leave("p1")
    table.sit(1, "w", "W", 5_000)  # sits in another free seat instead
    assert table.reservations == {} and table.free_seats() == [2]


def test_snapshots_keep_holds_and_the_waitlist() -> None:
    table, clock = make_table(people=[0, 1], bots=[2])
    table.start_hand(random.Random(5))
    table.reserve("x", "X")
    table.drain_events()
    full, _ = make_table(people=[0, 1, 2])
    full.join_waitlist("w", "W")
    full.drain_events()
    for original in (table, full):
        snapshot = table_to_dict(original)
        copy = table_from_dict(snapshot, clock)
        assert copy.reservations == original.reservations and copy.waitlist == original.waitlist
        assert table_to_dict(copy) == snapshot
    # A format 1 snapshot, saved before seats could be held, still loads.
    old = table_to_dict(full)
    old["format"] = 1
    del old["reservations"], old["waitlist"]
    restored = table_from_dict(old, clock)
    assert restored.reservations == {} and restored.waitlist == []
    bad = table_to_dict(table)
    bad["reservations"][0]["seat"] = 7
    with pytest.raises(Exception, match="out of range"):
        table_from_dict(bad, clock)
