"""Kuhn poker in the blueprint trainer's terms, for tests whose answer is known.

Three cards (jack, queen, king), an ante of one chip each and one betting
round with a bet of one chip. Seat 0 acts first. Payoffs are scaled by
``SCALE`` so that whole-chip regret deltas lose nothing that matters. The
game is worth -1/18 to seat 0.
"""

from __future__ import annotations

import itertools
from typing import Any

import numpy as np

from rivermind.bots.blueprint import Game, Tree
from rivermind.bots.blueprint.tree import FOLD, SHOWDOWN

SCALE = 100
VALUE = -SCALE / 18


def kuhn_tree() -> Tree:
    # Nodes: 0 "" (seat 0), 1 "k" (seat 1), 2 "kb" (seat 0), 3 "b" (seat 1).
    return Tree(
        abstraction="kuhn",
        depth=1,
        small_blind=1,
        big_blind=1,
        player=[0, 1, 0, 1],
        street=[0, 0, 0, 0],
        offset=[0, 2, 4, 6],
        history=["", "k", "kb", "b"],
        tokens=[("k", "b"), ("k", "b"), ("f", "c"), ("f", "c")],
        children=[(1, 3), (~0, 2), (~1, ~2), (~3, ~4)],
        terminal_kind=[SHOWDOWN, FOLD, SHOWDOWN, FOLD, SHOWDOWN],
        terminal_value=[SCALE, -SCALE, 2 * SCALE, SCALE, 2 * SCALE],
        width=(8, 0, 0, 0),
    )


class KuhnDealer:
    buckets = (3, 1, 1, 1)

    def deal(self, rng: np.random.Generator, n: int) -> tuple[np.ndarray, np.ndarray]:
        cards = rng.random((n, 3)).argsort(axis=1)[:, :2]
        buckets = np.zeros((n, 2, 4), dtype=np.int64)
        buckets[:, 0, 0] = cards[:, 0]
        buckets[:, 1, 0] = cards[:, 1]
        return buckets, np.sign(cards[:, 0] - cards[:, 1]).astype(np.int64)

    def describe(self) -> dict[str, Any]:
        return {"kind": "kuhn", "sha256": {"kuhn": "0"}}


def kuhn_game() -> Game:
    return Game((kuhn_tree(),), KuhnDealer.buckets)


def strategy_profile(game: Game, sums: np.ndarray) -> dict[tuple[int, int], list[float]]:
    """Normalized strategy per (node, card), uniform where nothing was summed."""
    tree = game.trees[0]
    out = {}
    for node in range(len(tree)):
        n = len(tree.children[node])
        for card in range(3):
            slot = game.slot(0, node, card)
            row = [float(x) for x in sums[slot : slot + n]]
            total = sum(row)
            out[node, card] = [x / total for x in row] if total > 0 else [1 / n] * n
    return out


def expected_value(tree: Tree, profile: dict[tuple[int, int], list[float]]) -> float:
    """Seat 0's expected payoff when both seats play ``profile``."""

    def walk(node: int, cards: tuple[int, int]) -> float:
        if node < 0:
            t = ~node
            if tree.terminal_kind[t] == FOLD:
                return tree.terminal_value[t]
            return tree.terminal_value[t] * (1 if cards[0] > cards[1] else -1)
        probs = profile[node, cards[tree.player[node]]]
        return sum(p * walk(c, cards) for p, c in zip(probs, tree.children[node]) if p)

    deals = list(itertools.permutations(range(3), 2))
    return sum(walk(0, d) for d in deals) / len(deals)


def exploitability(game: Game, sums: np.ndarray) -> float:
    """How much two best responders gain against the profile together; 0 at an equilibrium."""
    tree = game.trees[0]
    profile = strategy_profile(game, sums)

    def best(seat: int) -> float:
        keys = [(v, c) for v in range(len(tree)) if tree.player[v] == seat for c in range(3)]
        found = []
        for choice in itertools.product((0, 1), repeat=len(keys)):
            mixed = dict(profile)
            for key, a in zip(keys, choice):
                mixed[key] = [1.0 if i == a else 0.0 for i in range(2)]
            found.append(expected_value(tree, mixed))
        return max(found) if seat == 0 else min(found)

    return best(0) - best(1)
