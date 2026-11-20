"""External-sampling Monte Carlo CFR over a chunk of iterations (P5.3).

A chunk is a run of iterations that starts from one snapshot of the
regrets, sees its own changes as it goes, and returns them instead of
applying them to the snapshot, so chunks can run in any process, in any
order, and give the same result. Each iteration deals one
hand, picks a depth class and updates one player, the **traverser**
(seat ``iteration % 2``): every one of the traverser's actions is explored,
while the opponent's actions and the cards are sampled. Regret matching
turns regrets into the current strategy, and the opponent's current
strategy is added to its average-strategy sums at each node it visits.

With pruning on, an iteration skips the traverser's actions whose regret
is below the threshold, except actions that end the hand and actions on the
river, as Pluribus did.

Everything random in a chunk comes from ``(seed, chunk index)``: the deals,
the depth classes, which iterations prune and every sampled action.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

import numpy as np

from .game import Dealer, Game
from .tree import FOLD


@dataclass(frozen=True)
class Chunk:
    index: int
    first: int
    """Global number of the chunk's first iteration."""
    size: int
    seed: int
    prune_after: int
    prune_probability: float
    prune_threshold: int


@dataclass
class ChunkResult:
    index: int
    regret_slots: np.ndarray
    regret_deltas: np.ndarray
    """Rounded to whole chips, so adding them is exact in any order."""
    strategy_slots: np.ndarray
    strategy_deltas: np.ndarray
    nodes: int
    """Decision nodes visited, for speed reports."""


def run_chunk(game: Game, regrets: np.ndarray, dealer: Dealer, chunk: Chunk) -> ChunkResult:
    rng = np.random.default_rng([chunk.seed, chunk.index])
    n = chunk.size
    weights = np.cumsum(game.depth_weights)
    depth_of = np.minimum(np.searchsorted(weights, rng.random(n), side="right"), len(game.trees) - 1).tolist()
    buckets, outcome = dealer.deal(rng, n)
    sampler = random.Random(int(rng.integers(1 << 62)))
    rnd = sampler.random
    # Each iteration's slot base for (seat, street): base[d][s] + bucket * width[d][s].
    rows = np.empty((n, 8), dtype=np.int64)
    base = np.array(game.base, dtype=np.int64)
    widths = np.array([t.width for t in game.trees], dtype=np.int64)
    d_arr = np.array(depth_of, dtype=np.int64)
    for seat in (0, 1):
        rows[:, 4 * seat : 4 * seat + 4] = base[d_arr] + buckets[:, seat, :] * widths[d_arr]
    rows_list = rows.tolist()
    outcomes = outcome.tolist()

    tree_lists = [
        (
            t.player,
            t.street,
            t.offset,
            t.children,
            [k == FOLD for k in t.terminal_kind],
            t.terminal_value,
        )
        for t in game.trees
    ]
    dr: dict[int, float] = {}
    ds: dict[int, float] = {}
    dr_get = dr.get
    ds_get = ds.get
    threshold = chunk.prune_threshold
    visited = 0

    # Per-iteration state the walk reads from its enclosing scope.
    player: list[int] = []
    street: list[int] = []
    offset: list[int] = []
    children: list[tuple[int, ...]] = []
    is_fold: list[bool] = []
    value: list[int] = []
    row: list[int] = []
    traverser = 0
    sign = 1
    showdown = 0
    pruning = False

    def walk(v: int) -> float:
        nonlocal visited
        visited += 1
        p = player[v]
        s = street[v]
        slot = row[4 * p + s] + offset[v]
        kids = children[v]
        na = len(kids)
        r = regrets[slot : slot + na].tolist()
        total = 0.0
        for i in range(na):
            x = r[i] + dr_get(slot + i, 0.0)
            r[i] = x
            if x > 0:
                total += x
        if total > 0:
            sigma = [x / total if x > 0 else 0.0 for x in r]
        else:
            sigma = [1.0 / na] * na
        if p == traverser:
            prune = pruning and total > 0 and s != 3
            values: list[float | None] = []
            node = 0.0
            for i in range(na):
                c = kids[i]
                if c < 0:
                    t = ~c
                    u = sign * value[t] if is_fold[t] else showdown * value[t]
                elif prune and r[i] < threshold:
                    values.append(None)
                    continue
                else:
                    u = walk(c)
                values.append(u)
                node += sigma[i] * u
            for i in range(na):
                u = values[i]
                if u is not None:
                    k = slot + i
                    dr[k] = dr_get(k, 0.0) + (u - node)
            return node
        for i in range(na):
            k = slot + i
            ds[k] = ds_get(k, 0.0) + sigma[i]
        x = rnd()
        a = na - 1
        acc = 0.0
        for i in range(na - 1):
            acc += sigma[i]
            if x < acc:
                a = i
                break
        c = kids[a]
        if c < 0:
            t = ~c
            return sign * value[t] if is_fold[t] else showdown * value[t]
        return walk(c)

    for j in range(n):
        it = chunk.first + j
        player, street, offset, children, is_fold, value = tree_lists[depth_of[j]]
        row = rows_list[j]
        traverser = it & 1
        sign = 1 if traverser == 0 else -1
        showdown = sign * outcomes[j]
        pruning = it >= chunk.prune_after and rnd() < chunk.prune_probability
        walk(0)

    return ChunkResult(
        index=chunk.index,
        regret_slots=np.fromiter(dr.keys(), dtype=np.int64, count=len(dr)),
        regret_deltas=np.rint(np.fromiter(dr.values(), dtype=np.float64, count=len(dr))).astype(np.int64),
        strategy_slots=np.fromiter(ds.keys(), dtype=np.int64, count=len(ds)),
        strategy_deltas=np.fromiter(ds.values(), dtype=np.float64, count=len(ds)),
        nodes=visited,
    )
