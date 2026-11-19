"""Uncalled bets, side pots, split pots and odd chips (rules 9 and 11)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Pot:
    """One pot, as built by rule 9.2 and awarded by rule 11."""

    amount: int
    eligible: tuple[int, ...]
    winners: tuple[int, ...] = ()
    shares: tuple[int, ...] = ()
    """Chips each winner receives, in the same order as ``winners``."""


def uncalled_bet(contributions: Sequence[int]) -> tuple[int, int] | None:
    """Rule 9.1: the seat and amount of an uncalled excess, or ``None``.

    The excess is the largest contribution minus the next largest, counting
    every player, folded or not.
    """
    top = -1
    second = -1
    top_seat = -1
    for seat, amount in enumerate(contributions):
        if amount > top:
            second = top
            top = amount
            top_seat = seat
        elif amount > second:
            second = amount
    second = max(second, 0)
    if top > second:
        return top_seat, top - second
    return None


def build_pots(contributions: Sequence[int], live: Sequence[int]) -> list[Pot]:
    """Rule 9.2: split contributions into a main pot and side pots.

    ``contributions`` is indexed by seat and must already have any uncalled
    bet removed. ``live`` lists the seats that have not folded. Each pot lists
    its eligible seats in ascending order.
    """
    levels = sorted({contributions[seat] for seat in live})
    pots: list[Pot] = []
    previous = 0
    for i, level in enumerate(levels):
        last = i == len(levels) - 1
        amount = 0
        for paid in contributions:
            above = paid - previous
            if above > 0:
                amount += above if last else min(above, level - previous)
        eligible = tuple(sorted(seat for seat in live if contributions[seat] >= level))
        if amount:
            pots.append(Pot(amount, eligible))
        previous = level
    return pots


def split(amount: int, winners: Sequence[int], button: int, num_seats: int) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Rule 11.2: share a pot among winners, odd chips clockwise from the button.

    Returns the winners in clockwise order from the seat left of the button and
    each one's share.
    """
    ordered = tuple(sorted(winners, key=lambda seat: (seat - button - 1) % num_seats))
    base, odd = divmod(amount, len(ordered))
    return ordered, tuple(base + (1 if i < odd else 0) for i in range(len(ordered)))
