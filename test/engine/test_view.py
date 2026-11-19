"""SeatView v2 never exposes another seat's private cards (P2.7)."""

from __future__ import annotations

import dataclasses
import random

import pytest

from rivermind.engine import HandConfig, apply, start_hand
from rivermind.engine.fuzz import random_action, random_stacks
from rivermind.engine.state import legal_actions
from rivermind.engine.view import SeatView, seat_view

from .fixtures import FIXTURES
from .test_history import states_of


def hidden_positions(num_dealt: int, order_index: int) -> list[int]:
    """Deck positions the viewer cannot see: other hole cards, burns and undealt cards."""
    n = num_dealt
    visible = {order_index, n + order_index, 2 * n + 1, 2 * n + 2, 2 * n + 3, 2 * n + 5, 2 * n + 7}
    return [p for p in range(52) if p not in visible]


@pytest.mark.parametrize("seed", range(60))
def test_view_does_not_depend_on_other_seats_cards(seed: int) -> None:
    rng = random.Random(seed)
    num_seats = 2 + seed % 8
    config = HandConfig(50, 100, ante=rng.choice((0, 10)))
    stacks = random_stacks(num_seats, config, rng)
    dealt = [s for s, chips in enumerate(stacks) if chips]
    button = rng.choice(dealt)
    deck = list(range(52))
    rng.shuffle(deck)
    first = start_hand(config, stacks, button, deck=deck)
    viewer = rng.choice(dealt)
    order = first.seat_order
    positions = hidden_positions(len(order), order.index(viewer))
    other_deck = list(deck)
    hidden = [deck[p] for p in positions]
    rng.shuffle(hidden)
    for p, c in zip(positions, hidden):
        other_deck[p] = c
    second = start_hand(config, stacks, button, deck=other_deck)
    assert any(first.hole_cards[s] != second.hole_cards[s] for s in dealt if s != viewer) or len(dealt) == 2
    while True:
        a, b = seat_view(first, viewer), seat_view(second, viewer)
        if first.is_over and first.result is not None and first.result.showdown:
            assert a.revealed == tuple((s, first.hole_cards[s]) for s in first.result.shown)
            assert dataclasses.replace(a, revealed=(), stacks=()) == dataclasses.replace(b, revealed=(), stacks=())
            break
        assert a == b
        if first.is_over:
            break
        action = random_action(first, legal_actions(first), rng)
        first, second = apply(first, action), apply(second, action)


def test_view_has_no_field_for_the_deck_or_other_hands() -> None:
    names = {f.name for f in dataclasses.fields(SeatView)}
    assert "deck" not in names and "hole_cards" in names
    state = start_hand(HandConfig(50, 100), [1_000, 1_000, 1_000], 0, rng=random.Random(2))
    for seat in range(3):
        view = seat_view(state, seat)
        assert view.hole_cards == state.hole_cards[seat]
        others = {c for s in range(3) if s != seat for c in state.hole_cards[s]}  # type: ignore[union-attr]
        assert not others & set(view.hole_cards)  # type: ignore[arg-type]


def test_view_reveals_only_shown_hands() -> None:
    fixture = next(f for f in FIXTURES if f.name == "river bettor shows first and a loser mucks")
    *_, state = states_of(fixture)
    view = seat_view(state, 1)
    assert [seat for seat, _ in view.revealed] == [1, 5]
    assert all(cards != state.hole_cards[3] for _, cards in view.revealed)


def test_view_fields() -> None:
    state = start_hand(HandConfig(50, 100), [1_000, None, 600, 900], 0, rng=random.Random(5))
    view = seat_view(state, state.to_act)  # type: ignore[arg-type]
    assert view.seat == 0 and view.legal is not None and view.to_call == 100
    assert view.stacks == (1_000, None, 550, 800)
    assert view.pot == 150 and view.current_bet == 100
    assert view.seat_order == (2, 3, 0) and view.opponents == (2, 3)
    assert seat_view(state, 2).legal is None
    with pytest.raises(ValueError):
        seat_view(state, 4)
