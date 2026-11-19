"""Button and blind positions between hands (rules 4 and 5)."""

from __future__ import annotations

import random
from collections.abc import Collection, Sequence


def initial_button(dealt_in: Collection[int], rng: random.Random) -> int:
    """Rule 5.1: the first hand's button is a random player dealt in."""
    seats = sorted(dealt_in)
    if len(seats) < 2:
        raise ValueError("a hand needs at least two players dealt in")
    return rng.choice(seats)


def next_button(previous: int, dealt_in: Collection[int], num_seats: int) -> int:
    """Rule 5.2: the first player dealt in clockwise from the previous button seat.

    The previous button seat itself is skipped whether or not it is still
    occupied, so the button always moves (a moving button).
    """
    if len(dealt_in) < 2:
        raise ValueError("a hand needs at least two players dealt in")
    if not 0 <= previous < num_seats:
        raise ValueError("previous button is not a seat")
    for step in range(1, num_seats + 1):
        seat = (previous + step) % num_seats
        if seat in dealt_in:
            return seat
    raise AssertionError("unreachable")


def deal_order(button: int, dealt_in: Collection[int], num_seats: int) -> tuple[int, ...]:
    """Players dealt in, clockwise from the player left of the button.

    The last entry is the button. Cards are dealt in this order (rule 1.2).
    """
    return tuple(
        seat
        for seat in ((button + step) % num_seats for step in range(1, num_seats + 1))
        if seat in dealt_in
    )


def blind_seats(button: int, dealt_in: Collection[int], num_seats: int) -> tuple[int, int]:
    """The small-blind and big-blind seats for a hand (rules 3.1 and 4.1)."""
    if button not in dealt_in:
        raise ValueError("the button must be a player dealt in")
    order = deal_order(button, dealt_in, num_seats)
    if len(order) < 2:
        raise ValueError("a hand needs at least two players dealt in")
    if len(order) == 2:
        return button, order[0]
    return order[0], order[1]


def seats_dealt_in(stacks: Sequence[int | None]) -> frozenset[int]:
    """Seats with a player holding at least one chip (rule 2.1)."""
    return frozenset(i for i, stack in enumerate(stacks) if stack)
