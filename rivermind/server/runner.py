"""Tables as asyncio tasks (P3.2).

A ``TableRunner`` owns one ``Table``. Its task deals a new hand whenever at
least two players are dealt in, asks bots for their decisions and waits for
people to act. Every change, whether from a player request or from the task
itself, happens under the runner's lock, so changes are applied one at a
time and published in order. Publishing hands the table's new events to each
listener; P3.5 saves the table first, so nothing is shown before it is safe.

Bot decisions run in a worker thread (``asyncio.to_thread``) because a bot
may take milliseconds or more to decide, which would stall every other table
on the event loop. Engine transitions themselves take microseconds and run
on the loop. If the table changed while a bot was thinking, its decision is
dropped and it is asked again.

While a person is to act, the task waits for their request or for their
turn's deadline on the runner's clock, then times them out (P3.3). A bot
that has not decided by its deadline is timed out the same way.

Live tables shuffle with ``secrets.SystemRandom`` (D-8). Tests pass a seeded
generator, an instant ``sleep`` and a ``ManualClock``.
"""

from __future__ import annotations

import asyncio
import logging
import random
import secrets
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field

from rivermind.bots import Policy
from rivermind.engine import Action

from .clock import Clock, SystemClock
from .table import Departure, ErrorCode, Event, Table, TableConfig, TableError

log = logging.getLogger("rivermind.server")

Listener = Callable[["TableRunner", Sequence[Event]], Awaitable[None]]
Sleep = Callable[[float], Awaitable[object]]

BOT_LABELS = {"random": "Random bot", "calling_station": "Calling bot", "heuristic": "RiverMind Easy"}


@dataclass
class RunnerOptions:
    """Timing and bot behaviour shared by the tables a manager runs."""

    hand_pause: float = 3.0
    """Seconds between the end of one hand and the start of the next."""
    bot_delay: float = 0.6
    """Seconds a bot waits before acting, so people can follow the play."""
    bot_rebuy: bool = True
    """Bots that lose every chip buy in again for the maximum."""
    sleep: Sleep = field(default=asyncio.sleep)
    """Waits for the pauses above."""
    clock: Clock = field(default_factory=SystemClock)
    """Times each turn (P3.3)."""
    rng_factory: Callable[[], random.Random] = field(default=secrets.SystemRandom)
    """Makes each table's dealing generator (D-8)."""


class TableRunner:
    def __init__(
        self,
        table_id: str,
        table: Table,
        bots: Mapping[str, Policy],
        options: RunnerOptions | None = None,
        *,
        name: str = "",
    ) -> None:
        self.table_id = table_id
        self.table = table
        self.name = name or table_id
        self.bots = dict(bots)
        self.options = options or RunnerOptions()
        self.rng = self.options.rng_factory()
        # Bots' own choices need no cryptographic generator, only an unseeded one.
        self.bot_rng = random.Random(self.rng.getrandbits(64))
        self.lock = asyncio.Lock()
        self.listeners: list[Listener] = []
        self.before_publish: list[Callable[[TableRunner, Sequence[Event]], Awaitable[None]]] = []
        """Hooks run under the lock before listeners hear of a change (P3.5 saves here)."""
        self._wake = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._closed = False
        self._bot_count = 0

    # Lifecycle

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._run(), name=f"table-{self.table_id}")

    async def stop(self) -> None:
        self._closed = True
        self._wake.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    # Requests from players. Each raises TableError and leaves the table unchanged on refusal.

    async def sit(self, seat: int, player_id: str, name: str, buy_in: int) -> None:
        async with self.lock:
            self.table.sit(seat, player_id, name, buy_in)
            await self._changed()

    async def seat_bot(self, seat: int, kind: str, buy_in: int | None = None) -> str:
        """Seat a bot of ``kind``, labelled as a bot (D-7). Returns its player id."""
        if kind not in self.bots:
            raise TableError(ErrorCode.BAD_REQUEST, f"no bot called {kind!r}")
        async with self.lock:
            self._bot_count += 1
            player_id = f"bot:{kind}:{self._bot_count}"
            label = BOT_LABELS.get(kind, kind)
            self.table.sit(seat, player_id, f"{label} {seat + 1}", buy_in or self.table.config.max_buy_in, bot=kind)
            await self._changed()
            return player_id

    async def leave(self, player_id: str) -> Departure | None:
        async with self.lock:
            departure = self.table.leave(player_id)
            await self._changed()
            return departure

    async def sit_out(self, player_id: str) -> None:
        async with self.lock:
            self.table.sit_out(player_id)
            await self._changed()

    async def sit_in(self, player_id: str) -> None:
        async with self.lock:
            self.table.sit_in(player_id)
            await self._changed()

    async def set_connected(self, player_id: str, connected: bool) -> None:
        async with self.lock:
            self.table.set_connected(player_id, connected)
            await self._changed()

    async def rebuy(self, player_id: str, amount: int) -> None:
        async with self.lock:
            self.table.rebuy(player_id, amount)
            await self._changed()

    async def act(self, player_id: str, action: Action) -> None:
        async with self.lock:
            seat = self.table.seat_of(player_id)
            if seat is not None and self._is_bot(seat):
                raise TableError(ErrorCode.NOT_YOUR_TURN, "bots act for themselves")
            self.table.act(player_id, action)
            await self._changed()

    # The task

    def _is_bot(self, seat: int) -> bool:
        player = self.table.seats[seat]
        return player is not None and player.is_bot

    async def _changed(self) -> None:
        """Publish the table's new events. Call with the lock held."""
        if self.options.bot_rebuy:
            for seat, player in list(self.table.players()):
                if player.is_bot and player.stack == 0 and not self.table.in_hand(seat):
                    self.table.rebuy(player.player_id, self.table.config.max_buy_in)
        events = self.table.drain_events()
        self._wake.set()
        if not events:
            return
        for hook in self.before_publish:
            await hook(self, events)
        for listener in list(self.listeners):
            try:
                await listener(self, events)
            except Exception:
                log.exception("A listener of table %s failed", self.table_id)

    async def _run(self) -> None:
        while not self._closed:
            self._wake.clear()
            try:
                await self._step()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Table %s failed a step; retrying", self.table_id)
                await self.options.sleep(1.0)

    async def _step(self) -> None:
        table = self.table
        if table.can_start():
            if table.hand is not None and self.options.hand_pause:
                await self.options.sleep(self.options.hand_pause)
            async with self.lock:
                if table.can_start():
                    table.start_hand(self.rng)
                    await self._changed()
            return
        seat = table.to_act
        if seat is not None and self._is_bot(seat):
            await self._bot_turn(seat)
            return
        turn = table.turn if seat is not None else None
        if await self.options.clock.wait(self._wake, turn.final if turn is not None else None):
            return  # something changed; look again
        async with self.lock:
            if table.turn is turn and table.check_clock():
                await self._changed()

    async def _bot_turn(self, seat: int) -> None:
        table = self.table
        state = table.hand
        player = table.seats[seat]
        assert state is not None and player is not None and player.bot is not None
        policy = self.bots[player.bot]
        view = table.view(seat)
        assert view is not None
        turn = table.turn
        if self.options.bot_delay:
            await self.options.sleep(self.options.bot_delay)
        decided = asyncio.Event()
        thinking = asyncio.ensure_future(asyncio.to_thread(policy.act, view, self.bot_rng))
        thinking.add_done_callback(lambda _: decided.set())
        if not await self.options.clock.wait(decided, turn.final if turn is not None else None):
            # Out of time. The thread finishes on its own and its answer is ignored.
            thinking.add_done_callback(lambda task: task.cancelled() or task.exception())
            log.warning("Bot %s at table %s ran out of time", player.bot, self.table_id)
            async with self.lock:
                if table.hand is state and table.check_clock():
                    await self._changed()
            return
        try:
            action = thinking.result()
        except Exception:
            log.exception("Bot %s at table %s failed; timing it out", player.bot, self.table_id)
            action = None
        async with self.lock:
            if table.hand is not state:
                return  # the table moved on while the bot was thinking
            try:
                if action is None:
                    table.time_out()
                else:
                    table.act_seat(seat, action)
            except TableError:
                log.exception("Bot %s at table %s chose an illegal action; timing it out", player.bot, self.table_id)
                table.time_out()
            await self._changed()

    async def wait_until(self, predicate: Callable[[Table], bool], timeout: float = 10.0) -> None:
        """Wait until ``predicate(table)`` holds after a change (for tests and tools)."""
        done = asyncio.Event()

        async def check(runner: TableRunner, events: Sequence[Event]) -> None:
            if predicate(runner.table):
                done.set()

        if predicate(self.table):
            return
        self.listeners.append(check)
        try:
            await asyncio.wait_for(done.wait(), timeout)
        finally:
            self.listeners.remove(check)


class TableManager:
    """Creates, finds and closes the server's tables."""

    def __init__(self, bots: Mapping[str, Policy], options: RunnerOptions | None = None) -> None:
        self.bots = dict(bots)
        self.options = options or RunnerOptions()
        self.tables: dict[str, TableRunner] = {}

    def create(self, config: TableConfig, *, name: str = "", table_id: str | None = None) -> TableRunner:
        """Make a table and start its task. Call from inside the event loop."""
        table_id = table_id or secrets.token_urlsafe(9)
        if table_id in self.tables:
            raise ValueError(f"table {table_id} exists")
        runner = TableRunner(table_id, Table(config, self.options.clock.now), self.bots, self.options, name=name)
        self.tables[table_id] = runner
        runner.start()
        return runner

    def get(self, table_id: str) -> TableRunner | None:
        return self.tables.get(table_id)

    async def close(self, table_id: str) -> None:
        runner = self.tables.pop(table_id, None)
        if runner is not None:
            await runner.stop()

    async def shutdown(self) -> None:
        for table_id in list(self.tables):
            await self.close(table_id)


def default_bots() -> dict[str, Policy]:
    """The Phase 2 bots, by kind."""
    from rivermind.bots import CallingStationPolicy, HeuristicPolicy, RandomPolicy

    return {"random": RandomPolicy(), "calling_station": CallingStationPolicy(), "heuristic": HeuristicPolicy()}


__all__ = ["BOT_LABELS", "RunnerOptions", "TableManager", "TableRunner", "default_bots"]
