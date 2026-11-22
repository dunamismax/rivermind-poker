"""The action abstractions: ``hu-m1`` (P5.1) and ``6max-s1`` (P5.6, ``docs/bots.md``).

At each decision the bot chooses among fold (only when facing a bet), check
or call, a few bet or raise sizes and all-in. The sizes depend on the street
and on the street's **level**: how many bets and raises it has seen, where
the blinds do not count. An ``Abstraction`` holds one format's size table,
its seats and its depth classes.

Pre-flop sizes are "raise to" totals as multiples of the current bet.
Post-flop sizes are fractions *f* of the called pot: a bet or raise of *f* is
to ``current bet + f × (pot + amount owed)``. The functions here take plain
numbers, so the tree compiler (a ``HandState``) and a live bot (a
``SeatView``) share them.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction

from rivermind.engine import Action, ActionKind, ActionRecord, LegalActions, Street

NAME = "hu-m1"
"""The abstraction's name in info-set keys and manifests."""

F = Fraction

PREFLOP_MULTIPLES: tuple[tuple[Fraction, ...], ...] = ((F(5, 2), F(4)), (F(3), F(9, 2)), (F(9, 4),))
"""Pre-flop raise-to multiples of the current bet, by level; level 3 and up is all-in only."""

POSTFLOP_FRACTIONS: dict[Street, tuple[tuple[Fraction, ...], ...]] = {
    Street.FLOP: ((F(1, 3), F(3, 4), F(5, 4)), (F(3, 4),), (F(3, 4),)),
    Street.TURN: ((F(1, 2), F(1), F(3, 2)), (F(1),)),
    Street.RIVER: ((F(1, 2), F(1), F(3, 2)), (F(1),)),
}
"""Post-flop fractions of the called pot, by street and level; later levels are all-in only."""

ALL_IN_BEHIND = F(1, 5)
"""A size leaving less than this share of the called pot behind becomes all-in."""

STREET_LETTERS = "PFTR"


@dataclass(frozen=True, eq=False)
class Abstraction:
    """One format's betting abstraction: who plays, the size table and how its tree is compiled."""

    name: str
    seats: int
    preflop: tuple[tuple[Fraction, ...], ...]
    """Pre-flop raise-to multiples of the current bet, by level."""
    postflop: dict[Street, tuple[tuple[Fraction, ...], ...]]
    """Post-flop fractions of the called pot, by street and level."""
    depths: tuple[int, ...]
    """The depth classes in big blinds."""
    merged: bool = False
    """Whether betting states with the same chips, players and rights are one node, however they were reached."""

    def sizes(self, street: Street, level: int) -> tuple[Fraction, ...]:
        """The size table row for a street and level (empty when only all-in remains)."""
        rows = self.preflop if street is Street.PREFLOP else self.postflop[street]
        return rows[level] if level < len(rows) else ()


HU_M1 = Abstraction(NAME, 2, PREFLOP_MULTIPLES, POSTFLOP_FRACTIONS, (50, 100))
"""Heads-up, medium action abstraction, version 1: every history its own node."""

SIX_MAX_S1 = Abstraction(
    "6max-s1",
    6,
    ((F(5, 2),), (F(3),), (F(9, 4),)),
    {
        Street.FLOP: ((F(3, 4),), (F(1),)),
        Street.TURN: ((F(3, 4),), (F(1),)),
        Street.RIVER: ((F(3, 4),), (F(1),)),
    },
    (50, 100),
    merged=True,
)
"""Six seats, small action abstraction, version 1: one size a level, and betting states merged (P5.6)."""

ABSTRACTIONS: dict[str, Abstraction] = {a.name: a for a in (HU_M1, SIX_MAX_S1)}


def abstraction_named(name: str) -> Abstraction:
    try:
        return ABSTRACTIONS[name]
    except KeyError:
        raise ValueError(f"unknown abstraction {name!r}; use one of {', '.join(ABSTRACTIONS)}") from None


@dataclass(frozen=True, slots=True)
class AbstractAction:
    """One choice at an abstract node: its history token and the engine action it plays."""

    token: str
    """``f`` fold, ``k`` check, ``c`` call, ``b<i>`` or ``r<i>`` a size (its index in the size table row), ``a`` all-in."""
    action: Action


def sizes(street: Street, level: int) -> tuple[Fraction, ...]:
    """The ``hu-m1`` size table row for a street and level (empty when only all-in remains)."""
    return HU_M1.sizes(street, level)


def street_level(actions: Sequence[ActionRecord], street: Street) -> int:
    """Bets and raises made so far on ``street``; the blinds are posts, not actions."""
    return sum(1 for a in actions if a.street is street and a.kind in (ActionKind.BET, ActionKind.RAISE))


def round_chips(x: Fraction) -> int:
    """Whole chips, halves rounded up."""
    return math.floor(x + F(1, 2))


def size_to(street: Street, size: Fraction, pot: int, current_bet: int, owed: int) -> Fraction:
    """The raise-to total a size asks for, before rounding and legality."""
    if street is Street.PREFLOP:
        return size * current_bet
    return current_bet + size * (pot + owed)


def abstract_actions(
    legal: LegalActions,
    *,
    street: Street,
    level: int,
    pot: int,
    current_bet: int,
    street_bets: Sequence[int],
    abstraction: Abstraction = HU_M1,
) -> tuple[AbstractAction, ...]:
    """The node's actions in their fixed order: fold, check or call, sizes ascending, all-in.

    ``pot`` counts every chip put in so far, the current street's bets
    included, and ``street_bets`` is indexed by seat. A raise is judged
    against one caller, the seat with the most in on the street, so a
    bigger table's empty seats (betting nothing) do not count.
    """
    seat = legal.seat
    found: list[AbstractAction] = []
    if legal.can_fold:
        found.append(AbstractAction("f", Action.fold()))
    if legal.can_check:
        found.append(AbstractAction("k", Action.check()))
    elif legal.can_call:
        found.append(AbstractAction("c", Action.call()))
    kind = legal.raise_kind
    if kind is None:
        return tuple(found)
    letter = "b" if kind is ActionKind.BET else "r"
    owed = current_bet - street_bets[seat]
    other = max(b for s, b in enumerate(street_bets) if s != seat)
    seen: set[int] = set()
    for i, size in enumerate(abstraction.sizes(street, level)):
        to = max(round_chips(size_to(street, size, pot, current_bet, owed)), legal.min_to)
        if to >= legal.max_to or to in seen:
            continue
        # The pot once this raise is called, and what the raiser would have behind.
        called_pot = pot - street_bets[seat] - other + 2 * to
        if F(legal.max_to - to) < ALL_IN_BEHIND * called_pot:
            continue  # all-in, added below, takes its place
        seen.add(to)
        found.append(AbstractAction(f"{letter}{i}", Action(kind, to)))
    found.append(AbstractAction("a", Action(kind, legal.max_to)))
    return tuple(found)

