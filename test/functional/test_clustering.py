import math

import numpy as np
import pytest

from poker_ai.clustering.card_combos import CardCombos
from poker_ai.clustering.card_info_lut_builder import CardInfoLutBuilder
from poker_ai.clustering.game_utility import GameUtility
from poker_ai.poker.evaluation.eval_card import EvaluationCard


@pytest.mark.parametrize(
    "hero, opponent, board, expected_index, expected_vector",
    [
        ("As Ah", "Ks Kh", "Ac Ad Kc Kd Ts", 0, [1, 0, 0]),
        ("Ks Kh", "As Ah", "Ac Ad Kc Kd Ts", 1, [0, 1, 0]),
        ("As Ah", "Ks Kh", "Tc Jc Qc Kc Ac", 2, [0, 0, 1]),
    ],
    ids=["hero-quads-win", "hero-quads-loss", "royal-flush-on-board"],
)
def test_river_hand_strength(hero, opponent, board, expected_index, expected_vector):
    def cards(hand):
        return np.array([EvaluationCard.new(card) for card in hand.split()])

    # Once the hero and board are dealt, only the specified opponent hand remains.
    game = GameUtility(cards(hero), cards(board), cards(f"{hero} {board} {opponent}"))
    # Exercise the river simulation without enumerating every board in the deck.
    builder = CardInfoLutBuilder.__new__(CardInfoLutBuilder)
    builder.n_simulations_river = 1

    index = game.get_winner()
    vector = builder.simulate_get_ehs(game)
    assert (index, vector.tolist()) == (expected_index, expected_vector)


def _get_num_combos(n: int, r: int):
    """Return number of combinations.

    Parameters
    ----------
    n : int
        Number to choose from
    r : int
        Number to choose

    Returns
    -------
        Number of combinations
    """
    return math.factorial(n) / (math.factorial(n - r) * math.factorial(r))


@pytest.mark.parametrize("low_card_rank", [11, 12])
def test_clustering_1(low_card_rank: int):
    """Test the number of cards created.

    Parameters
    ----------
    low_card_rank : int
        Lowest card rank in the deck 2-14
    """
    high_card_rank = 14
    card_combos = CardCombos(
        low_card_rank=low_card_rank,
        high_card_rank=high_card_rank,
    )
    n_cards = len(card_combos._cards)
    n_hole_cards = _get_num_combos(n_cards, 2)
    assert len(card_combos.starting_hands) == n_hole_cards
    # Number of hole card, and separately public card, combinations.
    assert len(card_combos.flop) == _get_num_combos(n_cards - 2, 3) * n_hole_cards
    assert len(card_combos.turn) == _get_num_combos(n_cards - 2, 4) * n_hole_cards
    assert len(card_combos.river) == _get_num_combos(n_cards - 2, 5) * n_hole_cards
