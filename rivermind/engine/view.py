"""``SeatView`` v2: what one seat may know about a hand.

Bots and clients decide from a ``SeatView``, never from a ``HandState``. A
view holds the seat's own hole cards and public information only: the board,
stacks, bets, pot, positions, the action history and, once a hand is over,
the hands shown at showdown. It never holds the deck or another seat's
unrevealed cards; ``test_view.py`` proves that changing every other seat's
cards leaves the view unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass

from .state import (
    ActionRecord,
    HandConfig,
    HandState,
    LegalActions,
    Post,
    Street,
    legal_actions,
)


@dataclass(frozen=True, slots=True)
class SeatView:
    seat: int
    config: HandConfig
    hole_cards: tuple[int, int] | None
    board: tuple[int, ...]
    street: Street
    button: int
    small_blind_seat: int
    big_blind_seat: int
    seat_order: tuple[int, ...]
    """Players dealt in, clockwise from the player left of the button."""
    stacks: tuple[int | None, ...]
    """Chips behind per seat, ``None`` for seats not dealt in."""
    street_bets: tuple[int, ...]
    contributions: tuple[int, ...]
    folded: tuple[bool, ...]
    pot: int
    current_bet: int
    to_act: int | None
    legal: LegalActions | None
    """The seat's legal actions when it is to act, otherwise ``None``."""
    posts: tuple[Post, ...]
    actions: tuple[ActionRecord, ...]
    revealed: tuple[tuple[int, tuple[int, int]], ...]
    """Seats and hole cards shown at showdown, once the hand is over."""
    is_over: bool

    @property
    def num_seats(self) -> int:
        return len(self.stacks)

    @property
    def to_call(self) -> int:
        """Chips this seat would add to call, 0 when it can check."""
        return self.legal.call if self.legal is not None else 0

    @property
    def stack(self) -> int:
        return self.stacks[self.seat] or 0

    @property
    def opponents(self) -> tuple[int, ...]:
        """Other seats still in the hand."""
        return tuple(s for s in self.seat_order if s != self.seat and not self.folded[s])

    @property
    def street_actions(self) -> tuple[ActionRecord, ...]:
        return tuple(a for a in self.actions if a.street == self.street)


def seat_view(state: HandState, seat: int) -> SeatView:
    """The view of ``state`` for ``seat``."""
    if not 0 <= seat < state.num_seats:
        raise ValueError("not a seat at this table")
    result = state.result
    revealed: tuple[tuple[int, tuple[int, int]], ...] = ()
    if result is not None:
        revealed = tuple((s, hole) for s in result.shown if (hole := state.hole_cards[s]) is not None)
    return SeatView(
        seat=seat,
        config=state.config,
        hole_cards=state.hole_cards[seat],
        board=state.board,
        street=state.street,
        button=state.button,
        small_blind_seat=state.small_blind_seat,
        big_blind_seat=state.big_blind_seat,
        seat_order=state.seat_order,
        stacks=state.final_stacks,
        street_bets=state.street_bets,
        contributions=state.contributions,
        folded=state.folded,
        pot=state.pot,
        current_bet=state.current_bet,
        to_act=state.to_act,
        legal=legal_actions(state) if state.to_act == seat else None,
        posts=state.posts,
        actions=state.actions,
        revealed=revealed,
        is_over=state.is_over,
    )
