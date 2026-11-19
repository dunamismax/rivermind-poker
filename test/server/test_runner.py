"""Tables as asyncio tasks (P3.2): automatic hands, bots off the event loop, requests."""

from __future__ import annotations

import asyncio
import random
import threading
import time
from collections.abc import Sequence

import pytest

from rivermind.bots import CallingStationPolicy, HeuristicPolicy, RandomPolicy
from rivermind.engine import Action
from rivermind.engine.view import SeatView
from rivermind.server import (
    ErrorCode,
    Event,
    ManualClock,
    RunnerOptions,
    Table,
    TableConfig,
    TableError,
    TableManager,
    TableRunner,
    default_bots,
)


async def instant(_: float) -> None:
    await asyncio.sleep(0)


def options(seed: int = 0, **overrides: object) -> RunnerOptions:
    values: dict[str, object] = dict(
        hand_pause=0.0, bot_delay=0.0, sleep=instant, clock=ManualClock(), rng_factory=lambda: random.Random(seed)
    )
    values.update(overrides)
    return RunnerOptions(**values)  # type: ignore[arg-type]


class Recorder:
    """A listener that keeps every published event and checks their order."""

    def __init__(self) -> None:
        self.events: list[Event] = []

    async def __call__(self, runner: TableRunner, events: Sequence[Event]) -> None:
        for event in events:
            if self.events:
                assert event.seq == self.events[-1].seq + 1
            self.events.append(event)

    def chips_bought(self) -> int:
        total = 0
        for event in self.events:
            if event.kind == "seated":
                total += event.data["stack"]
            elif event.kind == "rebought":
                total += event.data["amount"]
            elif event.kind == "left":
                total -= event.data["stack"]
        return total


def table_chips(table: Table) -> int:
    pot = table.hand.pot if table.hand_in_progress and table.hand is not None else 0
    return pot + sum(table.stack_of(seat) for seat, _ in table.players())


@pytest.mark.parametrize("seat_count", [2, 6, 9])
def test_bot_tables_deal_hands_automatically(seat_count: int) -> None:
    async def main() -> None:
        manager = TableManager(default_bots(), options(seat_count))
        runner = manager.create(TableConfig(seat_count, 50, 100))
        recorder = Recorder()
        runner.listeners.append(recorder)
        kinds = ["random", "calling_station", "heuristic"]
        for seat in range(seat_count):
            await runner.seat_bot(seat, kinds[seat % 3])
        await runner.wait_until(lambda t: t.hand_no >= 40 and not t.hand_in_progress, timeout=60)
        await manager.shutdown()
        assert not runner.running
        table = runner.table
        assert table_chips(table) == recorder.chips_bought()
        ended = [e for e in recorder.events if e.kind == "hand_ended"]
        assert len(ended) >= 40
        assert [e.data["hand_no"] for e in ended] == list(range(1, len(ended) + 1))
        names = [p.name for _, p in table.players()]
        assert all("bot" in name.lower() or "RiverMind" in name for name in names)  # D-7

    asyncio.run(main())


def test_busted_bots_buy_in_again() -> None:
    async def main() -> None:
        manager = TableManager({"random": RandomPolicy()}, options(3))
        runner = manager.create(TableConfig(2, 50, 100))
        recorder = Recorder()
        runner.listeners.append(recorder)
        await runner.seat_bot(0, "random")
        await runner.seat_bot(1, "random")
        await runner.wait_until(lambda t: any(e.kind == "rebought" for e in recorder.events), timeout=60)
        await manager.shutdown()
        assert runner.table.hand_no > 1

    asyncio.run(main())


def test_a_change_is_saved_and_published_even_if_its_caller_is_cancelled() -> None:
    """A socket that closes mid-request cancels its handler (Starlette's test
    client does so at once). The change it asked for is still saved, finishes
    its bookkeeping and is published, so the store never falls a change behind
    the table and departing chips are never paid twice."""

    async def main() -> None:
        manager = TableManager(default_bots(), options())
        runner = manager.create(TableConfig(6, 50, 100))
        await runner.sit(2, "alice", "Alice", 10_000)
        started = threading.Event()
        release = threading.Event()
        saved: list[int] = []
        """The seq of each change whose save returned, as TableSaver's bookkeeping runs."""

        async def slow_save(r: TableRunner, events: Sequence[Event]) -> None:
            def write() -> None:
                started.set()
                assert release.wait(5)

            await asyncio.to_thread(write)
            saved.append(r.table.seq)

        recorder = Recorder()
        runner.before_publish.append(slow_save)
        runner.listeners.append(recorder)
        caller = asyncio.ensure_future(runner.set_connected("alice", False))
        while not started.is_set():
            await asyncio.sleep(0.001)
        caller.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await caller
        await runner.wait_until(lambda t: bool(saved), timeout=5)
        await manager.shutdown()
        alice = runner.table.seats[2]
        assert alice is not None and not alice.connected
        assert saved == [runner.table.seq]
        assert recorder.events and recorder.events[-1].seq == runner.table.seq  # published after its save

    asyncio.run(main())


def test_hands_wait_for_a_second_player() -> None:
    async def main() -> None:
        manager = TableManager(default_bots(), options())
        runner = manager.create(TableConfig(6, 50, 100))
        await runner.sit(2, "alice", "Alice", 10_000)
        for _ in range(20):
            await asyncio.sleep(0)
        assert runner.table.hand is None
        await runner.seat_bot(4, "calling_station")
        await runner.wait_until(lambda t: t.hand_no == 1)
        await manager.shutdown()

    asyncio.run(main())


def test_a_person_plays_with_bots_and_the_table_waits_for_them() -> None:
    async def main() -> None:
        manager = TableManager(default_bots(), options(11))
        runner = manager.create(TableConfig(3, 50, 100))
        await runner.seat_bot(0, "calling_station")
        await runner.seat_bot(1, "heuristic")
        await runner.sit(2, "alice", "Alice", 10_000)
        table = runner.table
        played = 0
        while played < 10:
            await runner.wait_until(lambda t: t.to_act == 2)
            hand = table.hand
            assert hand is not None
            before = len(hand.actions)
            for _ in range(10):
                await asyncio.sleep(0)
            assert table.hand is hand and table.to_act == 2  # nothing happens until Alice acts
            with pytest.raises(TableError) as caught:
                await runner.act("bot:calling_station:1", Action.call())
            assert caught.value.code is ErrorCode.NOT_YOUR_TURN
            legal = table.view(2)
            assert legal is not None and legal.legal is not None
            await runner.act("alice", Action.check() if legal.legal.can_check else Action.call())
            assert table.hand is not hand
            assert table.hand is not None and len(table.hand.actions) == before + 1 or table.hand.is_over
            played += 1
        await runner.leave("alice")
        await runner.wait_until(lambda t: t.seat_of("alice") is None)
        hands = table.hand_no
        await runner.wait_until(lambda t: t.hand_no >= hands + 3)  # the bots play on
        await manager.shutdown()

    asyncio.run(main())


class BlockingBot:
    """Decides only when released, recording the thread it ran on."""

    name = "blocking"

    def __init__(self) -> None:
        self.release = threading.Event()
        self.threads: list[int] = []
        self.calls = 0

    def act(self, view: SeatView, rng: random.Random) -> Action:
        self.calls += 1
        self.threads.append(threading.get_ident())
        self.release.wait(5)
        assert view.legal is not None
        return Action.check() if view.legal.can_check else Action.call()


def test_bots_decide_off_the_event_loop() -> None:
    bot = BlockingBot()

    async def main() -> None:
        manager = TableManager({"blocking": bot, "calling_station": CallingStationPolicy()}, options(5))
        slow = manager.create(TableConfig(2, 50, 100))
        fast = manager.create(TableConfig(2, 50, 100))
        await slow.seat_bot(0, "blocking")
        await slow.seat_bot(1, "blocking")
        await fast.seat_bot(0, "calling_station")
        await fast.seat_bot(1, "calling_station")
        # While the slow table's bot is stuck thinking, the other table keeps playing.
        await fast.wait_until(lambda t: t.hand_no >= 20, timeout=30)
        assert bot.calls == 1 and slow.table.hand_no == 1
        bot.release.set()
        await slow.wait_until(lambda t: t.hand_no >= 3, timeout=30)
        await manager.shutdown()

    loop_thread = threading.get_ident()
    asyncio.run(main())
    assert bot.threads and all(thread != loop_thread for thread in bot.threads)


def test_a_bot_decision_is_dropped_if_the_table_moved_on() -> None:
    bot = BlockingBot()

    async def main() -> None:
        manager = TableManager({"blocking": bot, "calling_station": CallingStationPolicy()}, options(8))
        runner = manager.create(TableConfig(3, 50, 100))
        await runner.seat_bot(0, "calling_station")
        await runner.seat_bot(1, "calling_station")
        thinker = await runner.seat_bot(2, "blocking")
        await runner.wait_until(lambda t: t.to_act == 2)
        while bot.calls == 0:
            await asyncio.sleep(0.01)
        # The bot is told to leave while it thinks: it folds at once (rule 2.3).
        await runner.leave(thinker)
        hand = runner.table.hand
        assert hand is not None and hand.folded[2]
        bot.release.set()
        await runner.wait_until(lambda t: t.seat_of(thinker) is None)
        hands = runner.table.hand_no
        await runner.wait_until(lambda t: t.hand_no >= hands + 2)
        await manager.shutdown()

    asyncio.run(main())


class BrokenBot:
    name = "broken"

    def act(self, view: SeatView, rng: random.Random) -> Action:
        raise RuntimeError("no idea")


class IllegalBot:
    name = "illegal"

    def act(self, view: SeatView, rng: random.Random) -> Action:
        return Action.bet(1)


def test_a_failing_bot_times_out_instead_of_stopping_the_table() -> None:
    async def main() -> None:
        manager = TableManager({"broken": BrokenBot(), "illegal": IllegalBot()}, options(2))
        runner = manager.create(TableConfig(2, 50, 100))
        await runner.seat_bot(0, "broken")
        await runner.seat_bot(1, "illegal")
        await runner.wait_until(lambda t: t.hand_no >= 5, timeout=30)
        assert runner.running
        await manager.shutdown()

    asyncio.run(main())


def test_requests_are_refused_with_codes() -> None:
    async def main() -> None:
        manager = TableManager(default_bots(), options())
        runner = manager.create(TableConfig(2, 50, 100), name="Heads-up")
        assert manager.get(runner.table_id) is runner and runner.name == "Heads-up"
        with pytest.raises(TableError) as caught:
            await runner.seat_bot(0, "nonsense")
        assert caught.value.code is ErrorCode.BAD_REQUEST
        with pytest.raises(TableError) as caught:
            await runner.sit(0, "alice", "Alice", 1)
        assert caught.value.code is ErrorCode.BAD_BUY_IN
        await manager.close(runner.table_id)
        assert manager.get(runner.table_id) is None

    asyncio.run(main())


def test_pauses_use_the_injected_sleep() -> None:
    slept: list[float] = []

    async def record(seconds: float) -> None:
        slept.append(seconds)
        await asyncio.sleep(0)

    async def main() -> None:
        manager = TableManager(
            {"calling_station": CallingStationPolicy(), "heuristic": HeuristicPolicy()},
            options(1, hand_pause=2.5, bot_delay=0.75, sleep=record),
        )
        runner = manager.create(TableConfig(2, 50, 100))
        await runner.seat_bot(0, "calling_station")
        await runner.seat_bot(1, "heuristic")
        started = time.monotonic()
        await runner.wait_until(lambda t: t.hand_no >= 3)
        await manager.shutdown()
        assert time.monotonic() - started < 5  # no real waiting
        assert 2.5 in slept and 0.75 in slept

    asyncio.run(main())
