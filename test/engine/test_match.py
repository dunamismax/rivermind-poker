"""The blueprint policy's action mapping (P5.4, P5.7a) and the duplicate match harness (P5.4)."""

from __future__ import annotations

import random
from collections import Counter

import numpy as np
import pytest

from rivermind.bots import MinBetPolicy
from rivermind.bots.blueprint import Game, compile_tree
from rivermind.bots.blueprint.policy import BlueprintPolicy, pseudo_harmonic
from rivermind.bots.match import Matchup, deck_for, run_matchup
from rivermind.engine import Action, HandConfig, HandState, Street, apply, start_hand
from rivermind.engine.view import seat_view


class FakeBlueprint:
    """The hu-m1 trees with one bucket a street and a strategy the test writes."""

    def __init__(self) -> None:
        self.game = Game((compile_tree(50), compile_tree(100)), (1, 1, 1, 1))
        self.strategy = np.zeros(self.game.size)
        self.manifest = {"cards": {"sha256": {"fake": "0"}}}

    def always(self, depth: int, history: str, token: str) -> None:
        d = self.game.depth_index(depth)
        tree = self.game.trees[d]
        node = tree.node(history)
        slot = self.game.slot(d, node, 0)
        self.strategy[slot : slot + len(tree.tokens[node])] = 0
        self.strategy[slot + tree.tokens[node].index(token)] = 1


class FakeTables:
    sha256 = {"fake": "0"}

    def bucket(self, hole: object, board: object = ()) -> int:
        return 0


@pytest.fixture(scope="module")
def blueprint() -> FakeBlueprint:
    return FakeBlueprint()


def policy_for(bp: FakeBlueprint) -> BlueprintPolicy:
    return BlueprintPolicy(bp, FakeTables())  # type: ignore[arg-type]


def hand(stack: int = 10_000, blinds: tuple[int, int] = (50, 100), seed: int = 0) -> HandState:
    return start_hand(HandConfig(*blinds), [stack, stack], 0, deck=deck_for(seed, 0))


def test_the_pseudo_harmonic_example_from_the_design() -> None:
    assert pseudo_harmonic(1 / 3, 3 / 4, 1 / 2) == pytest.approx(0.533, abs=5e-4)
    assert pseudo_harmonic(0.5, 1.0, 0.5) == 1 and pseudo_harmonic(0.5, 1.0, 1.0) == 0


def test_its_own_sizes_come_from_the_real_pot(blueprint: FakeBlueprint) -> None:
    blueprint.always(100, "", "r0")
    bot = policy_for(blueprint)
    assert bot.act(seat_view(hand(), 0), random.Random(0)) == Action.raise_to(250)
    # The same 2.5× open at other stakes, and at 60 big blinds on the 50 tree.
    assert bot.act(seat_view(hand(5_000, (25, 50)), 0), random.Random(0)) == Action.raise_to(125)
    blueprint.always(50, "", "r1")
    assert bot.act(seat_view(hand(6_000), 0), random.Random(0)) == Action.raise_to(400)


def test_off_tree_raises_map_by_the_pseudo_harmonic_rule(blueprint: FakeBlueprint) -> None:
    # An open to 300 is x = 1.0, between 2.5× (0.75) and 4× (1.5): it maps to 2.5× with p = 0.583.
    blueprint.always(100, "r0", "c")
    blueprint.always(100, "r1", "f")
    bot = policy_for(blueprint)
    state = apply(hand(), Action.raise_to(300))
    seen: Counter[str] = Counter()
    rng = random.Random(7)
    for _ in range(4_000):
        bot.new_hand()
        seen[bot.act(seat_view(state, 1), rng).kind.value] += 1
    p = pseudo_harmonic(0.75, 1.5, 1.0)
    assert p == pytest.approx(0.5833, abs=1e-4)
    assert seen["call"] / 4_000 == pytest.approx(p, abs=0.03)  # about four standard errors
    assert seen["call"] + seen["fold"] == 4_000 and bot.stats["off_tree"] == 4_000


def test_small_bets_and_shoves_map_to_the_nearest_ends(blueprint: FakeBlueprint) -> None:
    blueprint.always(100, "r0", "c")
    blueprint.always(100, "a", "f")
    bot = policy_for(blueprint)
    # A minimum raise to 200 is below the smallest size and maps to it.
    assert bot.act(seat_view(apply(hand(), Action.raise_to(200)), 1), random.Random(0)) == Action.call()
    assert bot.stats["below_smallest"] == 1
    # An all-in is all-in.
    assert bot.act(seat_view(apply(hand(), Action.raise_to(10_000)), 1), random.Random(0)) == Action.fold()


def test_it_reenters_the_tree_when_mapping_ends_the_abstract_hand(blueprint: FakeBlueprint) -> None:
    # A raise to 9,800 of 10,000 maps to all-in (p of 4× is 0.001); calling it ends
    # the abstract hand, but the real one goes on to the flop with 200 behind.
    blueprint.always(100, "a", "c")
    bot = policy_for(blueprint)
    rng = random.Random(1)
    state = apply(hand(), Action.raise_to(9_800))
    assert bot.act(seat_view(state, 1), rng) == Action.call()
    state = apply(state, Action.call())
    assert state.street is Street.FLOP and state.to_act == 1
    tree = blueprint.game.trees[1]
    reentry = min(tree.street_starts(1), key=lambda v: abs(np.log(tree.spr[v]) - np.log(200 / 19_600)))
    blueprint.always(100, tree.history[reentry], "a")
    action = bot.act(seat_view(state, 1), rng)
    assert bot.stats["reentries"] >= 1 and action == Action.bet(200)
    assert apply(state, action).to_act == 0  # the opponent now faces the last 200


def test_an_untrained_node_checks_or_calls(blueprint: FakeBlueprint) -> None:
    bot = policy_for(blueprint)
    state = apply(apply(hand(), Action.call()), Action.check())  # limp, check: the flop
    assert state.street is Street.FLOP and state.to_act == 1
    assert bot.act(seat_view(state, 1), random.Random(0)) == Action.check()
    assert bot.stats["untrained_node"] == 1


def test_it_refuses_other_cards_and_more_seats(blueprint: FakeBlueprint) -> None:
    class Other(FakeTables):
        sha256 = {"fake": "1"}

    with pytest.raises(ValueError, match="card tables"):
        BlueprintPolicy(blueprint, Other())  # type: ignore[arg-type]
    three = start_hand(HandConfig(50, 100), [10_000] * 3, 0, deck=deck_for(0, 0))
    with pytest.raises(ValueError, match="heads-up"):
        policy_for(blueprint).act(seat_view(three, three.to_act), random.Random(0))  # type: ignore[arg-type]


# The match harness


def test_the_min_bet_probe_opens_every_street_with_the_minimum() -> None:
    probe = MinBetPolicy()
    state = hand()
    assert probe.act(seat_view(state, 0), random.Random(0)) == Action.raise_to(200)
    state = apply(apply(state, Action.call()), Action.check())
    assert probe.act(seat_view(state, 1), random.Random(0)) == Action.bet(100)
    faced = apply(state, Action.bet(300))
    assert probe.act(seat_view(faced, 0), random.Random(0)) == Action.call()


def test_duplicate_matches_cancel_the_cards() -> None:
    summary = run_matchup(Matchup("calling_station", "calling_station", deals=40)).summary()
    assert summary["bb_per_100"] == 0 and summary["ci95_bb_per_100"] == [0, 0] and summary["hands"] == 80
    assert summary["button_bb_per_100"] == -summary["big_blind_bb_per_100"]


def test_a_match_is_reproducible_whatever_the_workers() -> None:
    matchup = Matchup("random", "heuristic", stack_bb=40, deals=120, seed=3)
    one = run_matchup(matchup).summary()
    assert run_matchup(matchup, workers=2).summary() == one
    assert run_matchup(matchup).summary() == one
    other = run_matchup(Matchup("random", "heuristic", stack_bb=40, deals=120, seed=4)).summary()
    assert other != one
    assert one["bb_per_100"] < 0  # random loses to RiverMind Easy
