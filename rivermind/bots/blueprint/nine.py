"""Nine seats on the six-seat blueprint: option 1 (P5.6, ``docs/bots.md``).

At a table of seven to nine players, the first ``k - 6`` to act before the
flop are the **early seats**. When every early seat folds, the hand is the
six-seat game among the last six exactly (folding in turn puts no chips in;
only the folded cards' removal differs), and the six-seat champion plays it
as it is.

An early seat's first decision comes from a small table trained here: for
each depth class, table size, early position and what the early seats
before it did, and each of the 169 pre-flop hand classes, the chances of
fold, call, raise and all-in. Everything else is the six-seat champion. When
an early seat has put chips in, the players are placed on the six-seat
graph's seats in their order of play: the early players who entered first,
then the later ones, the blinds always on the blinds. A graph has room for
four players besides the blinds, so a later player who folded without
putting chips in, or failing that one still to act, is left out; a tree seat
nobody is placed on folds at its turn. After the flop the players still in
re-enter the graph by who is in and the stack-to-pot ratio, as at a six-seat
table.

``train`` learns the early table by Monte Carlo CFR over the early seats'
first decisions alone: at each sampled deal one early seat is the traverser,
the earlier early seats play the current strategy, and each of the
traverser's choices is valued by playing the rest of the hand out with this
policy, the same deal and the same random draws for every choice. The rest
of the table never adapts to the early seats, so the result is the early
seats' response to a fixed six-seat field, not an equilibrium.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import multiprocessing as mp
import random
import subprocess
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import numpy as np

from rivermind.bots.cards import CardTables
from rivermind.bots.policies import HeuristicPolicy
from rivermind.engine import Action, ActionKind, HandConfig, Street, apply, start_hand
from rivermind.engine.view import SeatView, seat_view

from .abstraction import abstract_actions, street_level
from .blueprint import Blueprint
from .policy import MultiwayBlueprintPolicy
from .tree import Tree

NAME = "9max-o1"
"""The nine-seat model's abstraction name: option 1 over the six-seat graph."""
SEATS = 9
SIX = 6
"""The table size of the graph the nine-seat model plays on."""
DEPTHS = (50, 100)
"""The depth classes, as the six-seat graphs'."""
ACTIONS = ("f", "c", "r", "a")
"""An early seat's choices: fold, call (or limp), the abstraction's raise and all-in."""
CONTEXT = "fcra"
"""How an earlier early seat's first action is written in a row's context."""
CLASSES = 169
LEVELS = 255
CHECKPOINT_KIND = "rivermind-nine-checkpoint"
BUNDLE_KIND = "rivermind-nine-bundle"
FORMAT = 1


def _rows() -> tuple[tuple[int, int, int, str], ...]:
    out = []
    for depth in DEPTHS:
        for k in range(SIX + 1, SEATS + 1):
            for i in range(k - SIX):
                for context in itertools.product(CONTEXT, repeat=i):
                    out.append((depth, k, i, "".join(context)))
    return tuple(out)


ROWS = _rows()
"""Each row of the early table: depth class, players dealt in, early position (0 first to act) and the earlier early seats' actions."""
ROW_INDEX = {row: n for n, row in enumerate(ROWS)}
SHAPE = (len(ROWS), CLASSES, len(ACTIONS))


def early_seats(seat_order: Sequence[int]) -> tuple[int, ...]:
    """The early seats of a hand, in their order of play: the first ``k - 6`` after the big blind."""
    k = len(seat_order)
    return tuple(seat_order[2 : 2 + max(0, k - SIX)])


def context_token(kind: ActionKind, all_in: bool) -> str:
    if kind is ActionKind.FOLD:
        return "f"
    if kind in (ActionKind.BET, ActionKind.RAISE):
        return "a" if all_in else "r"
    return "c"


def early_row(view: SeatView, depth: int) -> int | None:
    """The early-table row of the decision facing ``view.seat``, which must be an early seat's first."""
    early = early_seats(view.seat_order)
    i = early.index(view.seat)
    first: dict[int, str] = {}
    for r in view.actions:
        if r.street is Street.PREFLOP and r.seat not in first:
            first[r.seat] = context_token(r.kind, r.all_in)
    if any(s not in first for s in early[:i]):
        return None
    context = "".join(first[s] for s in early[:i])
    return ROW_INDEX.get((depth, len(view.seat_order), i, context))


def is_early_first(view: SeatView) -> bool:
    """Whether the decision is an early seat's first of the hand, which the early table plays."""
    return (
        len(view.seat_order) > SIX
        and view.street is Street.PREFLOP
        and view.seat in early_seats(view.seat_order)
        and not any(r.seat == view.seat for r in view.actions)
    )


def early_options(view: SeatView, abstraction: Any) -> dict[str, Action]:
    """The engine action for each early choice the real table allows."""
    legal = view.legal
    assert legal is not None
    options = abstract_actions(
        legal,
        street=Street.PREFLOP,
        level=street_level(view.actions, Street.PREFLOP),
        pot=view.pot,
        current_bet=view.current_bet,
        street_bets=view.street_bets,
        abstraction=abstraction,
    )
    by = {o.token: o.action for o in options}
    out: dict[str, Action] = {}
    if "f" in by:
        out["f"] = by["f"]
    if "c" in by or "k" in by:
        out["c"] = by.get("c") or by["k"]
    raises = [o.action for o in options if o.token.startswith("r")]
    if raises:
        out["r"] = raises[0]
    if "a" in by:
        out["a"] = by["a"]
    return out


class EarlyTable:
    """The early seats' strategy: weights over ``ACTIONS`` by row and hand class."""

    def __init__(self, weights: np.ndarray) -> None:
        if weights.shape != SHAPE:
            raise ValueError(f"an early table has shape {SHAPE}, not {weights.shape}")
        self.weights = weights

    def probs(self, row: int, cls: int) -> np.ndarray | None:
        w = np.asarray(self.weights[row, cls], dtype=np.float64)
        total = w.sum()
        return w / total if total > 0 else None


FOLD_FIRST = np.eye(len(ACTIONS))[ACTIONS.index("f")]


def regret_matching(regrets: np.ndarray) -> np.ndarray:
    """The current strategy of every row and class; fold where no regret is positive.

    The usual default, uniform, starts every early seat entering three hands
    in four, and the play-outs then fill with early raises and all-ins the
    six-seat field has rarely met. Folding first starts the walk at the
    six-seat game exactly, and an early seat leaves it only for a hand whose
    own values say so.
    """
    positive = np.maximum(regrets, 0.0)
    totals = positive.sum(axis=2, keepdims=True)
    return np.where(totals > 0, positive / np.where(totals > 0, totals, 1.0), FOLD_FIRST)


def quantize(sums: np.ndarray) -> np.ndarray:
    """Average-strategy sums as ``uint8`` probabilities, as a serving bundle's."""
    totals = sums.sum(axis=2, keepdims=True)
    with np.errstate(invalid="ignore", divide="ignore"):
        q = np.where(totals > 0, np.rint(LEVELS * sums / totals), 0)
    return q.astype(np.uint8)


class NineSeatPolicy(MultiwayBlueprintPolicy):
    """A ``Policy`` for tables of three to nine: the six-seat blueprint, and the early table for the early seats' first decisions.

    At six or fewer it is the six-seat policy unchanged.
    """

    def __init__(self, blueprint: Blueprint, tables: CardTables, early: EarlyTable, *, name: str = "blueprint") -> None:
        super().__init__(blueprint, tables, name=name)
        if self.game.seats != SIX:
            raise ValueError("the nine-seat model plays on a six-seat blueprint")
        self.early = early
        self.easy = HeuristicPolicy()
        self._unmapped: frozenset[int] = frozenset()
        self._placed: dict[int, int] | None = None

    def _check_table(self, view: SeatView) -> None:
        if not 3 <= len(view.seat_order) <= SEATS:
            raise ValueError(f"this model plays three to {SEATS} players")

    # Placing the players on the six-seat graph

    def place(self, view: SeatView) -> tuple[dict[int, int], frozenset[int]] | None:
        """Each placed player's tree seat, and the tree seats nobody is placed on; ``None`` when more than four besides the blinds stay in."""
        order = view.seat_order
        k = len(order)
        if k <= SIX:
            return super().tree_seats(view), frozenset()
        early = early_seats(order)
        late = list(order[2 + k - SIX :])
        first: dict[int, ActionKind] = {}
        entered: set[int] = set()
        for r in view.actions:
            if r.street is not Street.PREFLOP:
                continue
            first.setdefault(r.seat, r.kind)
            if r.kind in (ActionKind.CALL, ActionKind.BET, ActionKind.RAISE):
                entered.add(r.seat)
        placed = [s for s in early if s in entered]
        excess = len(placed) + len(late) - 4
        if excess > 0:
            folded = [s for s in late if first.get(s) is ActionKind.FOLD and s not in entered]
            waiting = [s for s in late if s not in first and s != view.seat]
            for s in folded + waiting:
                if excess == 0:
                    break
                late.remove(s)
                excess -= 1
            if excess > 0:
                return None
            self.stats["dropped"] += 1
        placed += late
        slots = (3, 4, 5, 0)
        seats = {s: t for s, t in zip(placed, slots[4 - len(placed) :])}
        seats[order[0]] = 1
        seats[order[1]] = 2
        return seats, frozenset(slots[: 4 - len(placed)])

    def tree_seats(self, view: SeatView) -> dict[int, int]:
        if self._placed is not None:
            return self._placed
        placed = self.place(view)
        if placed is None:
            raise ValueError("no room on the graph for these players")
        return placed[0]

    def _position(self, view: SeatView, hand: Any, rng: random.Random) -> int | None:
        if len(view.seat_order) <= SIX:
            return super()._position(view, hand, rng)
        placed = self.place(view)
        if placed is None:
            return None
        self._placed, self._unmapped = placed
        try:
            if view.seat not in self._placed:
                return None
            return super()._position(view, hand, rng)
        finally:
            self._placed, self._unmapped = None, frozenset()

    def _pass_to(self, tree: Tree, node: int, actor: int, street: Street) -> int | None:
        """As the six-seat policy, and a tree seat nobody is placed on folds."""
        if not self._unmapped:
            return super()._pass_to(tree, node, actor, street)
        for _ in range(2 * self.game.seats):
            if tree.street[node] != street:
                return None
            player = tree.player[node]
            if player == actor:
                return node
            tokens = tree.tokens[node]
            if player in self._unmapped and "f" in tokens:
                node = tree.children[node][tokens.index("f")]
                if node < 0:
                    return None
                continue
            if "k" in tokens:
                node = tree.children[node][tokens.index("k")]
            elif "c" in tokens:
                node = tree.children[node][tokens.index("c")]
            else:
                return None
            if node < 0:
                return None
            self.stats["passed"] += 1
        return None

    def _street_table(self, tree: Tree, node: int, records: list[Any], real: Any, hand: Any, rng: random.Random, seats: dict[int, int], street: Street) -> tuple[bool, int | None]:
        """As the six-seat policy, over the placed players' actions; the others only fold, which costs no chips."""
        kept = []
        for index, record in records:
            if record.seat in seats:
                kept.append((index, record))
            else:
                real.apply(record)
        return super()._street_table(tree, node, kept, real, hand, rng, seats, street)

    def _reenter_table(self, tree: Tree, d: int, street: Street, real: Any, seats: dict[int, int], view: SeatView) -> int | None:
        if street is Street.PREFLOP or len(view.seat_order) <= SIX:
            return super()._reenter_table(tree, d, street, real, seats, view)
        live = sum(1 << seats[s] for s in real.seats if s in seats and s not in real.folded)
        if any(s not in seats and s not in real.folded for s in real.seats):
            return None
        starts = self._starts_by_live[d][street].get(live)
        if not starts:
            return None
        self.stats["reentries"] += 1
        target = real.spr()

        def distance(v: int) -> float:
            a, b = tree.spr[v], target
            if a <= 0 or b <= 0 or math.isinf(b):
                return abs(a - b) if not math.isinf(b) else -a
            return abs(math.log(a) - math.log(b))

        return min(starts, key=distance)

    def _lost(self, view: SeatView, rng: random.Random, passive: Action) -> Action:
        """Where the graph has no room for the players in, or the mapping found no node: RiverMind Easy's action.

        At nine seats a pot can hold more players than the six-seat graph
        has seats; checking and calling there played a calling station's
        game against players who limp (docs/bots.md).
        """
        self.stats["easy"] += 1
        return self.easy.act(view, rng)

    # The early seats

    def act(self, view: SeatView, rng: random.Random) -> Action:
        if view.legal is not None and is_early_first(view):
            return self._early(view, rng)
        return super().act(view, rng)

    def _early(self, view: SeatView, rng: random.Random) -> Action:
        self._check_table(view)
        self.stats["decisions"] += 1
        self.stats["early"] += 1
        self.last_probabilities = None
        hand = self._hand(view)
        hand.seen = view.actions
        options = early_options(view, self.abstraction)
        row = early_row(view, self.game.trees[hand.d].depth)
        hole = view.hole_cards
        assert hole is not None
        probs = None if row is None else self.early.probs(row, self.tables.bucket(hole, ()))
        if probs is not None:
            probs = np.array([p if a in options else 0.0 for a, p in zip(ACTIONS, probs)])
            probs = probs / probs.sum() if probs.sum() > 0 else None
        if probs is None:
            self.stats["early_untrained"] += 1
            return options.get("f") or options["c"]
        self.stats["trained"] += 1
        self.last_probabilities = [float(p) for p in probs]
        x = rng.random()
        acc = 0.0
        choice = ACTIONS[int(np.flatnonzero(probs)[-1])]
        for a, p in zip(ACTIONS, probs):
            acc += float(p)
            if x < acc:
                choice = a
                break
        return options[choice]


# Reading a model


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            digest.update(block)
    return digest.hexdigest()


def _file_entry(path: Path) -> dict[str, Any]:
    return {"sha256": _sha256(path), "bytes": path.stat().st_size}


def read_manifest(directory: str | Path, *, verify: bool = False) -> dict[str, Any]:
    directory = Path(directory)
    manifest: dict[str, Any] = json.loads((directory / "manifest.json").read_text())
    if manifest.get("kind") not in (CHECKPOINT_KIND, BUNDLE_KIND):
        raise ValueError(f"{directory} is not a nine-seat checkpoint or bundle")
    if verify:
        for name, entry in manifest["files"].items():
            if _sha256(directory / name) != entry["sha256"]:
                raise ValueError(f"{directory / name} does not match its manifest")
    return manifest


def is_nine(directory: str | Path) -> bool:
    path = Path(directory) / "manifest.json"
    if not path.is_file():
        return False
    return json.loads(path.read_text()).get("kind") in (CHECKPOINT_KIND, BUNDLE_KIND)


def load_table(directory: str | Path) -> EarlyTable:
    """A checkpoint's average strategy, or a bundle's rounded one."""
    directory = Path(directory)
    manifest = read_manifest(directory)
    if manifest["kind"] == CHECKPOINT_KIND:
        return EarlyTable(np.load(directory / "strategy.npy"))
    return EarlyTable(np.fromfile(directory / "early.u8", dtype=np.uint8).reshape(SHAPE))


def six_seat_bundle(directory: str | Path, override: str | Path | None = None) -> Path:
    """The six-seat bundle a nine-seat model builds on, checked against the hashes it names."""
    manifest = read_manifest(directory)
    path = Path(override or manifest["builds_on"]["bundle"])
    six = json.loads((path / "manifest.json").read_text())
    if {k: v["sha256"] for k, v in six["files"].items()} != manifest["builds_on"]["files"]:
        raise ValueError(f"{path} is not the six-seat bundle {directory} was trained on")
    return path


def load_policy(directory: str | Path, *, six: str | Path | None = None, **kwargs: Any) -> NineSeatPolicy:
    """The nine-seat policy of a checkpoint or bundle, on the six-seat bundle it names."""
    from .bundle import ServingBundle

    served = ServingBundle(six_seat_bundle(directory, six), verify=False)
    base = served.policy()
    return NineSeatPolicy(base.blueprint, base.tables, load_table(directory), **kwargs)


# Training


def _seed(*parts: object) -> int:
    return int.from_bytes(hashlib.sha256(repr(parts).encode()).digest()[:8], "big")


class _Sigma(EarlyTable):
    """The current strategy as an early table: every row and class has data."""


def _class_hands(tables: Any) -> list[list[tuple[int, int]]]:
    hands: list[list[tuple[int, int]]] = [[] for _ in range(CLASSES)]
    for a, b in itertools.combinations(range(52), 2):
        hands[tables.bucket((a, b), ())].append((a, b))
    return hands


class _Walker:
    """One process's training state: the six-seat policy, the hands of each class, and the table being learned."""

    def __init__(self, bundle: str) -> None:
        from .bundle import ServingBundle

        base = ServingBundle(bundle, verify=False).policy()
        self.policy = NineSeatPolicy(base.blueprint, base.tables, _Sigma(regret_matching(np.zeros(SHAPE))))
        self.hands = _class_hands(base.tables)
        self.classes = [c for c in range(CLASSES) if self.hands[c]]
        self.config = HandConfig(50, 100)

    def deal(self, rng: random.Random) -> tuple[int, int, int, int, list[int]]:
        depth = rng.choice(DEPTHS)
        k = rng.choice((7, 8, 9))
        i = rng.randrange(k - SIX)
        cls = rng.choice(self.classes)
        hole = rng.choice(self.hands[cls])
        rest = [c for c in range(52) if c not in hole]
        rng.shuffle(rest)
        # Button on seat 0: seat s gets deck[s - 1] and deck[k + s - 1]; early seat i sits at 3 + i.
        at = 2 + i
        deck = rest[:at] + [hole[0]] + rest[at : at + k - 1] + [hole[1]] + rest[at + k - 1 :]
        return depth, k, i, cls, deck

    def play_out(self, state: Any, rng: random.Random) -> Any:
        while not state.is_over:
            seat = state.to_act
            state = apply(state, self.policy.act(seat_view(state, seat), rng))
        return state

    def chunk(self, sigma: np.ndarray, seed: int, batch: int, chunk: int, iterations: int) -> tuple[np.ndarray, np.ndarray, int]:
        self.policy.early = _Sigma(sigma)
        regrets = np.zeros(SHAPE)
        visits = np.zeros(SHAPE[:2])
        rollouts = 0
        for j in range(iterations):
            rng = random.Random(_seed("nine", seed, batch, chunk, j))
            depth, k, i, cls, deck = self.deal(rng)
            self.policy.new_hand()
            stack = depth * self.config.big_blind
            state = start_hand(self.config, [stack] * k, 0, deck=deck)
            traverser = 3 + i
            while state.to_act != traverser:
                seat = state.to_act
                state = apply(state, self.policy.act(seat_view(state, seat), rng))
            view = seat_view(state, traverser)
            row = early_row(view, depth)
            assert row is not None
            options = early_options(view, self.policy.abstraction)
            values = np.zeros(len(ACTIONS))
            draw = _seed("rollout", seed, batch, chunk, j)
            for n, a in enumerate(ACTIONS):
                if a not in options or a == "f":
                    continue
                self.policy.new_hand()
                end = self.play_out(apply(state, options[a]), random.Random(draw))
                values[n] = (end.final_stacks[traverser] or 0) - stack
                rollouts += 1
            mask = np.array([a in options for a in ACTIONS])
            s = np.where(mask, sigma[row, cls], 0.0)
            s = s / s.sum() if s.sum() > 0 else mask / mask.sum()
            regrets[row, cls] += np.where(mask, values - float(s @ values), 0.0)
            visits[row, cls] += 1
        return regrets, visits, rollouts


_WALKER: _Walker | None = None


def _init(bundle: str) -> None:
    global _WALKER
    _WALKER = _Walker(bundle)


def _run_chunk(args: tuple[np.ndarray, int, int, int, int]) -> tuple[np.ndarray, np.ndarray, int]:
    assert _WALKER is not None
    return _WALKER.chunk(*args)


def _git_commit() -> dict[str, Any]:
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        dirty = bool(subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True, check=True).stdout.strip())
    except (OSError, subprocess.CalledProcessError):
        return {"commit": None, "dirty": None}
    return {"commit": commit, "dirty": dirty}


def train(
    out: str | Path,
    bundle: str | Path,
    *,
    batches: int,
    chunks: int = 16,
    per_chunk: int = 250,
    seed: int = 0,
    workers: int = 1,
    name: str | None = None,
    log: Callable[[dict[str, Any]], None] | None = None,
) -> Path:
    """Learn the early table on a six-seat bundle and write a checkpoint to ``out``.

    Each batch plays ``chunks`` chunks of ``per_chunk`` deals from the same
    current strategy and adds their regrets in chunk order, so the result is
    a function of the settings alone, whatever ``workers`` is. Regrets are
    summed as sampled, never floored: a shove that wins the blinds nine times
    in ten and loses a hundred big blinds the tenth has a negative mean, and
    regret matching plus, which floors the sum at zero after each batch, kept
    such a sum near zero and played the shove (``docs/bots.md``). Batch ``b``
    adds its current strategy to the average with weight ``b`` squared where
    it visited, so the early batches, before the sums have outgrown their
    noise, count for little.
    """
    out, bundle = Path(out), Path(bundle)
    code = _git_commit()  # what the run starts from, before anything can change under it
    six = json.loads((bundle / "manifest.json").read_text())
    regrets = np.zeros(SHAPE)
    sums = np.zeros(SHAPE)
    visits = np.zeros(SHAPE[:2])
    started = time.time()
    rollouts = 0
    pool = mp.get_context("spawn").Pool(workers, initializer=_init, initargs=(str(bundle),)) if workers > 1 else None
    if pool is None:
        _init(str(bundle))
    try:
        for b in range(1, batches + 1):
            sigma = regret_matching(regrets)
            jobs = [(sigma, seed, b, c, per_chunk) for c in range(chunks)]
            parts = pool.map(_run_chunk, jobs, chunksize=1) if pool is not None else [_run_chunk(j) for j in jobs]
            seen = np.zeros(SHAPE[:2])
            for r, v, n in parts:  # in chunk order
                regrets += r
                seen += v
                rollouts += n
            sums += b * b * sigma * (seen > 0)[:, :, None]
            visits += seen
            if log is not None:
                log({"batch": b, "deals": b * chunks * per_chunk, "rollouts": rollouts, "seconds": round(time.time() - started, 1)})
    finally:
        if pool is not None:
            pool.close()
            pool.join()
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / "regrets.npy", regrets)
    np.save(out / "strategy.npy", sums)
    np.save(out / "visits.npy", visits)
    manifest = {
        "format": FORMAT,
        "kind": CHECKPOINT_KIND,
        "abstraction": NAME,
        "seats": SEATS,
        "name": name or out.name,
        "iteration": batches * chunks * per_chunk,
        "settings": {"batches": batches, "chunks": chunks, "per_chunk": per_chunk, "seed": seed},
        "builds_on": {"bundle": str(bundle), "files": {k: v["sha256"] for k, v in six["files"].items()}, "table_set": six["cards"]["table_set"]},
        "rows": [list(r) for r in ROWS],
        "actions": list(ACTIONS),
        "files": {f: _file_entry(out / f) for f in ("regrets.npy", "strategy.npy", "visits.npy")},
        "training": {"seconds": round(time.time() - started, 1), "rollouts": rollouts, "workers": workers},
        "software": code,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return out


def export(checkpoint: str | Path, out: str | Path) -> Path:
    """The serving bundle of a nine-seat checkpoint: its average strategy rounded to ``uint8``."""
    checkpoint, out = Path(checkpoint), Path(out)
    manifest = read_manifest(checkpoint, verify=True)
    if manifest["kind"] != CHECKPOINT_KIND:
        raise ValueError(f"{checkpoint} is not a nine-seat checkpoint")
    out.mkdir(parents=True, exist_ok=True)
    quantize(np.load(checkpoint / "strategy.npy")).tofile(out / "early.u8")
    bundle = {
        "format": FORMAT,
        "kind": BUNDLE_KIND,
        "abstraction": NAME,
        "seats": SEATS,
        "builds_on": manifest["builds_on"],
        "rows": manifest["rows"],
        "actions": manifest["actions"],
        "strategy": {"levels": LEVELS, "shape": list(SHAPE)},
        "checkpoint": {
            "iteration": manifest["iteration"],
            "manifest_sha256": _sha256(checkpoint / "manifest.json"),
            "strategy_sha256": manifest["files"]["strategy.npy"]["sha256"],
        },
        "files": {"early.u8": _file_entry(out / "early.u8")},
        "software": {"git_commit": _git_commit()["commit"]},
    }
    (out / "manifest.json").write_text(json.dumps(bundle, indent=2, sort_keys=True) + "\n")
    return out


def synthetic(out: str | Path, bundle: str | Path, *, seed: int = 0, untrained: float = 0.1) -> Path:
    """A nine-seat bundle with random early weights on a six-seat bundle, for checks that have no trained model, such as CI.

    A share ``untrained`` of rows and classes stays zero, so the untrained fallback is exercised.
    """
    out, bundle = Path(out), Path(bundle)
    rng = np.random.default_rng(seed)
    weights = rng.integers(0, LEVELS + 1, SHAPE, dtype=np.int64).astype(np.uint8)
    weights[rng.random(SHAPE[:2]) < untrained] = 0
    out.mkdir(parents=True, exist_ok=True)
    weights.tofile(out / "early.u8")
    six = json.loads((bundle / "manifest.json").read_text())
    manifest = {
        "format": FORMAT,
        "kind": BUNDLE_KIND,
        "abstraction": NAME,
        "seats": SEATS,
        "builds_on": {"bundle": str(bundle), "files": {k: v["sha256"] for k, v in six["files"].items()}, "table_set": six["cards"]["table_set"]},
        "rows": [list(r) for r in ROWS],
        "actions": list(ACTIONS),
        "strategy": {"levels": LEVELS, "shape": list(SHAPE)},
        "checkpoint": {"iteration": None, "manifest_sha256": None, "strategy_sha256": None},
        "files": {"early.u8": _file_entry(out / "early.u8")},
        "software": {"git_commit": None},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return out


__all__ = [
    "ACTIONS",
    "NAME",
    "ROWS",
    "EarlyTable",
    "NineSeatPolicy",
    "early_seats",
    "export",
    "is_nine",
    "load_policy",
    "load_table",
    "train",
]
