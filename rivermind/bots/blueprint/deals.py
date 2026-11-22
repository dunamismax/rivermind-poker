"""Deals for training on the 52-card deck, looked up in a card table set in batches."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from rivermind.bots.cards import CardTables
from rivermind.engine.evaluator import evaluate

BOARD_CARDS = (0, 3, 4, 5)


class CardDealer:
    """Deals two hands and a board per iteration and buckets them with a table set.

    Seat 0 (the button) holds the first two cards, seat 1 the next two, and
    the board is the following five. Pickles as its path, so worker
    processes reopen the memory-mapped tables and share their pages.
    """

    def __init__(self, path: str | Path, *, verify: bool = False) -> None:
        self.path = Path(path)
        self.tables = CardTables(self.path, verify=verify)
        self.buckets = tuple(self.tables.bucket_count(s) for s in ("preflop", "flop", "turn", "river"))
        if self.tables.manifest["settings"].get("limit") is not None:
            raise ValueError(f"{self.path} was built with a limit and cannot deal every hand")

    def __reduce__(self) -> tuple[Any, ...]:
        return (CardDealer, (str(self.path),))

    def deal(self, rng: np.random.Generator, n: int) -> tuple[np.ndarray, np.ndarray]:
        cards = rng.random((n, 52)).argsort(axis=1)[:, :9].astype(np.int64)
        board = cards[:, 4:9]
        buckets = np.empty((n, 2, 4), dtype=np.int64)
        for seat in (0, 1):
            hole = cards[:, 2 * seat : 2 * seat + 2]
            for s, size in enumerate(BOARD_CARDS):
                buckets[:, seat, s] = self.tables.buckets_many(hole, board[:, :size] if size else None)
        rows = cards.tolist()
        outcome = np.empty(n, dtype=np.int64)
        for i, row in enumerate(rows):
            b = row[4:9]
            r0 = evaluate((row[0], row[1], *b))
            r1 = evaluate((row[2], row[3], *b))
            outcome[i] = (r0 < r1) - (r0 > r1)  # lower ranks are better
        return buckets, outcome

    def deal_seats(self, rng: np.random.Generator, n: int, seats: int) -> tuple[np.ndarray, np.ndarray]:
        """Deal ``seats`` hands and a board: seat *i* holds cards 2*i* and 2*i* + 1, and the board follows.

        With two seats the cards, and so the buckets, are ``deal``'s.
        """
        used = 2 * seats
        cards = rng.random((n, 52)).argsort(axis=1)[:, : used + 5].astype(np.int64)
        board = cards[:, used : used + 5]
        buckets = np.empty((n, seats, 4), dtype=np.int64)
        for seat in range(seats):
            hole = cards[:, 2 * seat : 2 * seat + 2]
            for s, size in enumerate(BOARD_CARDS):
                buckets[:, seat, s] = self.tables.buckets_many(hole, board[:, :size] if size else None)
        ranks = np.empty((n, seats), dtype=np.int64)
        for i, row in enumerate(cards.tolist()):
            b = row[used : used + 5]
            ranks[i] = [evaluate((row[2 * seat], row[2 * seat + 1], *b)) for seat in range(seats)]
        return buckets, ranks

    def describe(self) -> dict[str, Any]:
        return {
            "kind": "card-tables",
            "path": str(self.path),
            "abstraction": self.tables.manifest["settings"]["abstraction"],
            "seed": self.tables.manifest["settings"]["seed"],
            "sha256": self.tables.sha256,
        }
