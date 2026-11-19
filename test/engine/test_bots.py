"""The simple bots (P2.7): legal play over fuzzed hands and sensible decisions."""

from __future__ import annotations

import random

import pytest

from rivermind.bots import CallingStationPolicy, HeuristicPolicy, Policy, RandomPolicy, chen_score, hand_strength
from rivermind.engine import Action, ActionKind, LegalActions, cards
from rivermind.engine.fuzz import play_random_hand
from rivermind.engine.state import HandState
from rivermind.engine.view import seat_view

from .helpers import deal, play

BOTS = [RandomPolicy(), CallingStationPolicy(), HeuristicPolicy()]


def chooser(policy: Policy):  # type: ignore[no-untyped-def]
    def choose(state: HandState, legal: LegalActions, rng: random.Random) -> Action:
        return policy.act(seat_view(state, legal.seat), rng)

    return choose


@pytest.mark.parametrize("policy", BOTS, ids=lambda p: p.name)
def test_bot_plays_a_thousand_fuzzed_hands_legally(policy: Policy) -> None:
    rng = random.Random(f"bots:{policy.name}")
    kinds: set[ActionKind] = set()
    for i in range(1_000):
        state = play_random_hand(2 + i % 8, rng, choose=chooser(policy), check_illegal=False)
        kinds.update(a.kind for a in state.actions)
    if policy.name == "calling_station":
        assert kinds <= {ActionKind.CHECK, ActionKind.CALL}
    else:
        assert kinds == set(ActionKind)


def test_mixed_table_plays_legally() -> None:
    rng = random.Random("mixed")

    def choose(state: HandState, legal: LegalActions, r: random.Random) -> Action:
        return BOTS[legal.seat % 3].act(seat_view(state, legal.seat), r)

    for i in range(300):
        play_random_hand(2 + i % 8, rng, choose=choose)


def test_bot_refuses_when_not_to_act() -> None:
    state = deal([1_000, 1_000, 1_000], 0)
    with pytest.raises(ValueError):
        CallingStationPolicy().act(seat_view(state, 1), random.Random(0))


def test_chen_scores() -> None:
    expected = {"As Ad": 20, "Ks Kd": 16, "2s 2d": 5, "As Ks": 12, "Ah Kd": 10, "Jh Th": 9, "5h 4h": 6, "7c 2d": -1}
    for hole, score in expected.items():
        assert chen_score(cards(hole)) == score  # type: ignore[arg-type]


def test_hand_strength_bounds() -> None:
    assert hand_strength(cards("As Ks"), cards("Qs Js Ts")) == 1.0  # type: ignore[arg-type]
    weak = hand_strength(cards("7c 2d"), cards("As Kh 9s"))  # type: ignore[arg-type]
    assert weak < 0.2


def act(state: HandState) -> Action:
    return HeuristicPolicy().act(seat_view(state, state.to_act), random.Random(0))  # type: ignore[arg-type]


def test_heuristic_preflop() -> None:
    state = deal([10_000] * 6, 2, holes={5: "As Ad"})
    assert act(state) == Action.raise_to(250)
    assert act(deal([10_000] * 6, 2, holes={5: "7c 2d"})) == Action.fold()
    state = play(deal([10_000] * 6, 2, holes={0: "Kh Kd"}), "S5:r300")
    assert act(state) == Action.raise_to(900)
    state = play(deal([10_000] * 6, 2, holes={4: "7c 2d"}), "S5:c S0:c S1:c S2:c S3:c")
    assert act(state) == Action.check()


def test_heuristic_postflop() -> None:
    holes = {0: "As Ks", 1: "7c 2d"}
    state = play(deal([10_000, 10_000], 0, holes, board="Qs Js Ts 4h 3c"), "S0:c S1:k")
    assert act(state) == Action.check()  # S1 with seven high on a straight-flush board
    state = play(state, "S1:k")
    assert act(state).kind is ActionKind.BET  # S0 holds the nuts
    state = play(state, "S0:b200")
    assert act(state) == Action.fold()
