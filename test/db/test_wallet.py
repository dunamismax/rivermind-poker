"""Play-chip wallets in PostgreSQL (P4.2)."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from typing import Any

import pytest
from sqlalchemy import Engine, select, text
from sqlalchemy.exc import IntegrityError

from rivermind.db import LedgerEntry, Player
from rivermind.server.players import DatabasePlayers
from rivermind.server.store import TableStore
from rivermind.server.wallet import (
    STARTING_GRANT,
    TOP_UP_FLOOR,
    Credit,
    DatabaseWallet,
    InsufficientChips,
    UnknownPlayer,
)
from test.server.test_wallet import DAY, check_outcome, make_server, random_play


def ledger_of(engine: Engine) -> Callable[[str], tuple[int, int]]:
    """A player's ledger total and balance, read in one statement so they share a snapshot."""

    def read(player_id: str) -> tuple[int, int]:
        with engine.connect() as conn:
            total, balance = conn.execute(
                text(
                    "SELECT (SELECT coalesce(sum(amount), 0) FROM ledger_entries WHERE player_id = :p), balance"
                    " FROM players WHERE id = :p"
                ),
                {"p": player_id},
            ).one()
        return int(total), int(balance)

    return read


def check_every_ledger(engine: Engine) -> None:
    """Each balance is the sum of its entries, and each entry's balance_after follows from the one before."""
    with engine.connect() as conn:
        balances = dict(conn.execute(select(Player.id, Player.balance)).all())
        rows = conn.execute(
            select(LedgerEntry.player_id, LedgerEntry.amount, LedgerEntry.balance_after).order_by(LedgerEntry.id)
        ).all()
    running: dict[str, int] = {}
    for player_id, amount, after in rows:
        running[player_id] = running.get(player_id, 0) + amount
        assert running[player_id] == after >= 0
    assert {pid: running.get(pid, 0) for pid in balances} == balances


def test_ledgers_balance_after_random_play(engine: Engine) -> None:
    async def main() -> dict[str, Any]:
        server = make_server(7, TableStore(engine))
        return await random_play(server, 7, 400, ledger_of(engine), on_step=lambda: None)

    outcome = asyncio.run(main())
    check_outcome(outcome)
    check_every_ledger(engine)
    with engine.connect() as conn:
        kinds = set(conn.execute(select(LedgerEntry.kind).distinct()).scalars())
        open_tables = conn.execute(text("SELECT count(*) FROM poker_tables WHERE status = 'open'")).scalar_one()
    assert {"grant", "top_up", "buy_in", "rebuy", "cash_out", "refund"} <= kinds
    assert open_tables == 0


def test_grants_top_ups_and_debits(engine: Engine) -> None:
    players = DatabasePlayers(engine)
    wallet = DatabaseWallet(engine)
    player = players.create().player_id
    assert wallet.balance(player) == 0
    assert wallet.visit(player, 0) == STARTING_GRANT
    assert wallet.visit(player, 10 * DAY) == STARTING_GRANT
    wallet.debit(player, STARTING_GRANT - 100, "buy_in", "t1")
    assert wallet.visit(player, 10 * DAY) == TOP_UP_FLOOR
    assert wallet.visit(player, 10.5 * DAY) == TOP_UP_FLOOR
    with pytest.raises(InsufficientChips) as short:
        wallet.debit(player, TOP_UP_FLOOR + 1, "rebuy", "t1")
    assert short.value.balance == TOP_UP_FLOOR
    assert wallet.credit(player, 250, "cash_out", "t1") == TOP_UP_FLOOR + 250
    assert [e.kind for e in wallet.entries(player)] == ["cash_out", "top_up", "buy_in", "grant"]
    with pytest.raises(UnknownPlayer):
        wallet.visit("p_nobody", 0)
    with pytest.raises(UnknownPlayer):
        wallet.debit("p_nobody", 5, "buy_in")
    check_every_ledger(engine)


def test_concurrent_debits_never_overdraw(engine: Engine) -> None:
    players = DatabasePlayers(engine)
    wallet = DatabaseWallet(engine)
    player = players.create().player_id
    wallet.visit(player, 0)
    paid: list[int] = []
    refused: list[int] = []
    start = threading.Barrier(16)

    def spend() -> None:
        start.wait()
        try:
            wallet.debit(player, 3_000, "buy_in", "t1")
            paid.append(1)
        except InsufficientChips:
            refused.append(1)

    threads = [threading.Thread(target=spend) for _ in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(paid) == STARTING_GRANT // 3_000 and len(refused) == 16 - len(paid)
    assert wallet.balance(player) == STARTING_GRANT % 3_000
    # Concurrent first visits pay one grant.
    other = players.create().player_id
    visits = [threading.Thread(target=wallet.visit, args=(other, 0)) for _ in range(8)]
    for thread in visits:
        thread.start()
    for thread in visits:
        thread.join()
    assert wallet.balance(other) == STARTING_GRANT
    check_every_ledger(engine)


def test_credits_ride_on_the_table_save_and_skip_unknown_players(engine: Engine, caplog: pytest.LogCaptureFixture) -> None:
    players = DatabasePlayers(engine)
    wallet = DatabaseWallet(engine)
    store = TableStore(engine)
    player = players.create().player_id
    store.close("t-missing", [Credit(player, 700, "cash_out", "t-missing"), Credit("p_gone", 50, "cash_out", "t-missing")])
    assert wallet.balance(player) == 700
    assert "No wallet for p_gone" in caplog.text
    check_every_ledger(engine)


@pytest.mark.parametrize(
    "sql",
    [
        "UPDATE players SET balance = -1",
        "INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('{p}', 'grant', -5, 0)",
        "INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('{p}', 'buy_in', 5, 0)",
        "INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('{p}', 'gift', 5, 5)",
        "INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('{p}', 'refund', 0, 5)",
        "INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('{p}', 'buy_in', -5, -5)",
        "INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('p_nobody', 'grant', 5, 5)",
    ],
)
def test_constraints_reject_bad_ledger_rows(engine: Engine, sql: str) -> None:
    player = DatabasePlayers(engine).create().player_id
    with engine.connect() as conn, pytest.raises(IntegrityError):
        conn.execute(text(sql.format(p=player)))
