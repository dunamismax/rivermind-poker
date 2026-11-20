"""The ``hu-m1`` action abstraction (P5.1, ``docs/bots.md``).

At each decision the bot chooses among fold (only when facing a bet), check
or call, a few bet or raise sizes and all-in. The sizes depend on the street
and on the street's **level**: how many bets and raises it has seen, where
the blinds do not count.

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


@dataclass(frozen=True, slots=True)
class AbstractAction:
    """One choice at an abstract node: its history token and the engine action it plays."""

    token: str
    """``f`` fold, ``k`` check, ``c`` call, ``b<i>`` or ``r<i>`` a size (its index in the size table row), ``a`` all-in."""
    action: Action


def sizes(street: Street, level: int) -> tuple[Fraction, ...]:
    """The size table row for a street and level (empty when only all-in remains)."""
    rows = PREFLOP_MULTIPLES if street is Street.PREFLOP else POSTFLOP_FRACTIONS[street]
    return rows[level] if level < len(rows) else ()


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
) -> tuple[AbstractAction, ...]:
    """The node's actions in their fixed order: fold, check or call, sizes ascending, all-in.

    ``pot`` counts every chip put in so far, the current street's bets
    included, and ``street_bets`` is indexed by seat. Heads-up only: the
    opponent is the other seat.
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
    other = street_bets[1 - seat]
    seen: set[int] = set()
    for i, size in enumerate(sizes(street, level)):
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

