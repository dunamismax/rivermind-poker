"""Tables as asyncio tasks (P3.2).

A ``TableRunner`` owns one ``Table``. Its task deals a new hand whenever at
least two players are dealt in, asks bots for their decisions and waits for
people to act. Every change, whether from a player request or from the task
itself, happens under the runner's lock, so changes are applied one at a
time and published in order. Publishing runs the ``before_publish`` hooks,
which save the table (P3.5) so nothing is shown before it is safe, then hands
the table's new events to each listener.

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

Each runner also keeps the table's lobby settings (P4.3): whether it is
private, its invite code, and the kind of bot that ``fill`` puts in empty
seats. After every change the runner settles held seats (rule 2.4) and, while
a person is at the table, fills each free seat nobody is waiting for with a
bot. It wakes when a hold runs out as it does for a turn's deadline.

A practice table (P6.0b) belongs to one guest, named by ``practice``. Its
chips never come from or go back to a wallet: ``refill`` gives a guest who
ran out a fresh practice stack.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import secrets
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import TypeVar

from rivermind.bots import Policy
from rivermind.engine import Action

from .clock import Clock, SystemClock
from .table import Departure, ErrorCode, Event, Table, TableConfig, TableError

R = TypeVar("R")
T = TypeVar("T")

log = logging.getLogger("rivermind.server")

Listener = Callable[["TableRunner", Sequence[Event]], Awaitable[None]]
Sleep = Callable[[float], Awaitable[object]]

BOT_LABELS = {
    "random": "Random bot",
    "calling_station": "Calling bot",
    "heuristic": "RiverMind Easy",
    "hard": "RiverMind Hard",
}
FALLBACK_BOT = "heuristic"
"""The bot that stands in for one this server does not run.

The Node server plays a trained champion as RiverMind Hard (P5.7a); this
server, the rollback until P4B.8, does not. A saved table with such a bot plays
on here against RiverMind Easy, labelled as that, so no seat or chip is lost.
"""


def bot_name(kind: str, seat: int) -> str:
    """The name a bot of ``kind`` wears in ``seat`` (D-7)."""
    return f"{BOT_LABELS.get(kind, kind)} {seat + 1}"


@dataclass
class RunnerOptions:
    """Timing and bot behaviour shared by the tables a manager runs."""

    hand_pause: float = 3.0
    """Seconds between the end of one hand and the start of the next."""
    bot_delay: float = 0.6
    """Seconds a bot waits before acting, so people can follow the play."""
    bot_rebuy: bool = True
    """Bots that lose every chip buy in again for the maximum."""
    require_person: bool = False
    """Deal only when a person would be dealt in, so bots never play on alone."""
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
        fill: str | None = None,
        private: bool = False,
        invite: str | None = None,
        practice: str | None = None,
    ) -> None:
        self.table_id = table_id
        self.table = table
        self.name = name or table_id
        self.pending_bot: str | None = None
        """At a practice table: the kind that takes the bot's seat when its hand ends (P5.7a)."""
        if fill is not None and fill not in bots:
            raise ValueError(f"no bot called {fill!r}")
        self.fill = fill
        """The kind of bot that takes free seats, or ``None`` to leave them for people."""
        self.private = private
        """Private tables are not listed; people join them with ``invite``."""
        self.invite = invite
        self.practice = practice
        """The guest a practice table belongs to (P6.0b), or ``None`` for a wallet-backed table."""
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
        self.last_active = self.options.clock.now()

    # Lifecycle

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._run(), name=f"table-{self.table_id}")

    async def stop(self) -> None:
        """Stop the task. A change being saved or published finishes first."""
        self._closed = True
        self._wake.set()
        task, self._task = self._task, None
        async with self.lock:
            if task is not None:
                task.cancel()
        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                pass

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def lobby_state(self) -> dict[str, object]:
        """The lobby settings, saved with the table's snapshot (P4.3)."""
        state: dict[str, object] = {"fill": self.fill, "private": self.private, "invite": self.invite}
        if self.practice is not None:
            state["practice"] = self.practice
        return state

    def is_member(self, player_id: str) -> bool:
        """Whether the player is seated, holds a seat or is waiting here."""
        table = self.table
        return (
            table.seat_of(player_id) is not None
            or table.reservation_of(player_id) is not None
            or table.waitlist_position(player_id) is not None
        )

    def adopt_bots(self) -> None:
        """Number new bots after those already seated, so bot ids stay unique."""
        for _, player in self.table.players():
            if player.is_bot:
                with contextlib.suppress(ValueError):
                    self._bot_count = max(self._bot_count, int(player.player_id.rsplit(":", 1)[1]))

    # Requests from players. Each raises TableError and leaves the table unchanged on refusal.

    async def sit(self, seat: int, player_id: str, name: str, buy_in: int) -> None:
        def apply() -> None:
            self._refuse_if_closed()
            self.table.sit(seat, player_id, name, buy_in)

        await self._change(apply)

    async def seat_bot(self, seat: int, kind: str, buy_in: int | None = None) -> str:
        """Seat a bot of ``kind``, labelled as a bot (D-7). Returns its player id."""
        if kind not in self.bots:
            raise TableError(ErrorCode.BAD_REQUEST, f"no bot called {kind!r}")
        return await self._change(lambda: self._sit_bot(seat, kind, buy_in))

    def _sit_bot(self, seat: int, kind: str, buy_in: int | None = None) -> str:
        self._bot_count += 1
        player_id = f"bot:{kind}:{self._bot_count}"
        self.table.sit(seat, player_id, bot_name(kind, seat), buy_in or self.table.config.max_buy_in, bot=kind)
        return player_id

    def _bot_seat(self) -> int | None:
        """The seat of this table's first bot."""
        return next((seat for seat, player in self.table.players() if player.bot is not None), None)

    async def switch_bot(self, kind: str) -> str | None:
        """At a practice table: play against a bot of ``kind`` instead (P5.7a).

        The bot changes at once between hands, and otherwise when the hand in
        progress ends. Returns the kind still waiting to sit, or ``None`` once it has.
        """
        if kind not in self.bots:
            raise TableError(ErrorCode.BAD_REQUEST, f"no bot called {kind!r}")

        def apply() -> str | None:
            if self.practice is None:
                raise TableError(ErrorCode.BAD_REQUEST, "only practice tables change their bot")
            self._refuse_if_closed()
            seat = self._bot_seat()
            if seat is None:
                raise TableError(ErrorCode.BAD_REQUEST, "there is no bot to change")
            player = self.table.seats[seat]
            assert player is not None
            self.pending_bot = None if player.bot == kind else kind
            self._settle_bot()
            return self.pending_bot

        return await self._change(apply)

    def _settle_bot(self) -> None:
        """Seat the bot a practice table is waiting for, once the bot it replaces is out of the hand."""
        kind = self.pending_bot
        if kind is None:
            return
        seat = self._bot_seat()
        old = None if seat is None else self.table.seats[seat]
        if seat is None or old is None:
            self.pending_bot = None
            return
        if self.table.in_hand(seat):
            return
        self.pending_bot = None
        self.table.leave(old.player_id)
        self._sit_bot(seat, kind)
        self.name = f"Practice vs {BOT_LABELS.get(kind, kind)}"

    async def reserve(self, player_id: str, name: str, seat: int | None = None) -> tuple[int, bool]:
        """Hold a seat (rule 2.4). Returns the seat and whether it is free to sit in now."""

        def ready(held: int) -> tuple[int, bool]:
            hold = self.table.reservations.get(held)
            return held, hold is not None and hold.ready

        return await self._change_then(lambda: self.table.reserve(player_id, name, seat), ready)

    async def cancel_reservation(self, player_id: str) -> None:
        await self._change(lambda: self.table.cancel_reservation(player_id))

    async def join_waitlist(self, player_id: str, name: str) -> int:
        return await self._change_then(
            lambda: self.table.join_waitlist(player_id, name),
            lambda place: self.table.waitlist_position(player_id) or place,
        )

    async def leave_waitlist(self, player_id: str) -> None:
        await self._change(lambda: self.table.leave_waitlist(player_id))

    async def leave(self, player_id: str) -> Departure | None:
        return await self._change(lambda: self.table.leave(player_id))

    async def sit_out(self, player_id: str) -> None:
        await self._change(lambda: self.table.sit_out(player_id))

    async def sit_in(self, player_id: str) -> None:
        await self._change(lambda: self.table.sit_in(player_id))

    async def set_connected(self, player_id: str, connected: bool) -> None:
        await self._change(lambda: self.table.set_connected(player_id, connected))

    async def rebuy(self, player_id: str, amount: int) -> None:
        def apply() -> None:
            self._refuse_if_closed()
            self.table.rebuy(player_id, amount)

        await self._change(apply)

    async def refill(self, player_id: str) -> None:
        """At a practice table: a fresh practice stack for a player who ran out of chips."""

        def apply() -> None:
            seat = self.table.seat_of(player_id)
            if self.practice is None:
                raise TableError(ErrorCode.BAD_REQUEST, "only practice tables refill for free")
            if seat is None:
                raise TableError(ErrorCode.NOT_SEATED, f"{player_id} is not seated here")
            if self.table.in_hand(seat) or self.table.stack_of(seat) > 0:
                raise TableError(ErrorCode.BAD_REQUEST, "practice chips refill once you run out")
            self.table.rebuy(player_id, self.table.config.max_buy_in)

        await self._change(apply)

    async def act(self, player_id: str, action: Action, seq: int | None = None) -> None:
        def apply() -> None:
            seat = self.table.seat_of(player_id)
            if seat is not None and self._is_bot(seat):
                raise TableError(ErrorCode.NOT_YOUR_TURN, "bots act for themselves")
            self.table.act(player_id, action, seq)

        await self._change(apply)

    def _refuse_if_closed(self) -> None:
        """Refuse chips paid for after the table closed. Its seated chips went
        back to the wallets when it closed, and nothing saves or pays out a
        closed table, so chips that reached it would be lost; refused, the
        caller refunds them. Call under the lock."""
        if self._closed:
            raise TableError(ErrorCode.UNKNOWN_TABLE, "the table has closed")

    async def _change(self, apply: Callable[[], T]) -> T:
        return await self._change_then(apply, lambda result: result)

    async def _change_then(self, apply: Callable[[], R], after: Callable[[R], T]) -> T:
        """Apply a request under the lock, then save and publish it; ``after``
        reads the answer from the table once it is published.

        The change runs as its own task, shielded from its caller: a socket
        that closes mid-request cancels the caller, but a change once started is
        applied, saved, accounted for and published as one unit. Otherwise a
        save could be dropped after the table changed (the store falls behind),
        or its bookkeeping skipped after it committed (departing chips paid
        again by the next save).
        """

        async def run() -> T:
            async with self.lock:
                result = apply()
                await self._changed()
                return after(result)

        task = asyncio.ensure_future(run())
        # A caller that went away never reads a refusal; retrieve it so it is not logged.
        task.add_done_callback(lambda t: t.cancelled() or t.exception())
        return await asyncio.shield(task)

    # The task

    def _is_bot(self, seat: int) -> bool:
        player = self.table.seats[seat]
        return player is not None and player.is_bot

    async def _changed(self) -> None:
        """Publish the table's new events. Call with the lock held."""
        self._settle_bot()
        self.table.settle_seats()
        if self.fill is not None and self.table.people():
            for seat in self.table.free_seats():
                self._sit_bot(seat, self.fill)
        if self.options.bot_rebuy:
            for seat, player in list(self.table.players()):
                if player.is_bot and player.stack == 0 and not self.table.in_hand(seat):
                    self.table.rebuy(player.player_id, self.table.config.max_buy_in)
        events = self.table.drain_events()
        self._wake.set()
        if not events or self._closed:
            return
        self.last_active = self.options.clock.now()
        for hook in self.before_publish:
            await hook(self, events)
        # Whatever the hooks did not take is not kept: tables play on for days.
        self.table.drain_finished()
        self.table.drain_departures()
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

    def may_deal(self) -> bool:
        table = self.table
        if not table.can_start():
            return False
        if not self.options.require_person:
            return True
        return any(not self._is_bot(seat) for seat in table.dealt_in_next())

    def has_people(self) -> bool:
        """Whether any person is seated or has a seat held for them."""
        return self.table.people() > 0 or bool(self.table.reservations)

    async def _step(self) -> None:
        table = self.table
        if self.may_deal():
            if table.hand is not None and self.options.hand_pause:
                await self.options.sleep(self.options.hand_pause)
            async with self.lock:
                if self.may_deal():
                    table.start_hand(self.rng)
                    await self._changed()
            return
        seat = table.to_act
        if seat is not None and self._is_bot(seat):
            await self._bot_turn(seat)
            return
        turn = table.turn if seat is not None else None
        deadlines = [t for t in (turn.final if turn is not None else None, table.reservation_deadline()) if t is not None]
        if await self.options.clock.wait(self._wake, min(deadlines, default=None)):
            return  # something changed; look again
        async with self.lock:
            if table.turn is turn:
                table.check_clock()
            await self._changed()  # also lets a hold that ran out go

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
    """Creates, finds and closes the server's tables.

    ``setup`` is called with each new or restored runner before its task
    starts, to attach hooks and listeners that must see every change.
    """

    def __init__(
        self,
        bots: Mapping[str, Policy],
        options: RunnerOptions | None = None,
        setup: Callable[[TableRunner], None] | None = None,
    ) -> None:
        self.bots = dict(bots)
        self.options = options or RunnerOptions()
        self.setup = setup
        self.tables: dict[str, TableRunner] = {}

    def create(
        self,
        config: TableConfig,
        *,
        name: str = "",
        table_id: str | None = None,
        lobby: Mapping[str, object] | None = None,
    ) -> TableRunner:
        """Make a table and start its task. Call from inside the event loop."""
        table = Table(config, self.options.clock.now)
        return self.restore(table_id or secrets.token_urlsafe(9), table, name=name, lobby=lobby)

    def restore(
        self, table_id: str, table: Table, *, name: str = "", lobby: Mapping[str, object] | None = None
    ) -> TableRunner:
        """Run an existing table, such as one loaded from the database (P3.5).

        ``lobby`` holds the settings of ``TableRunner.lobby_state``.
        """
        if table_id in self.tables:
            raise ValueError(f"table {table_id} exists")
        lobby = lobby or {}
        fill, invite, practice = lobby.get("fill"), lobby.get("invite"), lobby.get("practice")
        # A bot this server does not run gives its seat, stack and place in the hand
        # to the fallback bot, which is then what the seat's label says (D-7).
        fallback = FALLBACK_BOT if FALLBACK_BOT in self.bots else None
        missing: set[str] = set()
        for seat, player in table.players():
            if player.bot is None or player.bot in self.bots:
                continue
            missing.add(player.bot)
            if fallback is not None:
                player.bot = fallback
                player.name = bot_name(fallback, seat)
        if isinstance(fill, str) and fill not in self.bots:
            missing.add(fill)
            fill = fallback
        if missing:
            if fallback is None:
                raise ValueError(f"table {table_id} has bots this server does not run: {sorted(missing)}")
            log.warning(
                "Table %s has bots this server does not run (%s); %s plays instead",
                table_id,
                ", ".join(sorted(missing)),
                BOT_LABELS[fallback],
            )
            if name.startswith("Practice vs "):
                name = f"Practice vs {BOT_LABELS[fallback]}"
        runner = TableRunner(
            table_id,
            table,
            self.bots,
            self.options,
            name=name,
            fill=fill if isinstance(fill, str) else None,
            private=lobby.get("private") is True,
            invite=invite if isinstance(invite, str) else None,
            practice=practice if isinstance(practice, str) else None,
        )
        runner.adopt_bots()
        self.tables[table_id] = runner
        if self.setup is not None:
            self.setup(runner)
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
