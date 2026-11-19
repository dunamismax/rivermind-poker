"""Concurrent requests from several people and tabs (P4.4).

Requests run at once through the app's ``Server`` with ``asyncio.gather``.
Wallet payments run in worker threads, so the requests really interleave:
one pays while another sits. Whatever the order, a player holds at most one
seat per table, an action counts once, refused buy-ins come back, and every
ledger still adds up to its balance.
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

import pytest
from fastapi import HTTPException

from rivermind.engine import legal_actions
from rivermind.server import TableError
from rivermind.server import protocol as p
from rivermind.server.app import Connection, RequestError, Server
from rivermind.server.players import PlayerRecord
from rivermind.server.wallet import STARTING_GRANT, InsufficientChips
from test.server.test_wallet import make_server, memory_ledger, settle

REFUSED = (TableError, RequestError, HTTPException, InsufficientChips)


async def person(server: Server, tabs: int = 1) -> tuple[PlayerRecord, list[Connection]]:
    record = await asyncio.to_thread(server.players.create)
    await asyncio.to_thread(server.wallet.visit, record.player_id, 0.0)
    connections = []
    for _ in range(tabs):
        connection = Connection(ws=None, player_id=record.player_id, name=record.handle)  # type: ignore[arg-type]
        server.connections.add(connection)
        connections.append(connection)
    return record, connections


def check_invariants(server: Server, people: list[PlayerRecord]) -> None:
    ledger = memory_ledger(server.wallet)
    for record in people:
        total, balance = ledger(record.player_id)
        assert total == balance >= 0, record.player_id
    for runner in server.tables.tables.values():
        table = runner.table
        ids = [player.player_id for _, player in table.players()]
        assert len(ids) == len(set(ids)), f"someone holds two seats at {runner.table_id}"
        holders = [hold.player_id for hold in table.reservations.values()]
        assert len(holders) == len(set(holders)), "someone holds two held seats"
        waiting = [w.player_id for w in table.waitlist]
        assert len(waiting) == len(set(waiting))
        for player_id in set(ids):
            assert player_id not in holders and player_id not in waiting, "seated and still holding or waiting"
        for seat in table.reservations:
            occupant = table.seats[seat]
            assert occupant is None or occupant.is_bot, "a held seat went to someone else"


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def test_one_player_cannot_take_two_seats_at_once() -> None:
    async def main() -> None:
        server = make_server(1)
        await server.start()
        alice, _ = await person(server)
        bob, tabs = await person(server, tabs=3)
        table_id, _, _ = await server.create_table(alice, p.NewTableRequest(seats=6, bots=None, buy_in=5_000))
        runner = server.tables.tables[table_id]
        for tab in tabs:
            await server.join(tab, table_id)
        results = await asyncio.gather(
            server.handle(tabs[0], p.SitMessage(type="sit", table_id=table_id, seat=2, buy_in=4_000)),
            server.handle(tabs[1], p.SitMessage(type="sit", table_id=table_id, seat=3, buy_in=6_000)),
            server.take_seat(bob, runner, None, 5_000, False),
            server.take_seat(bob, runner, 4, 7_000, False),
            server.quick_seat(bob, p.QuickSeatRequest(seats=6)),
            return_exceptions=True,
        )
        await settle(server)
        refused = [r for r in results if isinstance(r, BaseException)]
        assert all(isinstance(r, REFUSED) for r in refused), refused
        assert runner.table.seat_of(bob.player_id) is not None
        # Only the seat Bob holds was paid for; every other buy-in came back.
        entries = server.wallet.entries(bob.player_id, limit=100)
        paid = -sum(e.amount for e in entries if e.kind == "buy_in")
        refunded = sum(e.amount for e in entries if e.kind == "refund")
        assert paid - refunded in (4_000, 5_000, 6_000, 7_000, 10_000)
        assert server.wallet.balance(bob.player_id) == STARTING_GRANT - (paid - refunded)
        assert runner.table.reservation_of(bob.player_id) is None
        check_invariants(server, [alice, bob])
        await server.stop()

    run(main())


def test_two_players_race_for_the_last_seat() -> None:
    async def main() -> None:
        server = make_server(2)
        await server.start()
        alice, _ = await person(server)
        bob, bob_tabs = await person(server)
        carol, carol_tabs = await person(server)
        table_id, _, _ = await server.create_table(alice, p.NewTableRequest(seats=2, bots=None, buy_in=5_000))
        runner = server.tables.tables[table_id]
        for tab in bob_tabs + carol_tabs:
            await server.join(tab, table_id)
        results = await asyncio.gather(
            server.take_seat(bob, runner, None, 5_000, False),
            server.handle(carol_tabs[0], p.SitMessage(type="sit", table_id=table_id, seat=1, buy_in=5_000)),
            server.take_seat(carol, runner, 1, 4_000, False),
            return_exceptions=True,
        )
        await settle(server)
        assert all(isinstance(r, REFUSED) for r in results if isinstance(r, BaseException)), results
        winner = runner.table.seats[1]
        assert winner is not None and winner.player_id in (bob.player_id, carol.player_id)
        loser = carol if winner.player_id == bob.player_id else bob
        assert server.wallet.balance(loser.player_id) == STARTING_GRANT  # refunded in full
        # The one who missed out can wait in line instead.
        assert await server.join_waitlist(loser, runner) == 1
        check_invariants(server, [alice, bob, carol])
        await server.stop()

    run(main())


async def turn_of(server: Server, table_id: str, player_id: str) -> int:
    """Play the bots on until it is the player's turn; returns the turn's seq."""
    runner = server.tables.tables[table_id]
    for _ in range(500):
        table = runner.table
        if table.turn is not None and table.seat_of(player_id) == table.turn.seat:
            return table.seq
        await settle(server, 2)
    raise AssertionError("the player's turn never came")


def test_two_tabs_acting_on_one_turn_count_once() -> None:
    async def main() -> None:
        server = make_server(3)
        await server.start()
        alice, tabs = await person(server, tabs=2)
        table_id, seat, _ = await server.create_table(
            alice, p.NewTableRequest(seats=3, bots="calling_station", buy_in=10_000)
        )
        runner = server.tables.tables[table_id]
        published: list[Any] = []

        async def record(r: Any, events: Any) -> None:
            published.extend(events)

        runner.listeners.append(record)
        for tab in tabs:
            await server.join(tab, table_id)
        for _ in range(6):
            seq = await turn_of(server, table_id, alice.player_id)
            hand = runner.table.hand
            assert hand is not None
            first = p.ActionKind.CHECK if legal_actions(hand).can_check else p.ActionKind.CALL
            results = await asyncio.gather(
                server.handle(tabs[0], p.ActMessage(type="act", table_id=table_id, seq=seq, action=first)),
                server.handle(tabs[1], p.ActMessage(type="act", table_id=table_id, seq=seq, action=p.ActionKind.FOLD)),
                server.handle(tabs[1], p.ActMessage(type="act", table_id=table_id, seq=seq, action=first)),
                return_exceptions=True,
            )
            await settle(server, 2)
            refused = [r for r in results if isinstance(r, BaseException)]
            assert len(refused) == 2, results
            assert all(isinstance(r, TableError) and r.code.value in ("stale", "not_your_turn") for r in refused), refused
            # Alice acted once on that turn, whichever tab got there first.
            mine = [e for e in published if e.kind == "action" and e.data["seat"] == seat and e.seq > seq]
            assert len(mine) == 1, mine
            published.clear()
        check_invariants(server, [alice])
        await server.stop()

    run(main())


@pytest.mark.parametrize("seed", range(3))
def test_concurrent_random_requests_keep_the_tables_consistent(seed: int) -> None:
    """Every round, every tab of three people sends a random request at once."""

    async def main() -> dict[str, int]:
        rng = random.Random(seed)
        server = make_server(10 + seed)
        await server.start()
        people: list[PlayerRecord] = []
        tabs: list[Connection] = []
        for _ in range(3):
            record, connections = await person(server, tabs=2)
            people.append(record)
            tabs.extend(connections)
        records = {r.player_id: r for r in people}
        host = people[0]
        tables = [
            (await server.create_table(host, p.NewTableRequest(seats=2, bots=None, buy_in=4_000)))[0],
            (await server.create_table(host, p.NewTableRequest(seats=3, bots="calling_station", buy_in=4_000)))[0],
        ]
        counts: dict[str, int] = {}

        async def request(tab: Connection) -> str:
            record = records[tab.player_id]
            live = [t for t in tables if t in server.tables.tables]
            if not live:
                return "none"
            table_id = rng.choice(live)
            runner = server.tables.tables[table_id]
            table = runner.table
            roll = rng.random()
            if roll < 0.15:
                await server.join(tab, table_id)
                await server.handle(tab, p.SitMessage(type="sit", table_id=table_id, seat=rng.randrange(table.config.seat_count), buy_in=4_000))
                return "sit"
            if roll < 0.3:
                await server.take_seat(record, runner, None, rng.choice((None, 4_000)), rng.random() < 0.3)
                return "take_seat"
            if roll < 0.38:
                await server.join_waitlist(record, runner)
                return "waitlist"
            if roll < 0.46:
                if record is host:
                    return "idle"  # the host stays, so the tables stay open
                await server.join(tab, table_id)
                await server.handle(tab, p.LeaveTableMessage(type="leave_table", table_id=table_id))
                return "leave"
            if roll < 0.52:
                await runner.cancel_reservation(record.player_id)
                return "give_up"
            if roll < 0.58:
                await server.join(tab, table_id)
                await server.handle(tab, p.RebuyMessage(type="rebuy", table_id=table_id, amount=rng.choice((100, 2_000))))
                return "rebuy"
            # Act on whatever turn this tab last saw, possibly a stale one.
            await server.join(tab, table_id)
            hand = table.hand
            if hand is None or table.turn is None or table.seat_of(record.player_id) != table.turn.seat:
                return "idle"
            legal = legal_actions(hand)
            options = [o for o in legal.options() if o.kind.value in ("check", "call", "fold")]
            action = rng.choice(options)
            seq = table.seq - rng.choice((0, 0, 1))
            await server.handle(tab, p.ActMessage(type="act", table_id=table_id, seq=seq, action=p.ActionKind(action.kind.value)))
            return "act"

        async def attempt(tab: Connection) -> None:
            try:
                kind = await request(tab)
            except REFUSED as error:
                kind = "refused:" + type(error).__name__
            counts[kind] = counts.get(kind, 0) + 1

        for _ in range(150):
            await asyncio.gather(*(attempt(tab) for tab in tabs))
            await settle(server, 2)
            check_invariants(server, people)
        await server.stop()
        return counts

    counts = run(main())
    for kind in ("sit", "take_seat", "leave", "act"):
        assert counts.get(kind, 0) > 0, (kind, counts)
    assert any(k.startswith("refused") for k in counts), counts


def test_nobody_can_act_for_another_player() -> None:
    async def main() -> None:
        server = make_server(4)
        await server.start()
        alice, alice_tabs = await person(server)
        bob, bob_tabs = await person(server)
        carol, carol_tabs = await person(server)
        table_id, _, _ = await server.create_table(alice, p.NewTableRequest(seats=3, bots="calling_station", buy_in=5_000))
        runner = server.tables.tables[table_id]
        await server.take_seat(bob, runner, None, 5_000, False)  # a bot's seat, held until its hand ends
        for tab in alice_tabs + bob_tabs + carol_tabs:
            await server.join(tab, table_id)
        seq = await turn_of(server, table_id, alice.player_id)
        before = runner.table.seq
        attempts = [
            (bob_tabs[0], "not_your_turn"),  # seated or holding, but it is Alice's turn
            (carol_tabs[0], "not_seated"),  # only watching
        ]
        for tab, code in attempts:
            for action in (p.ActionKind.FOLD, p.ActionKind.CALL, p.ActionKind.CHECK):
                with pytest.raises((TableError, RequestError)) as caught:
                    await server.handle(tab, p.ActMessage(type="act", table_id=table_id, seq=seq, action=action))
                assert caught.value.code.value in (code, "not_seated", "not_your_turn")
        assert runner.table.seq == before  # nothing happened at the table
        # Bots act for themselves only: nobody may act in a bot's seat either.
        bot_seat = next(s for s, pl in runner.table.players() if pl.is_bot)
        with pytest.raises(TableError):
            await runner.act(runner.table.seats[bot_seat].player_id, legal_actions(runner.table.hand).options()[0], seq)  # type: ignore[union-attr,arg-type]
        check_invariants(server, [alice, bob, carol])
        await server.stop()

    run(main())
