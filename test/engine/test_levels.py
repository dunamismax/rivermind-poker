"""RiverMind Medium, a champion mixed with RiverMind Easy a hand at a time (P5.7, ``rivermind/bots/levels.py``)."""

from __future__ import annotations

import random

import pytest

from rivermind.bots.levels import MEDIUM_SHARE, MixedPolicy, medium
from rivermind.bots.match import deck_for
from rivermind.bots.policies import CallingStationPolicy, HeuristicPolicy, Policy, RandomPolicy
from rivermind.engine import Action, HandConfig, HandState, apply, start_hand
from rivermind.engine.view import SeatView, seat_view


class Recorder:
    """A policy that calls and remembers which hands it was asked about."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.asked: list[tuple[int, ...]] = []

    def act(self, view: SeatView, rng: random.Random) -> Action:
        assert view.hole_cards is not None
        self.asked.append(view.hole_cards)
        return Action.check() if view.legal and view.legal.can_check else Action.call()


def play(state: HandState, policies: list[Policy], rng: random.Random) -> HandState:
    while not state.is_over:
        seat = state.to_act
        assert seat is not None
        state = apply(state, policies[seat].act(seat_view(state, seat), rng))
    return state


def hands(n: int, seed: int = 0) -> list[HandState]:
    return [start_hand(HandConfig(50, 100), [10_000, 10_000], i % 2, deck=deck_for(seed, i)) for i in range(n)]


def test_each_hand_is_played_by_one_bot_from_start_to_end() -> None:
    strong, weak = Recorder("strong"), Recorder("weak")
    mixed = MixedPolicy(strong, weak, 0.5)
    rng = random.Random(7)
    for state in hands(200):
        before = (len(strong.asked), len(weak.asked))
        play(state, [mixed, CallingStationPolicy()] if state.button == 0 else [CallingStationPolicy(), mixed], rng)
        grew = (len(strong.asked) > before[0], len(weak.asked) > before[1])
        assert grew in ((True, False), (False, True))
        assert mixed.last_strong == grew[0]
    assert mixed.hands["strong"] + mixed.hands["weak"] == 200
    assert 70 < mixed.hands["strong"] < 130


def test_the_draw_is_one_number_from_the_bots_generator_at_its_first_decision() -> None:
    """The order the TypeScript port must keep: one ``random()`` before the hand's first action, none after."""
    state = hands(1)[0]
    strong, weak = Recorder("strong"), Recorder("weak")
    mixed = MixedPolicy(strong, weak, 0.5)
    rng = random.Random(11)
    expected = random.Random(11).random() < 0.5
    seat = state.to_act
    assert seat == 0  # the button, the small blind heads-up
    state = apply(state, mixed.act(seat_view(state, 0), rng))
    assert mixed.last_strong == expected
    after = rng.getstate()
    state = apply(state, Action.check())  # the big blind; then the flop, where seat 1 checks too
    state = apply(state, Action.check())
    assert state.to_act == 0
    mixed.act(seat_view(state, 0), rng)
    assert rng.getstate() == after, "a later decision in the same hand drew again"


def test_a_new_hand_draws_again_even_with_the_same_cards() -> None:
    state = hands(1)[0]
    strong, weak = Recorder("strong"), Recorder("weak")
    mixed = MixedPolicy(strong, weak, 0.5)
    rng = random.Random(3)
    later = apply(state, mixed.act(seat_view(state, 0), rng))
    later = apply(apply(later, Action.check()), Action.check())
    mixed.act(seat_view(later, 0), rng)
    assert mixed.hands["strong"] + mixed.hands["weak"] == 1
    # The same deal again: its actions do not extend what was seen, so it is a new hand.
    mixed.act(seat_view(state, 0), rng)
    assert mixed.hands["strong"] + mixed.hands["weak"] == 2


def test_the_shares_at_the_ends_are_one_bot() -> None:
    for share, which in ((1.0, "strong"), (0.0, "weak")):
        strong, weak = Recorder("strong"), Recorder("weak")
        mixed = MixedPolicy(strong, weak, share)
        for state in hands(20):
            play(state, [mixed, mixed], random.Random(1))
        assert mixed.hands[which] > 0 and mixed.hands["weak" if which == "strong" else "strong"] == 0
    with pytest.raises(ValueError):
        MixedPolicy(CallingStationPolicy(), share=1.5)


def test_medium_is_half_the_champion_and_half_riverMind_easy() -> None:
    m = medium(RandomPolicy())
    assert m.name == "medium" and m.share == MEDIUM_SHARE == 0.5
    assert isinstance(m.weak, HeuristicPolicy) and isinstance(m.strong, RandomPolicy)
    # Every action is one of the two bots' own, so it is always legal.
    rng = random.Random(5)
    for state in hands(60, seed=2):
        final = play(state, [m, HeuristicPolicy()], rng)
        assert final.is_over
