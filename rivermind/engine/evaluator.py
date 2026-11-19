"""Hand ranking for five to seven cards (rule 10).

Adapted from the Deuces evaluator by Will Drevo (MIT licence, see
``licenses/Deuces.txt``), which is a variant of Cactus Kev's algorithm. Ranks
run from 1 (a royal flush) to 7462 (7-5-4-3-2 offsuit), lower is better, and
match Deuces exactly; a test checks this against the legacy copy in
``poker_ai.poker.evaluation``.

Deuces scores a seven-card hand by trying all 21 five-card subsets. This
module instead keys non-flush hands on the product of their rank primes (a
unique number for each multiset of ranks) and memoizes the best subset, and
it scores flushes on the suited cards alone: with seven cards, a hand holding
a flush cannot also hold four of a kind or a full house.
"""

from __future__ import annotations

from collections.abc import Sequence
from itertools import combinations
from math import prod

PRIMES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41)

MAX_STRAIGHT_FLUSH = 10
MAX_FOUR_OF_A_KIND = 166
MAX_FULL_HOUSE = 322
MAX_FLUSH = 1599
MAX_STRAIGHT = 1609
MAX_THREE_OF_A_KIND = 2467
MAX_TWO_PAIR = 3325
MAX_PAIR = 6185
MAX_HIGH_CARD = 7462

CLASS_NAMES = (
    "Straight Flush",
    "Four of a Kind",
    "Full House",
    "Flush",
    "Straight",
    "Three of a Kind",
    "Two Pair",
    "Pair",
    "High Card",
)
_CLASS_LIMITS = (
    MAX_STRAIGHT_FLUSH,
    MAX_FOUR_OF_A_KIND,
    MAX_FULL_HOUSE,
    MAX_FLUSH,
    MAX_STRAIGHT,
    MAX_THREE_OF_A_KIND,
    MAX_TWO_PAIR,
    MAX_PAIR,
    MAX_HIGH_CARD,
)

_CARD_PRIME = tuple(PRIMES[c >> 2] for c in range(52))


def _build_tables() -> tuple[dict[int, int], dict[int, int]]:
    desc = range(12, -1, -1)
    straights = [tuple(range(top, top - 5, -1)) for top in range(12, 3, -1)]
    straights.append((3, 2, 1, 0, 12))
    straight_sets = {frozenset(s) for s in straights}
    highs = [c for c in combinations(desc, 5) if frozenset(c) not in straight_sets]

    def key(ranks: Sequence[int]) -> int:
        return prod(PRIMES[r] for r in ranks)

    flush: dict[int, int] = {}
    unsuited: dict[int, int] = {}
    value = 1
    for s in straights:
        flush[key(s)] = value
        value += 1
    for quad in desc:
        for kicker in desc:
            if kicker != quad:
                unsuited[key((quad,) * 4 + (kicker,))] = value
                value += 1
    for trips in desc:
        for pair in desc:
            if pair != trips:
                unsuited[key((trips,) * 3 + (pair,) * 2)] = value
                value += 1
    for c in highs:
        flush[key(c)] = value
        value += 1
    for s in straights:
        unsuited[key(s)] = value
        value += 1
    for trips in desc:
        for kickers in combinations([r for r in desc if r != trips], 2):
            unsuited[key((trips,) * 3 + kickers)] = value
            value += 1
    for pairs in combinations(desc, 2):
        for kicker in desc:
            if kicker not in pairs:
                unsuited[key(pairs * 2 + (kicker,))] = value
                value += 1
    for pair in desc:
        for kickers in combinations([r for r in desc if r != pair], 3):
            unsuited[key((pair,) * 2 + kickers)] = value
            value += 1
    for c in highs:
        unsuited[key(c)] = value
        value += 1
    assert value - 1 == MAX_HIGH_CARD
    return flush, unsuited


_FLUSH, _UNSUITED = _build_tables()
_BEST_UNSUITED: dict[int, int] = {}


def _best_unsuited(primes: Sequence[int]) -> int:
    best = MAX_HIGH_CARD
    for combo in combinations(primes, 5):
        value = _UNSUITED[combo[0] * combo[1] * combo[2] * combo[3] * combo[4]]
        if value < best:
            best = value
    return best


def evaluate(cards: Sequence[int]) -> int:
    """Rank the best five-card hand from five to seven cards; lower is better."""
    if not 5 <= len(cards) <= 7:
        raise ValueError("evaluate takes five to seven cards")
    counts = [0, 0, 0, 0]
    key = 1
    for c in cards:
        counts[c & 3] += 1
        key *= _CARD_PRIME[c]
    for s in range(4):
        if counts[s] >= 5:
            suited = [_CARD_PRIME[c] for c in cards if c & 3 == s]
            return min(_FLUSH[prod(combo)] for combo in combinations(suited, 5))
    value = _BEST_UNSUITED.get(key)
    if value is None:
        if len(cards) == 5:
            value = _UNSUITED[key]
        else:
            value = _best_unsuited([_CARD_PRIME[c] for c in cards])
        _BEST_UNSUITED[key] = value
    return value


def rank_class(value: int) -> int:
    """Hand class from 1 (straight flush) to 9 (high card)."""
    for i, limit in enumerate(_CLASS_LIMITS):
        if value <= limit:
            return i + 1
    raise ValueError(f"not a hand rank: {value}")


def describe(value: int) -> str:
    """Name of the hand class, such as ``"Two Pair"``."""
    return CLASS_NAMES[rank_class(value) - 1]
