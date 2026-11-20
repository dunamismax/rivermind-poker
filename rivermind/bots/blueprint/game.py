"""The trained game: trees, card buckets and the layout of the regret and strategy arrays.

Every info set that can occur has room from the start (``docs/bots.md``).
The slot of action *i* at node *v* for bucket *b* on street *s* of depth
class *d* is ``base[d][s] + b × width[d][s] + offset[v] + i`` in one flat
array: the per-street arrays of the design, laid end to end.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from functools import cached_property
from typing import Any, Protocol

import numpy as np

from .tree import Tree

STREET_NAMES = ("preflop", "flop", "turn", "river")


class Dealer(Protocol):
    """Deals the cards of many iterations at once, as buckets and showdown outcomes."""

    buckets: tuple[int, int, int, int]
    """Buckets on each street."""

    def deal(self, rng: np.random.Generator, n: int) -> tuple[np.ndarray, np.ndarray]:
        """``(n, 2, 4)`` buckets by seat and street, and ``(n,)`` outcomes: +1 when seat 0 wins a showdown, -1 when seat 1 does, 0 on a tie."""
        ...

    def describe(self) -> dict[str, Any]:
        """What the manifest records about the cards, such as the table set's SHA-256s."""
        ...


@dataclass(frozen=True)
class Game:
    trees: tuple[Tree, ...]
    buckets: tuple[int, int, int, int]

    @cached_property
    def base(self) -> tuple[tuple[int, int, int, int], ...]:
        out = []
        at = 0
        for tree in self.trees:
            row = []
            for s in range(4):
                row.append(at)
                at += tree.width[s] * self.buckets[s]
            out.append(tuple(row))
        return tuple(out)  # type: ignore[return-value]

    @cached_property
    def size(self) -> int:
        return sum(tree.width[s] * self.buckets[s] for tree in self.trees for s in range(4))

    def info_sets(self, d: int) -> int:
        tree = self.trees[d]
        return sum(tree.nodes_on(s) * self.buckets[s] for s in range(4))

    @cached_property
    def depth_weights(self) -> tuple[float, ...]:
        """Each depth class is trained in proportion to its info sets."""
        counts = [self.info_sets(d) for d in range(len(self.trees))]
        return tuple(c / sum(counts) for c in counts)

    def slot(self, d: int, node: int, bucket: int) -> int:
        """The first slot of an info set; its actions follow in order."""
        tree = self.trees[d]
        s = tree.street[node]
        if not 0 <= bucket < self.buckets[s]:
            raise ValueError(f"bucket {bucket} is out of range for {STREET_NAMES[s]}")
        return self.base[d][s] + bucket * tree.width[s] + tree.offset[node]

    def depth_index(self, depth: int) -> int:
        for d, tree in enumerate(self.trees):
            if tree.depth == depth:
                return d
        raise KeyError(f"no tree for {depth} big blinds")

    def describe(self) -> dict[str, Any]:
        return {
            "buckets": list(self.buckets),
            "size": self.size,
            "base": [list(row) for row in self.base],
            "depth_weights": list(self.depth_weights),
            "trees": [
                {**tree.summary(), "info_sets": self.info_sets(d)} for d, tree in enumerate(self.trees)
            ],
        }

    def slices(self) -> Sequence[tuple[int, int, int, int]]:
        """``(depth index, street, start, stop)`` of each block of the flat arrays."""
        out = []
        for d, tree in enumerate(self.trees):
            for s in range(4):
                start = self.base[d][s]
                out.append((d, s, start, start + tree.width[s] * self.buckets[s]))
        return out
