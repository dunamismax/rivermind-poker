"""A small three-seat game in the multiway trainer's terms, and dealers for it (P5.6).

``TINY`` has the shape of ``6max-s1`` (one size a level, all-in always
there, betting states merged) with three seats and stacks of 20 big blinds,
so it compiles in a moment. ``StrengthDealer`` deals each seat one strength
that is its bucket on every street and its rank at the showdown.
"""

from __future__ import annotations

import dataclasses
from fractions import Fraction as F
from typing import Any

import numpy as np

from rivermind.bots.blueprint import Game
from rivermind.bots.blueprint.abstraction import HU_M1, SIX_MAX_S1, Abstraction
from rivermind.bots.blueprint.tree import Tree, _compile_multiway
from rivermind.engine import Street

TINY = Abstraction(
    "test-3max",
    3,
    ((F(5, 2),), (F(3),)),
    {Street.FLOP: ((F(3, 4),), (F(1),)), Street.TURN: ((F(3, 4),),), Street.RIVER: ((F(3, 4),),)},
    (20,),
    merged=True,
)
TINY_UNMERGED = dataclasses.replace(TINY, name="test-3max-unmerged", merged=False)
HU_TWIN = dataclasses.replace(HU_M1, name="hu-m1")
"""The ``hu-m1`` sizes, to compile as a multiway tree and compare with the heads-up one."""
SIX = SIX_MAX_S1

STRENGTHS = 6


class StrengthDealer:
    """Each seat gets a strength 0 to 5: its bucket on every street, and the higher strength wins the showdown."""

    buckets = (STRENGTHS, STRENGTHS, STRENGTHS, STRENGTHS)

    def deal_seats(self, rng: np.random.Generator, n: int, seats: int) -> tuple[np.ndarray, np.ndarray]:
        strength = rng.integers(0, STRENGTHS, (n, seats))
        buckets = np.repeat(strength[:, :, None], 4, axis=2).astype(np.int64)
        return buckets, (STRENGTHS - 1 - strength).astype(np.int64)  # lower ranks are better

    def deal(self, rng: np.random.Generator, n: int) -> tuple[np.ndarray, np.ndarray]:
        buckets, ranks = self.deal_seats(rng, n, 2)
        return buckets, np.sign(ranks[:, 1] - ranks[:, 0]).astype(np.int64)

    def describe(self) -> dict[str, Any]:
        return {"kind": "strengths", "sha256": {"strengths": "0"}}


def tiny_tree(abstraction: Abstraction = TINY, depth: int = 20) -> Tree:
    return _compile_multiway(depth, abstraction)


def tiny_game() -> Game:
    return Game((tiny_tree(),), StrengthDealer.buckets)
