"""The engine's hand evaluator against the legacy Deuces copy (rule 10)."""

from __future__ import annotations

import random

import pytest

from poker_ai.poker.evaluation import EvaluationCard, Evaluator
from rivermind.engine import card_str, cards
from rivermind.engine.evaluator import MAX_HIGH_CARD, describe, evaluate, rank_class


@pytest.mark.parametrize("size", [5, 6, 7])
def test_matches_deuces_on_random_hands(size: int) -> None:
    deuces = Evaluator()
    rng = random.Random(size)
    for _ in range(4000):
        hand = rng.sample(range(52), size)
        expected = deuces.evaluate([EvaluationCard.new(card_str(c)) for c in hand], [])
        assert evaluate(hand) == expected


def test_10_rule_example() -> None:
    board = cards("Ks Kh 7d 7c 2s")
    a = evaluate(cards("Ah 3d") + board)
    b = evaluate(cards("Qc Jc") + board)
    assert a < b and describe(a) == describe(b) == "Two Pair"
    assert evaluate(cards("Ac 4c") + board) == a


def test_extremes_and_classes() -> None:
    assert evaluate(cards("As Ks Qs Js Ts 2c 3d")) == 1
    assert evaluate(cards("7c 5d 4h 3s 2c")) == MAX_HIGH_CARD
    assert describe(evaluate(cards("5s 4h 3d 2c Ah 9c 9d"))) == "Straight"
    assert evaluate(cards("5s 4h 3d 2c Ah")) > evaluate(cards("6s 5h 4d 3c 2h"))
    assert [rank_class(v) for v in (1, 11, 167, 323, 1600, 1610, 2468, 3326, 6186)] == list(range(1, 10))
    with pytest.raises(ValueError):
        evaluate(cards("As Ks"))
