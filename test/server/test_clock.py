"""Action clocks, time banks and disconnects (P3.3, rules section 13).

Every test reads time from a clock it moves itself; none of them sleeps.
"""

from __future__ import annotations

import asyncio
import random
import time

import pytest

from rivermind.bots import CallingStationPolicy
from rivermind.engine import Action, legal_actions
from rivermind.server import ManualClock, RunnerOptions, Table, TableConfig, TableManager

from .test_runner import BlockingBot, Recorder, instant


class Now:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def table_with(seats: list[int], now: Now, **config: object) -> Table:
    table = Table(TableConfig(len(seats) if seats else 2, 50, 100, **config), clock=now)  # type: ignore[arg-type]
    for seat in seats:
        table.sit(seat, f"p{seat}", f"Player {seat}", 10_000)
    table.drain_events()
    return table


def test_the_clock_defaults() -> None:
    config = TableConfig(6, 50, 100)
    assert (config.action_seconds, config.time_bank_seconds, config.bank_refill_seconds) == (20.0, 30.0, 2.0)
    with pytest.raises(ValueError):
        TableConfig(6, 50, 100, action_seconds=0)
    with pytest.raises(ValueError):
        TableConfig(6, 50, 100, time_bank_seconds=-1)


def test_a_turn_runs_the_action_time_then_the_bank_then_times_out() -> None:
    now = Now()
    table = table_with([0, 1, 2], now)
    table.button = 2
    table.start_hand(random.Random(0))  # button S0 acts first, facing the big blind
    turn = table.turn
    assert turn is not None and (turn.seat, turn.started, turn.deadline, turn.final) == (0, 0.0, 20.0, 50.0)
    now.t = 49.9
    assert not table.check_clock()
    now.t = 50.0
    assert table.check_clock()
    hand = table.hand
    assert hand is not None and hand.folded[0]  # facing a bet, the timeout folds
    player = table.seats[0]
    assert player is not None and player.time_bank == 0.0
    kinds = [e.kind for e in table.drain_events()]
    assert kinds[-3:] == ["timed_out", "action", "turn"]
    turn = table.turn
    assert turn is not None and (turn.seat, turn.started, turn.final) == (1, 50.0, 100.0)


def test_acting_late_spends_the_bank_and_hands_refill_it() -> None:
    now = Now()
    table = table_with([0, 1], now)
    table.button = 1
    table.start_hand(random.Random(0))  # heads-up: button S0 is the small blind and acts first
    now.t = 26.5
    table.act("p0", Action.call())  # 6.5 seconds into the bank
    player = table.seats[0]
    assert player is not None and player.time_bank == pytest.approx(23.5)
    turn = table.turn
    assert turn is not None and (turn.seat, turn.started, turn.deadline, turn.final) == (1, 26.5, 46.5, 76.5)
    now.t = 30.0
    table.act("p1", Action.check())  # in time: the bank is untouched
    other = table.seats[1]
    assert other is not None and other.time_bank == 30.0
    table.time_out()  # S1 checks on the flop by timing out, which empties its bank
    while table.hand_in_progress:
        assert table.hand is not None
        table.act_seat(legal_actions(table.hand).seat, Action.check())
    table.start_hand(random.Random(1))
    assert player.time_bank == pytest.approx(25.5)  # refilled by 2 seconds
    assert other.time_bank == 2.0  # emptied by the timeout, then refilled


def test_rules_example_13_timeouts_check_or_fold() -> None:
    """Rules 13.1 example: a timeout checks when it can and folds otherwise."""
    now = Now()
    table = table_with([0, 1, 2, 3, 4], now)
    table.button = 4
    table.start_hand(random.Random(2))  # button S0, small blind S1, big blind S2
    hand = table.hand
    assert hand is not None and (hand.small_blind_seat, hand.big_blind_seat, hand.to_act) == (1, 2, 3)
    for seat in (3, 4, 0):
        table.act_seat(seat, Action.call())
    now.t += 50
    assert table.check_clock()  # the small blind's clock runs out facing 50 more: it folds
    now.t += 50
    assert table.check_clock()  # the big blind with no raise checks
    hand = table.hand
    assert hand is not None and hand.folded[1] and not hand.folded[2]
    assert hand.street.label == "flop" and hand.to_act == 2
    now.t += 50
    assert table.check_clock()  # no one has bet on the flop: S2 checks
    table.act_seat(3, Action.check())
    table.act_seat(4, Action.bet(200))
    table.act_seat(0, Action.call())
    assert table.to_act == 2
    now.t += 50
    assert table.check_clock()  # facing S4's bet: S2 folds
    hand = table.hand
    assert hand is not None and hand.folded[2]
    flop = [(a.seat, a.kind.value) for a in hand.actions if a.street.label == "flop"]
    assert flop == [(2, "check"), (3, "check"), (4, "bet"), (0, "call"), (2, "fold")]


def test_a_disconnected_player_gets_the_action_time_only() -> None:
    now = Now()
    table = table_with([0, 1], now)
    table.button = 1
    table.start_hand(random.Random(0))
    assert table.to_act == 0
    now.t = 5.0
    table.set_connected("p0", False)
    turn = table.turn
    assert turn is not None and (turn.started, turn.final) == (0.0, 20.0)  # same turn, no bank
    now.t = 10.0
    table.set_connected("p0", True)
    turn = table.turn
    assert turn is not None and (turn.started, turn.final) == (0.0, 50.0)  # back: the bank is there
    table.set_connected("p0", False)
    now.t = 20.0
    assert table.check_clock()
    player = table.seats[0]
    assert player is not None and player.time_bank == 30.0  # a disconnected timeout keeps the bank


def play_out(table: Table, now: Now) -> None:
    """Finish a hand: connected players check or call at once, others run out of time."""
    while table.hand_in_progress:
        assert table.hand is not None
        legal = legal_actions(table.hand)
        player = table.seats[legal.seat]
        assert player is not None
        if player.connected and player.player_id != "idle":
            table.act_seat(legal.seat, Action.check() if legal.can_check else Action.call())
        else:
            now.t += 100
            assert table.check_clock()


def test_a_player_disconnected_for_a_full_orbit_is_sat_out() -> None:
    """Rule 13.2: three players dealt in, so three hands away is an orbit."""
    now = Now()
    table = table_with([0, 1, 2], now)
    table.set_connected("p0", False)
    for hand in range(1, 4):
        table.start_hand(random.Random(hand))
        play_out(table, now)
        player = table.seats[0]
        assert player is not None
        assert player.sitting_out == (hand == 3)
    events = [e for e in table.drain_events() if e.kind == "sat_out"]
    assert [(e.data["seat"], e.data["reason"]) for e in events] == [(0, "away")]
    assert not table.start_hand(random.Random(9)).dealt_in[0]


def test_coming_back_resets_the_count() -> None:
    now = Now()
    table = table_with([0, 1, 2], now)
    table.set_connected("p0", False)
    for seed in range(2):
        table.start_hand(random.Random(seed))
        play_out(table, now)
    table.set_connected("p0", True)
    table.set_connected("p0", False)
    for seed in range(2, 4):
        table.start_hand(random.Random(seed))
        play_out(table, now)
    player = table.seats[0]
    assert player is not None and not player.sitting_out and player.absent_hands == 2


def test_a_connected_player_who_only_times_out_is_sat_out_too() -> None:
    now = Now()
    table = Table(TableConfig(3, 50, 100), clock=now)
    table.sit(0, "idle", "Idle", 10_000)
    table.sit(1, "p1", "Player 1", 10_000)
    table.sit(2, "p2", "Player 2", 10_000)
    for seed in range(3):
        table.start_hand(random.Random(seed))
        play_out(table, now)
    player = table.seats[0]
    assert player is not None and player.sitting_out


def test_bots_are_never_sat_out_for_absence() -> None:
    now = Now()
    table = Table(TableConfig(2, 50, 100), clock=now)
    table.sit(0, "bot:x", "Bot", 10_000, bot="random")
    table.sit(1, "p1", "Player 1", 10_000)
    for seed in range(2):
        table.start_hand(random.Random(seed))
        while table.hand_in_progress:
            now.t += 100
            table.check_clock()
    bot = table.seats[0]
    assert bot is not None and not bot.sitting_out and bot.absent_hands == 0


def runner_options(clock: ManualClock) -> RunnerOptions:
    return RunnerOptions(
        hand_pause=0.0, bot_delay=0.0, sleep=instant, clock=clock, rng_factory=lambda: random.Random(4)
    )


def test_the_runner_times_out_a_person_on_its_clock() -> None:
    clock = ManualClock()

    async def main() -> None:
        manager = TableManager({"calling_station": CallingStationPolicy()}, runner_options(clock))
        runner = manager.create(TableConfig(2, 50, 100))
        recorder = Recorder()
        runner.listeners.append(recorder)
        await runner.seat_bot(0, "calling_station")
        await runner.sit(1, "alice", "Alice", 10_000)
        table = runner.table
        started = time.monotonic()
        for _ in range(3):
            await runner.wait_until(lambda t: t.to_act == 1)
            turn = table.turn
            assert turn is not None and turn.seat == 1
            hand, actions = table.hand, len(table.hand.actions) if table.hand else 0
            clock.advance(turn.final - clock.now() - 0.01)
            for _ in range(20):
                await asyncio.sleep(0)
            assert table.hand is hand and table.hand is not None and len(table.hand.actions) == actions
            timeouts = sum(1 for e in recorder.events if e.kind == "timed_out")
            clock.advance(0.01)
            await runner.wait_until(lambda t: t.hand is not hand)
            timed_out = [e for e in recorder.events if e.kind == "timed_out"]
            assert len(timed_out) == timeouts + 1 and timed_out[-1].data["seat"] == 1
        assert time.monotonic() - started < 5
        await manager.shutdown()

    asyncio.run(main())


def test_the_runner_times_out_a_bot_that_is_too_slow() -> None:
    clock = ManualClock()
    bot = BlockingBot()

    async def main() -> None:
        manager = TableManager(
            {"blocking": bot, "calling_station": CallingStationPolicy()}, runner_options(clock)
        )
        runner = manager.create(TableConfig(2, 50, 100))
        recorder = Recorder()
        runner.listeners.append(recorder)
        await runner.seat_bot(0, "blocking")
        await runner.seat_bot(1, "calling_station")
        while bot.calls == 0:
            await asyncio.sleep(0.01)
        hand = runner.table.hand
        clock.advance(51)
        await runner.wait_until(lambda t: t.hand is not hand)
        (timed_out,) = [e for e in recorder.events if e.kind == "timed_out"]
        assert timed_out.data["seat"] == 0
        bot.release.set()  # its late answer is ignored
        await runner.wait_until(lambda t: t.hand_no >= 3)
        await manager.shutdown()

    asyncio.run(main())
