"""Suit isomorphism and set indexes for the card tables (P5.2, ``docs/bots.md``).

Cards are the engine's integers, ``rank * 4 + suit``. A suit permutation
``g`` (one of the 24 in ``PERMS``) maps a card of suit ``s`` to suit
``g[s]``. Boards are sets: two boards are the same class when a suit
permutation maps one onto the other.

Each board's class is found from its four suit planes (13-bit rank masks,
one per suit): the permutation that makes ``plane'[0] | plane'[1] << 13 |
...`` smallest names the canonical board, and the first such permutation in
``PERMS`` order is the one stored. A hand is looked up by mapping its hole
cards with that same permutation, so any hand reaches the stored row of a
hand that is the same up to suits.

Sets of cards are indexed by their colexicographic rank, ``sum C(c_i, i+1)``
over the sorted cards; a pair ``a < b`` is ``C(b, 2) + a``, from 0 to 1,325.
"""

from __future__ import annotations

import itertools
from functools import lru_cache
from math import comb

import numpy as np

DECK = 52
PAIRS = comb(DECK, 2)
"""1,326 hole-card pairs."""
PERMS: tuple[tuple[int, int, int, int], ...] = tuple(itertools.permutations(range(4)))  # type: ignore[assignment]
BOARD_SIZES = (3, 4, 5)

_BINOM = np.array([[comb(n, k) for k in range(6)] for n in range(DECK + 1)], dtype=np.int64)


def permute_card(card: int, g: int) -> int:
    """The card with its suit mapped by ``PERMS[g]``."""
    return (card & ~3) | PERMS[g][card & 3]


def set_rank(cards: tuple[int, ...] | list[int]) -> int:
    """Colexicographic rank of a set of distinct cards."""
    return sum(comb(c, i + 1) for i, c in enumerate(sorted(cards)))


def pair_index(a: int, b: int) -> int:
    """Index of the hole-card pair ``{a, b}``, from 0 to 1,325."""
    if a == b:
        raise ValueError("a pair needs two different cards")
    if a > b:
        a, b = b, a
    return b * (b - 1) // 2 + a


def ranks_of(sets: np.ndarray) -> np.ndarray:
    """Colexicographic ranks of the rows of ``sets`` (each sorted ascending)."""
    sets = np.asarray(sets, dtype=np.int64)
    ranks = np.zeros(len(sets), dtype=np.int64)
    for i in range(sets.shape[1]):
        ranks += _BINOM[sets[:, i], i + 1]
    return ranks


@lru_cache(maxsize=1)
def pair_cards() -> np.ndarray:
    """The two cards of each pair index, as a (1326, 2) array, lower card first."""
    out = np.zeros((PAIRS, 2), dtype=np.int64)
    for a, b in itertools.combinations(range(DECK), 2):
        out[pair_index(a, b)] = (a, b)
    return out


@lru_cache(maxsize=1)
def pair_masks() -> np.ndarray:
    """Each pair's cards as a 52-bit mask."""
    cards = pair_cards()
    return (np.int64(1) << cards[:, 0]) | (np.int64(1) << cards[:, 1])


@lru_cache(maxsize=1)
def permuted_pairs() -> np.ndarray:
    """``permuted_pairs()[g, p]`` is the index of pair ``p`` with its suits mapped by ``PERMS[g]``."""
    cards = pair_cards()
    out = np.zeros((len(PERMS), PAIRS), dtype=np.int64)
    for g, perm in enumerate(PERMS):
        mapped = (cards & ~3) | np.array(perm, dtype=np.int64)[cards & 3]
        lo, hi = np.minimum(mapped[:, 0], mapped[:, 1]), np.maximum(mapped[:, 0], mapped[:, 1])
        out[g] = hi * (hi - 1) // 2 + lo
    return out


def _all_sets(size: int) -> np.ndarray:
    flat = np.fromiter(itertools.chain.from_iterable(itertools.combinations(range(DECK), size)), dtype=np.int8)
    return flat.reshape(-1, size).astype(np.int64)


def _planes(sets: np.ndarray) -> np.ndarray:
    """(n, 4) array of 13-bit rank masks, one per suit."""
    planes = np.zeros((len(sets), 4), dtype=np.int64)
    rank_bits = np.int64(1) << (sets >> 2)
    suits = sets & 3
    for s in range(4):
        planes[:, s] = np.bitwise_or.reduce(np.where(suits == s, rank_bits, 0), axis=1)
    return planes


def canonical_keys(sets: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """For each row of cards: the smallest key over all suit permutations, and the first permutation giving it."""
    planes = _planes(sets)
    best_key = np.full(len(sets), np.iinfo(np.int64).max, dtype=np.int64)
    best_perm = np.zeros(len(sets), dtype=np.uint8)
    for g, perm in enumerate(PERMS):
        key = np.zeros(len(sets), dtype=np.int64)
        for s in range(4):
            key |= planes[:, s] << (13 * perm[s])
        better = key < best_key  # strictly: the first permutation reaching the minimum is kept
        best_key[better] = key[better]
        best_perm[better] = g
    return best_key, best_perm


def cards_of_key(key: int) -> tuple[int, ...]:
    """The sorted cards of a canonical key."""
    out = []
    for s in range(4):
        plane = (key >> (13 * s)) & 0x1FFF
        out.extend(4 * r + s for r in range(13) if plane >> r & 1)
    return tuple(sorted(out))


class BoardIndex:
    """Every board of one size, mapped to its class and the permutation that canonicalizes it."""

    def __init__(
        self,
        size: int,
        board_class: np.ndarray | None = None,
        board_perm: np.ndarray | None = None,
        class_keys: np.ndarray | None = None,
    ) -> None:
        """Compute the index, or wrap arrays saved from one (``build`` saves them in every table set)."""
        if size not in BOARD_SIZES:
            raise ValueError("boards have 3, 4 or 5 cards")
        self.size = size
        if board_class is not None and board_perm is not None and class_keys is not None:
            self.board_class, self.board_perm, self.class_keys = board_class, board_perm, class_keys
            return
        sets = _all_sets(size)
        keys, perms = canonical_keys(sets)
        class_keys, inverse = np.unique(keys, return_inverse=True)
        del keys
        ranks = ranks_of(sets)
        del sets
        self.board_class = np.empty(len(ranks), dtype=np.int32)
        self.board_perm = np.empty(len(ranks), dtype=np.uint8)
        self.board_class[ranks] = inverse.astype(np.int32)
        self.board_perm[ranks] = perms
        self.class_keys = class_keys
        """Each class's canonical key, ascending: class ids follow this order."""

    @property
    def orbit(self) -> np.ndarray:
        """Boards in each class (24 divided by the size of the board's suit symmetry group)."""
        return np.bincount(np.asarray(self.board_class), minlength=len(self.class_keys)).astype(np.int64)

    def __len__(self) -> int:
        return len(self.class_keys)

    def representative(self, cls: int) -> tuple[int, ...]:
        """The canonical board of a class."""
        return cards_of_key(int(self.class_keys[cls]))

    def lookup(self, board: tuple[int, ...] | list[int]) -> tuple[int, int]:
        """The board's class and the permutation that maps it onto that class's representative."""
        rank = set_rank(board)
        return int(self.board_class[rank]), int(self.board_perm[rank])

    def lookup_many(self, boards: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Classes and permutations for the rows of ``boards`` (each sorted ascending)."""
        ranks = ranks_of(boards)
        return self.board_class[ranks].astype(np.int64), self.board_perm[ranks].astype(np.int64)


@lru_cache(maxsize=3)
def board_index(size: int) -> BoardIndex:
    return BoardIndex(size)


def preflop_class(a: int, b: int) -> int:
    """One of the 169 lossless pre-flop classes (``docs/bots.md``)."""
    r1, r2 = max(a >> 2, b >> 2), min(a >> 2, b >> 2)
    if r1 == r2:
        return 14 * r1
    if a & 3 == b & 3:
        return 13 * r1 + r2
    return 13 * r2 + r1
