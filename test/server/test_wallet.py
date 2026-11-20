"""Play-chip wallets and the ledger (P4.2).

The randomized test plays several people at several bot tables through the
app's ``Server``: they visit (and come back days later for top-ups), start
tables, take seats from the lobby (quick seat, held seats, the waitlist and
bots giving up their seats, P4.3), sit down, rebuy beyond their means, sit
out, act and leave. After
every step each wallet's ledger adds up to its balance and nothing is
negative. At the end, once everyone has left and every table has closed,
every chip is accounted for: the wallets hold exactly what grants and
top-ups paid in, plus what the people won from the bots.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import pytest
from fastapi import HTTPException

from rivermind.engine import legal_actions
from rivermind.server import RunnerOptions, TableError, TableRunner, default_bots
from rivermind.server import protocol as p
from rivermind.server.app import Connection, RequestError, Server
from rivermind.server.clock import ManualClock
from rivermind.server.players import PlayerRecord
from rivermind.server.table import Event
from rivermind.server.wallet import (
    STARTING_GRANT,
    TOP_UP_FLOOR,
    TOP_UP_SECONDS,
    InsufficientChips,
    MemoryWallet,
    Wallet,
)

DAY = TOP_UP_SECONDS
SECRET = b"wallet-secret-wallet-secret-wall"


async def instant(_: float) -> None:
    await asyncio.sleep(0)


def make_server(seed: int, store: Any = None) -> Server:
    seeds = iter(range(seed * 10_000, seed * 10_000 + 10_000))
    options = RunnerOptions(
        hand_pause=0.0,
        bot_delay=0.0,
        sleep=instant,
        require_person=True,
        clock=ManualClock(),
        rng_factory=lambda: random.Random(next(seeds)),
    )
    return Server(SECRET, default_bots(), options, max_tables=50, idle_seconds=10**9, store=store)


@dataclass
class BotChips:
    """Chips bots brought to the tables, and what they still held when each table closed."""

    injected: int = 0
    held: dict[str, int] = field(default_factory=dict)
    left: int = 0
    """Chips bots took away when they gave up a seat to a person (P4.3)."""
    bot_seats: dict[str, set[int]] = field(default_factory=dict)

    async def __call__(self, runner: TableRunner, events: Sequence[Event]) -> None:
        seats = self.bot_seats.setdefault(runner.table_id, set())
        for event in events:
            seat = event.data.get("seat")
            if event.kind == "seated":
                if event.data["bot"] is not None:
                    seats.add(seat)
                    self.injected += event.data["stack"]
                else:
                    seats.discard(seat)
            elif event.kind == "rebought" and seat in seats:
                self.injected += event.data["amount"]
            elif event.kind == "left":
                if seat in seats:
                    self.left += event.data["stack"]
                seats.discard(seat)
        table = runner.table
        if not table.hand_in_progress:
            self.held[runner.table_id] = sum(table.stack_of(s) for s, pl in table.players() if pl.is_bot)


def table_chips(runner: TableRunner) -> int:
    table = runner.table
    pot = table.hand.pot if table.hand_in_progress and table.hand is not None else 0
    return pot + sum(table.stack_of(seat) + pl.pending_rebuy for seat, pl in table.players())


async def settle(server: Server, rounds: int = 20) -> None:
    for _ in range(rounds):
        await asyncio.sleep(0.001)
        for connection in server.connections:  # nobody reads these sockets
            while not connection.queue.empty():
                connection.queue.get_nowait()


async def act_for_people(server: Server, people: dict[str, Connection], rng: random.Random) -> None:
    for runner in list(server.tables.tables.values()):
        table = runner.table
        if not table.hand_in_progress or table.turn is None or table.hand is None:
            continue
        player = table.seats[table.turn.seat]
        if player is None or player.player_id not in people:
            continue
        legal = legal_actions(table.hand)
        if legal is None:
            continue
        options = legal.options()
        # Mostly cautious, so people last; sometimes everything goes in.
        cheap = [a for a in options if a.kind.value in ("check", "call", "fold")]
        action = rng.choice(options if rng.random() < 0.25 or not cheap else cheap)
        try:
            await runner.act(player.player_id, action, table.seq)
        except TableError:
            pass


async def random_play(
    server: Server,
    seed: int,
    steps: int,
    ledger_and_balance: Callable[[str], tuple[int, int]],
    on_step: Callable[[], None] = lambda: None,
) -> dict[str, Any]:
    """Play at random, checking the ledgers after every step. Returns what happened."""
    rng = random.Random(seed)
    bots = BotChips()
    original_setup = server._setup

    def setup(runner: TableRunner) -> None:
        original_setup(runner)
        runner.listeners.insert(0, bots)

    server._setup = setup  # type: ignore[method-assign]
    await server.start()
    now = 1_000_000.0
    people: dict[str, Connection] = {}
    records: dict[str, PlayerRecord] = {}
    for _ in range(4):
        record = await asyncio.to_thread(server.players.create)
        records[record.player_id] = record
        connection = Connection(ws=None, player_id=record.player_id, name=record.handle)  # type: ignore[arg-type]
        people[record.player_id] = connection
        server.connections.add(connection)
        await asyncio.to_thread(server.wallet.visit, record.player_id, now)
    counts: dict[str, int] = {}

    def wallet_check() -> None:
        # Tables pay cash-outs from worker threads, so read both sides in one snapshot.
        for player_id in people:
            total, balance = ledger_and_balance(player_id)
            assert total == balance >= 0, player_id

    for step in range(steps):
        player_id = rng.choice(list(people))
        connection = people[player_id]
        tables = list(server.tables.tables)
        mine = [t for t in connection.tables if t in server.tables.tables]  # a closing table may linger
        roll = rng.random()
        kind = ""
        try:
            if roll < 0.08:
                kind = "visit"
                now += rng.choice((0, DAY / 2, DAY, 3 * DAY))
                await asyncio.to_thread(server.wallet.visit, player_id, now)
            elif roll < 0.14:
                kind = "new_table"
                request = p.NewTableRequest(
                    seats=rng.choice((2, 3, 6)),
                    bots=rng.choice(("random", "calling_station", "heuristic")),
                    big_blind=rng.choice((50, 100, 200)),
                    buy_in=rng.choice((None, None, 2_000, 4_000, 20_000)),
                )
                table_id, _, _ = await server.create_table(records[player_id], request)
                await server.join(connection, table_id)
            elif roll < 0.22 and tables:
                kind = "sit"
                table_id = rng.choice(tables)
                await server.join(connection, table_id)
                runner = server.tables.get(table_id)
                if runner is None:  # it closed while we joined
                    raise RequestError(p.ErrorCode.UNKNOWN_TABLE, "the table closed")
                free = [i for i, s in enumerate(runner.table.seats) if s is None] or [0]
                config = runner.table.config
                amount = rng.choice((config.min_buy_in, config.max_buy_in, config.max_buy_in * 3))
                await server.handle(connection, p.SitMessage(type="sit", table_id=table_id, seat=rng.choice(free), buy_in=amount))
            elif roll < 0.28 and tables:
                table_id = rng.choice(tables)
                runner = server.tables.get(table_id)
                if runner is None:
                    raise RequestError(p.ErrorCode.UNKNOWN_TABLE, "the table closed")
                config = runner.table.config
                record = records[player_id]
                pick = rng.random()
                if pick < 0.4:
                    kind = "take_seat"
                    amount = rng.choice((None, config.min_buy_in, config.max_buy_in * 3))
                    await server.take_seat(record, runner, None, amount, False)
                elif pick < 0.6:
                    kind = "quick_seat"
                    quick = p.QuickSeatRequest(seats=rng.choice((None, 2, 6)), big_blind=rng.choice((None, 100)))
                    table_id = (await server.quick_seat(record, quick)).table_id
                elif pick < 0.8:
                    kind = "hold"
                    await server.take_seat(record, runner, rng.randrange(config.seat_count), None, True)
                else:
                    kind = "waitlist"
                    await server.join_waitlist(record, runner)
                await server.join(connection, table_id)
            elif roll < 0.38 and mine:
                kind = "rebuy"
                table_id = rng.choice(mine)
                config = server.tables.tables[table_id].table.config
                amount = rng.choice((config.big_blind, config.min_buy_in, config.max_buy_in, 5 * config.max_buy_in))
                await server.handle(connection, p.RebuyMessage(type="rebuy", table_id=table_id, amount=amount))
            elif roll < 0.44 and mine:
                kind = "leave"
                table_id = rng.choice(mine)
                await server.handle(connection, p.LeaveTableMessage(type="leave_table", table_id=table_id))
            elif roll < 0.48 and mine:
                kind = "sit_out"
                table_id = rng.choice(mine)
                if rng.random() < 0.5:
                    await server.handle(connection, p.SitOutMessage(type="sit_out", table_id=table_id))
                else:
                    await server.handle(connection, p.SitInMessage(type="sit_in", table_id=table_id))
            else:
                kind = "act"
                await act_for_people(server, people, rng)
        except (TableError, RequestError, HTTPException, InsufficientChips) as error:
            kind += ":" + type(error).__name__
        counts[kind] = counts.get(kind, 0) + 1
        await settle(server, 3)
        wallet_check()
        on_step()

    # Everyone leaves every seat, followed or not (a player follows at most
    # eight tables, but creating a table seats them without following it).
    for runner in list(server.tables.tables.values()):
        for player_id in people:
            await runner.cancel_reservation(player_id)
            await runner.leave_waitlist(player_id)
        for _, seated in list(runner.table.players()):
            if seated.player_id in people:
                try:
                    await runner.leave(seated.player_id)
                except TableError:
                    pass
    for connection in people.values():
        for table_id in list(connection.tables):
            await server.unfollow(connection, table_id)
    for _ in range(2_000):
        await act_for_people(server, people, rng)
        await settle(server, 2)
        if not server.tables.tables and not server._closing:
            break
    left = {
        t: ([(pl.player_id, pl.leaving, pl.sitting_out) for _, pl in r.table.players()], r.table.hand_in_progress, r.table.turn)
        for t, r in server.tables.tables.items()
    }
    assert not server.tables.tables, f"every table closes once its people have left: {left}"
    await settle(server, 5)
    wallet_check()
    balances = {pid: server.wallet.balance(pid) for pid in people}
    entries = [e for pid in people for e in server.wallet.entries(pid, limit=10**9)]
    kinds = [e.kind for e in entries]
    # What grants and top-ups paid in, from the ledger: the balance before and
    # after a visit would also count a cash-out that a table paid meanwhile.
    paid_in = sum(e.amount for e in entries if e.kind in ("grant", "top_up"))
    await server.stop()
    return {
        "counts": counts,
        "balances": balances,
        "paid_in": paid_in,
        "bots_injected": bots.injected,
        "bots_held": sum(bots.held.values()) + bots.left,
        "refunds": kinds.count("refund"),
        "top_ups": kinds.count("top_up"),
    }


def check_outcome(outcome: dict[str, Any]) -> None:
    counts = outcome["counts"]
    # Every chip is accounted for: people hold what grants and top-ups paid,
    # plus what the bots brought to the tables minus what the bots kept.
    assert sum(outcome["balances"].values()) == outcome["paid_in"] + outcome["bots_injected"] - outcome["bots_held"]
    # The random play reached the interesting cases. Some always go through;
    # others only need to have been tried, since timing decides whether they
    # can (a rebuy is refused, and refunded, while the stack is full).
    for kind in ("new_table", "leave", "act", "visit", "quick_seat"):
        assert counts.get(kind, 0) > 0, (kind, sorted(counts.items()))
    for kind in ("rebuy", "take_seat", "hold"):
        tried = sum(n for key, n in counts.items() if key.split(":")[0] == kind)
        assert tried > 0, (kind, sorted(counts.items()))
    # Sitting in a seat a bot or a hold has is refused after being paid for:
    # the payment must come back.
    assert counts.get("sit:TableError", 0) > 0, sorted(counts.items())
    assert any("RequestError" in k for k in counts), counts  # someone could not afford something
    assert outcome["refunds"] > 0 and outcome["top_ups"] > 0


def memory_ledger(wallet: Wallet) -> Callable[[str], tuple[int, int]]:
    assert isinstance(wallet, MemoryWallet)

    def read(player_id: str) -> tuple[int, int]:
        with wallet._lock:
            return sum(e.amount for e in wallet.entries(player_id, limit=10**9)), wallet.balance(player_id)

    return read


@pytest.mark.parametrize("seed", range(3))
def test_ledgers_balance_after_random_play(seed: int) -> None:
    async def main() -> dict[str, Any]:
        server = make_server(seed)
        return await random_play(server, seed, 600, memory_ledger(server.wallet))

    check_outcome(asyncio.run(main()))


def test_grants_and_daily_top_ups() -> None:
    wallet = MemoryWallet()
    assert wallet.balance("p_a") == 0
    assert wallet.visit("p_a", 0) == STARTING_GRANT
    assert wallet.visit("p_a", DAY * 5) == STARTING_GRANT  # above the floor: nothing to top up
    wallet.debit("p_a", STARTING_GRANT - 1_500, "buy_in", "t1")
    assert wallet.visit("p_a", DAY * 5) == TOP_UP_FLOOR  # a day has passed since the grant
    wallet.debit("p_a", TOP_UP_FLOOR, "buy_in", "t1")
    assert wallet.visit("p_a", DAY * 5.5) == 0  # only once a day
    assert wallet.visit("p_a", DAY * 6) == TOP_UP_FLOOR
    with pytest.raises(InsufficientChips):
        wallet.debit("p_a", TOP_UP_FLOOR + 1, "rebuy", "t1")
    assert wallet.balance("p_a") == TOP_UP_FLOOR
    with pytest.raises(ValueError):
        wallet.debit("p_a", 0, "buy_in")
    with pytest.raises(ValueError):
        wallet.credit("p_a", 5, "gift")
    kinds = [e.kind for e in reversed(wallet.entries("p_a"))]
    assert kinds == ["grant", "buy_in", "top_up", "buy_in", "top_up"]
    assert sum(e.amount for e in wallet.entries("p_a")) == wallet.balance("p_a")


def test_an_idle_table_pays_back_the_people_still_seated() -> None:
    async def main() -> None:
        server = make_server(0)
        await server.start()
        record = await asyncio.to_thread(server.players.create)
        server.wallet.visit(record.player_id, 0)
        table_id, _, _ = await server.create_table(record, p.NewTableRequest(seats=2, bots="calling_station", buy_in=4_000))
        assert server.wallet.balance(record.player_id) == STARTING_GRANT - 4_000
        runner = server.tables.tables[table_id]
        await runner.sit_out(record.player_id)
        for _ in range(200):
            await settle(server, 1)
            if not runner.table.hand_in_progress:
                break
        stack = runner.table.stack_of(runner.table.seat_of(record.player_id))  # type: ignore[arg-type]
        server._schedule_close(table_id, "The table closed after being idle.")
        await settle(server, 10)
        assert server.tables.get(table_id) is None
        assert server.wallet.balance(record.player_id) == STARTING_GRANT - 4_000 + stack
        assert server.wallet.entries(record.player_id)[0].kind == "cash_out"
        await server.stop()

    asyncio.run(main())
