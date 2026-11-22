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

A tree of more than two seats, or a merged one, is walked by
``_run_chunk_multiway`` (P5.6): the traverser is seat ``iteration % seats``,
every other seat's actions are sampled, and the walk stops where the
traverser folds, since the hand can cost it nothing more. With two seats
and an unmerged tree it makes the same draws and the same sums as the walk
above, which ``test_blueprint_multiway.py`` holds it to.
"""

from __future__ import annotations

import itertools
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
    if game.trees[0].multiway:
        return _run_chunk_multiway(game, regrets, dealer, chunk)
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
    # Changes by info set: its first slot, then one entry per action.
    dr: dict[int, list[float]] = {}
    ds: dict[int, list[float]] = {}
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
        mine = dr_get(slot)
        if mine is not None:
            for i in range(na):
                r[i] += mine[i]
        total = 0.0
        for x in r:
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
            if mine is None:
                mine = dr[slot] = [0.0] * na
            for i in range(na):
                u = values[i]
                if u is not None:
                    mine[i] += u - node
            return node
        sums = ds_get(slot)
        if sums is None:
            ds[slot] = sigma
        else:
            for i in range(na):
                sums[i] += sigma[i]
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
        regret_slots=_slots(dr),
        regret_deltas=np.rint(_values(dr)).astype(np.int64),
        strategy_slots=_slots(ds),
        strategy_deltas=_values(ds),
        nodes=visited,
    )


def _run_chunk_multiway(game: Game, regrets: np.ndarray, dealer: Dealer, chunk: Chunk) -> ChunkResult:
    seats = game.seats
    rng = np.random.default_rng([chunk.seed, chunk.index])
    n = chunk.size
    weights = np.cumsum(game.depth_weights)
    depth_of = np.minimum(np.searchsorted(weights, rng.random(n), side="right"), len(game.trees) - 1).tolist()
    buckets, ranks = dealer.deal_seats(rng, n, seats)  # type: ignore[attr-defined]
    sampler = random.Random(int(rng.integers(1 << 62)))
    rnd = sampler.random
    rows = np.empty((n, 4 * seats), dtype=np.int64)
    base = np.array(game.base, dtype=np.int64)
    widths = np.array([t.width for t in game.trees], dtype=np.int64)
    d_arr = np.array(depth_of, dtype=np.int64)
    for seat in range(seats):
        rows[:, 4 * seat : 4 * seat + 4] = base[d_arr] + buckets[:, seat, :] * widths[d_arr]
    rows_list = rows.tolist()
    ranks_list = ranks.tolist()

    tree_lists = [
        (
            t.player,
            t.street,
            t.offset,
            t.children,
            t.contribution,
            t.folds,
            [k == FOLD for k in t.terminal_kind],
            t.terminal_value,
            t.terminal_pot,
            t.terminal_live,
        )
        for t in game.trees
    ]
    dr: dict[int, list[float]] = {}
    ds: dict[int, list[float]] = {}
    dr_get = dr.get
    ds_get = ds.get
    threshold = chunk.prune_threshold
    visited = 0

    player: list[int] = []
    street: list[int] = []
    offset: list[int] = []
    children: list[tuple[int, ...]] = []
    contribution: list[int] = []
    folds: list[bool] = []
    is_fold: list[bool] = []
    each: list[int] = []
    pot: list[int] = []
    live: list[tuple[int, ...]] = []
    row: list[int] = []
    rank: list[int] = []
    traverser = 0
    pruning = False

    def settle(t: int) -> float:
        """What the traverser, still in, wins at terminal ``t``."""
        if is_fold[t]:
            return pot[t] - each[t]  # everyone else folded
        mine = rank[traverser]
        share = 0
        for seat in live[t]:
            r = rank[seat]
            if r < mine:  # lower ranks are better
                return -each[t]
            if r == mine:
                share += 1
        return pot[t] / share - each[t]

    def walk(v: int) -> float:
        nonlocal visited
        visited += 1
        p = player[v]
        s = street[v]
        slot = row[4 * p + s] + offset[v]
        kids = children[v]
        na = len(kids)
        r = regrets[slot : slot + na].tolist()
        mine = dr_get(slot)
        if mine is not None:
            for i in range(na):
                r[i] += mine[i]
        total = 0.0
        for x in r:
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
                if i == 0 and folds[v]:
                    u: float = -contribution[v]  # out of the hand, whatever the others go on to do
                elif c < 0:
                    u = settle(~c)
                elif prune and r[i] < threshold:
                    values.append(None)
                    continue
                else:
                    u = walk(c)
                values.append(u)
                node += sigma[i] * u
            if mine is None:
                mine = dr[slot] = [0.0] * na
            for i in range(na):
                w = values[i]
                if w is not None:
                    mine[i] += w - node
            return node
        sums = ds_get(slot)
        if sums is None:
            ds[slot] = sigma
        else:
            for i in range(na):
                sums[i] += sigma[i]
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
            return settle(~c)
        return walk(c)

    for j in range(n):
        it = chunk.first + j
        player, street, offset, children, contribution, folds, is_fold, each, pot, live = tree_lists[depth_of[j]]
        row = rows_list[j]
        rank = ranks_list[j]
        traverser = it % seats
        pruning = it >= chunk.prune_after and rnd() < chunk.prune_probability
        walk(0)

    return ChunkResult(
        index=chunk.index,
        regret_slots=_slots(dr),
        regret_deltas=np.rint(_values(dr)).astype(np.int64),
        strategy_slots=_slots(ds),
        strategy_deltas=_values(ds),
        nodes=visited,
    )


def _slots(changes: dict[int, list[float]]) -> np.ndarray:
    """Every slot of the changed info sets, in the order they were first changed."""
    if not changes:
        return np.zeros(0, dtype=np.int64)
    firsts = np.fromiter(changes.keys(), dtype=np.int64, count=len(changes))
    sizes = np.fromiter((len(v) for v in changes.values()), dtype=np.int64, count=len(changes))
    return np.repeat(firsts, sizes) + (np.arange(int(sizes.sum())) - np.repeat(np.cumsum(sizes) - sizes, sizes))


def _values(changes: dict[int, list[float]]) -> np.ndarray:
    if not changes:
        return np.zeros(0, dtype=np.float64)
    return np.fromiter(itertools.chain.from_iterable(changes.values()), dtype=np.float64)
