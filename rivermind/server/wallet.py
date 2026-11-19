"""Play-chip wallets and their ledger (P4.2).

Chips are play money only, forever (D-1): they can never be bought, sold,
cashed out or transferred for value. Each player has a balance that changes
only together with a ledger entry, so the entries always add up to it, and a
balance can never go negative.

- A player's first visit pays a starting grant. Later visits top a balance
  below ``TOP_UP_FLOOR`` back up to it, at most once a day.
- Sitting down and rebuying are paid from the wallet when asked for, before
  the chips reach the table, and refunded if the table refuses them.
- Chips come back when the player leaves (``cash_out``) and when a waiting
  rebuy no longer fits the buy-in range at the end of a hand (``refund``).
  With a database, those are written in the same transaction as the table
  save that removed the chips from the table (``TableStore.save``), so each
  is paid exactly once even if the server dies.

``MemoryWallet`` keeps balances for a server without a database and
``DatabaseWallet`` keeps them in ``players.balance`` and ``ledger_entries``.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import Connection, Engine, insert, select, update

from rivermind.db import LedgerEntry, Player

from .table import Departure

STARTING_GRANT = 20_000
"""Chips a new player starts with: 100 big blinds at 100/200."""
TOP_UP_FLOOR = 10_000
"""A visit tops a balance below this back up to it, once a day."""
TOP_UP_SECONDS = 24 * 3600
CREDIT_KINDS = frozenset({"grant", "top_up", "cash_out", "refund"})
DEBIT_KINDS = frozenset({"buy_in", "rebuy"})
PLAY_MONEY_NOTICE = "Play money only: chips can never be bought, sold or cashed out, and have no value."


class InsufficientChips(Exception):
    def __init__(self, balance: int, amount: int) -> None:
        super().__init__(f"You have {balance:,} chips; that needs {amount:,}.")
        self.balance = balance
        self.amount = amount


class UnknownPlayer(Exception):
    pass


@dataclass(frozen=True, slots=True)
class Entry:
    kind: str
    amount: int
    """Positive for chips paid in, negative for chips paid out."""
    balance_after: int
    table_id: str | None
    at: float
    """Seconds since the epoch."""


@dataclass(frozen=True, slots=True)
class Credit:
    """Chips going back from a table to a person's wallet."""

    player_id: str
    amount: int
    kind: str
    table_id: str


def credits_for(table_id: str, departures: Sequence[Departure]) -> list[Credit]:
    """What a table owes people for its departures. Bots have no wallet."""
    return [
        Credit(d.player_id, d.chips, "cash_out" if d.left else "refund", table_id)
        for d in departures
        if not d.bot and d.chips > 0
    ]


def _check(amount: int, kind: str) -> None:
    if type(amount) is not int or amount <= 0:
        raise ValueError(f"an amount is a positive whole number of chips, not {amount!r}")
    if kind not in CREDIT_KINDS | DEBIT_KINDS:
        raise ValueError(f"unknown ledger entry kind {kind!r}")


class Wallet(Protocol):
    def visit(self, player_id: str, now: float) -> int:
        """Pay the starting grant or a due top-up. Returns the balance."""
        ...

    def balance(self, player_id: str) -> int: ...

    def debit(self, player_id: str, amount: int, kind: str, table_id: str | None = None) -> int:
        """Take chips, or raise ``InsufficientChips``. Returns the balance."""
        ...

    def credit(self, player_id: str, amount: int, kind: str, table_id: str | None = None) -> int: ...

    def entries(self, player_id: str, limit: int = 50) -> list[Entry]:
        """The newest entries first."""
        ...


class MemoryWallet:
    """Wallets for a server without a database: they last as long as the process."""

    def __init__(self) -> None:
        self._balances: dict[str, int] = {}
        self._granted: dict[str, float] = {}
        self._entries: dict[str, list[Entry]] = {}
        self._lock = threading.Lock()

    def _apply(self, player_id: str, amount: int, kind: str, table_id: str | None, now: float) -> int:
        balance = self._balances.get(player_id, 0) + amount
        if balance < 0:
            raise InsufficientChips(balance - amount, -amount)
        self._balances[player_id] = balance
        self._entries.setdefault(player_id, []).append(Entry(kind, amount, balance, table_id, now))
        return balance

    def visit(self, player_id: str, now: float) -> int:
        with self._lock:
            granted = self._granted.get(player_id)
            balance = self._balances.get(player_id, 0)
            if granted is None:
                self._granted[player_id] = now
                return self._apply(player_id, STARTING_GRANT, "grant", None, now)
            if balance < TOP_UP_FLOOR and now - granted >= TOP_UP_SECONDS:
                self._granted[player_id] = now
                return self._apply(player_id, TOP_UP_FLOOR - balance, "top_up", None, now)
            return balance

    def balance(self, player_id: str) -> int:
        return self._balances.get(player_id, 0)

    def debit(self, player_id: str, amount: int, kind: str, table_id: str | None = None) -> int:
        _check(amount, kind)
        with self._lock:
            return self._apply(player_id, -amount, kind, table_id, time.time())

    def credit(self, player_id: str, amount: int, kind: str, table_id: str | None = None) -> int:
        _check(amount, kind)
        with self._lock:
            return self._apply(player_id, amount, kind, table_id, time.time())

    def entries(self, player_id: str, limit: int = 50) -> list[Entry]:
        return list(reversed(self._entries.get(player_id, [])))[:limit]


def apply_entry(conn: Connection, player_id: str, amount: int, kind: str, table_id: str | None) -> int:
    """Change a stored balance and record the entry, inside the caller's transaction.

    The balance changes only if it stays at or above zero, in one statement,
    so concurrent debits can never overdraw it.
    """
    balance = conn.execute(
        update(Player)
        .where(Player.id == player_id, Player.balance + amount >= 0)
        .values(balance=Player.balance + amount)
        .returning(Player.balance)
    ).scalar_one_or_none()
    if balance is None:
        current = conn.execute(select(Player.balance).where(Player.id == player_id)).scalar_one_or_none()
        if current is None:
            raise UnknownPlayer(player_id)
        raise InsufficientChips(current, -amount)
    conn.execute(
        insert(LedgerEntry).values(
            player_id=player_id, kind=kind, amount=amount, balance_after=balance, table_id=table_id
        )
    )
    return int(balance)


class DatabaseWallet:
    """Wallets in ``players.balance`` with every change in ``ledger_entries``."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def visit(self, player_id: str, now: float) -> int:
        moment = datetime.fromtimestamp(now, UTC)
        with self.engine.begin() as conn:
            row = conn.execute(
                select(Player.balance, Player.granted_at).where(Player.id == player_id).with_for_update()
            ).one_or_none()
            if row is None:
                raise UnknownPlayer(player_id)
            balance, granted = int(row.balance), row.granted_at
            if granted is None:
                kind, amount = "grant", STARTING_GRANT
            elif balance < TOP_UP_FLOOR and (moment - granted).total_seconds() >= TOP_UP_SECONDS:
                kind, amount = "top_up", TOP_UP_FLOOR - balance
            else:
                return balance
            conn.execute(update(Player).where(Player.id == player_id).values(granted_at=moment))
            return apply_entry(conn, player_id, amount, kind, None)

    def balance(self, player_id: str) -> int:
        with self.engine.connect() as conn:
            balance = conn.execute(select(Player.balance).where(Player.id == player_id)).scalar_one_or_none()
        if balance is None:
            raise UnknownPlayer(player_id)
        return int(balance)

    def debit(self, player_id: str, amount: int, kind: str, table_id: str | None = None) -> int:
        _check(amount, kind)
        with self.engine.begin() as conn:
            return apply_entry(conn, player_id, -amount, kind, table_id)

    def credit(self, player_id: str, amount: int, kind: str, table_id: str | None = None) -> int:
        _check(amount, kind)
        with self.engine.begin() as conn:
            return apply_entry(conn, player_id, amount, kind, table_id)

    def entries(self, player_id: str, limit: int = 50) -> list[Entry]:
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    LedgerEntry.kind,
                    LedgerEntry.amount,
                    LedgerEntry.balance_after,
                    LedgerEntry.table_id,
                    LedgerEntry.created_at,
                )
                .where(LedgerEntry.player_id == player_id)
                .order_by(LedgerEntry.id.desc())
                .limit(limit)
            ).all()
        return [Entry(r.kind, int(r.amount), int(r.balance_after), r.table_id, r.created_at.timestamp()) for r in rows]


__all__ = [
    "CREDIT_KINDS",
    "DEBIT_KINDS",
    "PLAY_MONEY_NOTICE",
    "STARTING_GRANT",
    "TOP_UP_FLOOR",
    "TOP_UP_SECONDS",
    "Credit",
    "DatabaseWallet",
    "Entry",
    "InsufficientChips",
    "MemoryWallet",
    "UnknownPlayer",
    "Wallet",
    "apply_entry",
    "credits_for",
]
