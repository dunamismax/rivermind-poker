"""Exact equities and equity histograms for the card tables (P5.2, ``docs/bots.md``).

A hand's **river equity** is its chance of beating one uniformly random
opponent hand on the full board, ties counting half, where the opponent never
holds a card already seen. It is stored exactly as a numerator out of
``EQUITY_SCALE`` (1,980: twice the 990 possible opponent hands).

A turn or flop hand's **equity histogram** counts its river equity over every
way the board can finish (46 river cards from the turn, 1,081 runouts from
the flop), in ``BINS`` equal bins.
"""

from __future__ import annotations

import itertools
from collections.abc import Callable
from math import comb

import numpy as np

from rivermind.engine.evaluator import evaluate

from .iso import DECK, PAIRS, BoardIndex, pair_masks, permuted_pairs

OPPONENTS = comb(DECK - 7, 2)
"""990 opponent hands on a river board."""
EQUITY_SCALE = 2 * OPPONENTS
INVALID = np.uint16(0xFFFF)
"""Stored for a pair that shares a card with the board."""
BINS = 50

RowSource = Callable[[np.ndarray], np.ndarray]
"""Given river board classes, their equity rows (one 1,326-wide row per class)."""


def river_equity(board: tuple[int, ...] | list[int]) -> np.ndarray:
    """Equity numerators of every hole pair on a five-card board, ``INVALID`` where a card collides."""
    if len(board) != 5 or len(set(board)) != 5:
        raise ValueError("a river board has five different cards")
    taken = set(board)
    rest = np.array([c for c in range(DECK) if c not in taken], dtype=np.int64)  # 47 cards
    first, second, holding = _POSITIONS
    b = tuple(board)
    cards = rest.tolist()
    ranks = np.fromiter(
        (evaluate((cards[x], cards[y], *b)) for x, y in zip(_FIRST, _SECOND)), dtype=np.int64, count=len(_FIRST)
    )
    # Lower ranks are better. Against every pair: how many are worse, and how many tie (self included).
    ordered = np.sort(ranks)
    worse_all = len(ranks) - np.searchsorted(ordered, ranks, side="right")
    equal_all = np.searchsorted(ordered, ranks, side="right") - np.searchsorted(ordered, ranks, side="left")
    # The same counts among the 46 pairs holding each card, row by row through an offset per row.
    offset = 8192  # above every evaluator rank (7,462)
    rows = np.sort(ranks[holding], axis=1) + (np.arange(len(rest)) * offset)[:, None]
    flat = rows.ravel()
    width = len(rest) - 1

    def counts(card: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        q = ranks + card * offset
        right = np.searchsorted(flat, q, side="right") - card * width
        left = np.searchsorted(flat, q, side="left") - card * width
        return width - right, right - left

    worse_a, equal_a = counts(first)
    worse_b, equal_b = counts(second)
    wins = worse_all - worse_a - worse_b
    ties = equal_all - equal_a - equal_b + 1
    out = np.full(PAIRS, INVALID, dtype=np.uint16)
    lo, hi = rest[first], rest[second]
    out[hi * (hi - 1) // 2 + lo] = (2 * wins + ties).astype(np.uint16)
    return out


def _positions() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The 1,081 pairs of positions among 47 unseen cards, and the 46 pairs holding each position."""
    pairs = list(itertools.combinations(range(DECK - 5), 2))
    first = np.array([x for x, _ in pairs], dtype=np.int64)
    second = np.array([y for _, y in pairs], dtype=np.int64)
    holding = np.zeros((DECK - 5, DECK - 6), dtype=np.int64)
    fill = [0] * (DECK - 5)
    for i, (x, y) in enumerate(pairs):
        holding[x, fill[x]] = i
        fill[x] += 1
        holding[y, fill[y]] = i
        fill[y] += 1
    return first, second, holding


_POSITIONS = _positions()
_FIRST, _SECOND = _POSITIONS[0].tolist(), _POSITIONS[1].tolist()


def river_equity_brute(hole: tuple[int, int], board: tuple[int, ...]) -> int:
    """The same numerator by enumerating every opponent hand; for tests."""
    seen = set(hole) | set(board)
    mine = evaluate((*hole, *board))
    total = 0
    for x, y in itertools.combinations([c for c in range(DECK) if c not in seen], 2):
        theirs = evaluate((x, y, *board))
        total += 2 if mine < theirs else 1 if mine == theirs else 0
    return total


def equity_bin(numerators: np.ndarray) -> np.ndarray:
    return (numerators.astype(np.int64) * BINS) // (EQUITY_SCALE + 1)


def _board_mask(cards: tuple[int, ...]) -> int:
    mask = 0
    for c in cards:
        mask |= 1 << c
    return mask


def histograms(board: tuple[int, ...], river: BoardIndex, rows: RowSource) -> np.ndarray:
    """Equity histograms of every hole pair on a flop or turn board, as a (1326, BINS) ``uint16`` array.

    Pairs that collide with the board get an all-zero row. ``rows`` supplies
    canonical river equity rows; each finished board is looked up through
    ``river`` and the hole cards are mapped by the same suit permutation.
    """
    if len(board) not in (3, 4):
        raise ValueError("histograms are for flop and turn boards")
    taken = _board_mask(board)
    rest = [c for c in range(DECK) if not taken >> c & 1]
    runouts = list(itertools.combinations(rest, 5 - len(board)))
    finished = np.sort(np.array([(*board, *extra) for extra in runouts], dtype=np.int64), axis=1)
    classes, perms = river.lookup_many(finished)
    unique, back = np.unique(classes, return_inverse=True)
    table = rows(unique)  # (unique classes, 1326)
    gathered = table[back[:, None], permuted_pairs()[perms]]  # (runouts, 1326)
    masks = pair_masks()
    runout_masks = np.array([_board_mask(extra) for extra in runouts], dtype=np.int64)
    valid = ((masks & taken) == 0)[None, :] & ((masks[None, :] & runout_masks[:, None]) == 0)
    bins = equity_bin(np.where(valid, gathered, 0))
    keys = np.where(valid, np.arange(PAIRS)[None, :] * BINS + bins, PAIRS * BINS)
    counts = np.bincount(keys.ravel(), minlength=PAIRS * BINS + 1)[: PAIRS * BINS]
    return counts.reshape(PAIRS, BINS).astype(np.uint16)


def direct_rows(river: BoardIndex) -> RowSource:
    """A row source that computes each class's row from its representative board, memoized."""
    cache: dict[int, np.ndarray] = {}

    def rows(classes: np.ndarray) -> np.ndarray:
        out = np.empty((len(classes), PAIRS), dtype=np.uint16)
        for i, cls in enumerate(classes.tolist()):
            row = cache.get(cls)
            if row is None:
                row = cache[cls] = river_equity(river.representative(cls))
            out[i] = row
        return out

    return rows
