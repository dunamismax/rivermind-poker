"""Play a trained blueprint through a ``SeatView`` (P5.4 and P5.7a, ``docs/bots.md``).

Each decision replays the hand's real actions onto the abstract tree of the
depth class chosen from the effective stack: folds, checks and calls map
one for one, an all-in maps to all-in, and any other bet or raise maps to
one of the two abstract sizes bracketing it by the pseudo-harmonic rule.
When mapping leaves no abstract decision while the real hand goes on, the
bot re-enters the tree at the start of the current street, at the node
whose stack-to-pot ratio is closest to the real one, and replays the
street from there. Its own abstract choices are remembered per hand, so
replaying never redraws them, and the random draws come from the ``rng``
the table passes in (D-8).

The bot plays the average strategy of its info set. One that training
never reached borrows the nearest bucket at the same node that has data,
and failing that the bot checks or calls. ``stats`` counts each case.
"""

from __future__ import annotations

import math
import random
from collections import Counter, OrderedDict
from collections.abc import Sequence
from pathlib import Path

import numpy as np

from rivermind.bots.cards import CardTables
from rivermind.engine import Action, ActionKind, ActionRecord, Street
from rivermind.engine.view import SeatView

from .abstraction import abstract_actions, street_level
from .blueprint import Blueprint
from .tree import Tree

SPLIT_DEPTH_BB = 71
"""Effective stacks below this many big blinds play the 50 big blind tree, others the 100 (``docs/bots.md``)."""
MEMORY = 256
"""Hands whose mapping the policy remembers."""


def pseudo_harmonic(a: float, b: float, x: float) -> float:
    """Probability of mapping a size *x* between abstract sizes *a* < *b* to *a* (Ganzfried and Sandholm, 2013)."""
    return (b - x) * (1 + a) / ((b - a) * (1 + x))


class _Hand:
    """What the policy has worked out about one hand so far."""

    def __init__(self, depth_index: int) -> None:
        self.d = depth_index
        self.tokens: dict[int, str] = {}
        """Abstract token for each real action, by its index in the hand."""
        self.seen: tuple[ActionRecord, ...] = ()
        """The real actions when the policy last acted, to tell this hand from a later one with the same cards."""


class _Real:
    """The real chips, replayed from the posts and actions, as mapping needs them."""

    def __init__(self, view: SeatView) -> None:
        n = view.num_seats
        self.seats = view.seat_order
        """The two players dealt in; a bigger table's empty seats have nothing behind."""
        self.start = [(view.stacks[s] or 0) + view.contributions[s] for s in range(n)]
        self.contributions = [0] * n
        self.street_bets = [0] * n
        self.street = Street.PREFLOP
        for post in view.posts:
            self.contributions[post.seat] += post.amount
            if post.kind != "ante":
                self.street_bets[post.seat] += post.amount
        self.current_bet = max(self.street_bets)

    @property
    def pot(self) -> int:
        return sum(self.contributions)

    def behind(self, seat: int) -> int:
        return self.start[seat] - self.contributions[seat]

    def to_street(self, street: Street) -> None:
        if street != self.street:
            self.street = street
            self.street_bets = [0] * len(self.street_bets)
            self.current_bet = 0

    def apply(self, record: ActionRecord) -> None:
        self.contributions[record.seat] += record.added
        self.street_bets[record.seat] += record.added
        self.current_bet = max(self.current_bet, self.street_bets[record.seat])

    def copy(self) -> _Real:
        other = object.__new__(_Real)
        other.seats = self.seats
        other.start = list(self.start)
        other.contributions = list(self.contributions)
        other.street_bets = list(self.street_bets)
        other.street = self.street
        other.current_bet = self.current_bet
        return other

    def spr(self) -> float:
        """Effective stack behind over the pot."""
        pot = self.pot
        return min(self.behind(s) for s in self.seats) / pot if pot else math.inf


class BlueprintPolicy:
    """A ``Policy`` that plays a blueprint checkpoint heads-up."""

    def __init__(self, blueprint: Blueprint, tables: CardTables, *, name: str = "blueprint") -> None:
        if tables.sha256 != blueprint.manifest["cards"]["sha256"]:
            raise ValueError("these card tables are not the ones the blueprint was trained with")
        self.name = name
        self.blueprint = blueprint
        self.tables = tables
        self.game = blueprint.game
        self.stats: Counter[str] = Counter()
        self.last_probabilities: list[float] | None = None
        """The probabilities of the last decision, or ``None`` when it checked or called without data."""
        self._hands: OrderedDict[tuple[object, ...], _Hand] = OrderedDict()
        self._starts = [[t.street_starts(s) for s in range(4)] for t in self.game.trees]
        self._strategy = np.asarray(blueprint.strategy)

    @classmethod
    def load(cls, checkpoint: str | Path, tables: str | Path | None = None, **kwargs: object) -> BlueprintPolicy:
        bp = Blueprint(checkpoint)
        return cls(bp, CardTables(tables or bp.manifest["cards"]["path"]), **kwargs)  # type: ignore[arg-type]

    @classmethod
    def from_bundle(cls, bundle: str | Path, **kwargs: object) -> BlueprintPolicy:
        """Play a serving bundle's ``uint8`` strategy, as the Node server does (P4B.6)."""
        from .bundle import ServingBundle

        return ServingBundle(bundle).policy(**kwargs)  # type: ignore[no-any-return]

    def new_hand(self) -> None:
        """Forget the hands mapped so far. A table that knows when a hand starts can call this; the policy also tells hands apart by their actions."""
        self._hands.clear()

    # Choosing the tree

    def depth_index(self, view: SeatView) -> int:
        big = view.config.big_blind
        effective = min((view.stacks[s] or 0) + view.contributions[s] for s in view.seat_order) / big
        depths = [t.depth for t in self.game.trees]
        if len(depths) == 1:
            return 0
        want = 50 if effective < SPLIT_DEPTH_BB else 100
        return depths.index(want) if want in depths else int(np.argmin([abs(d - effective) for d in depths]))

    def _hand(self, view: SeatView) -> _Hand:
        key = (
            view.seat,
            view.hole_cards,
            view.posts,
            tuple((view.stacks[s] or 0) + view.contributions[s] for s in range(view.num_seats)),
            view.button,
        )
        hand = self._hands.get(key)
        if hand is None or view.actions[: len(hand.seen)] != hand.seen:
            hand = _Hand(self.depth_index(view))
            self._hands[key] = hand
            while len(self._hands) > MEMORY:
                self._hands.popitem(last=False)
        else:
            self._hands.move_to_end(key)
        return hand

    # Mapping

    def _reenter(self, tree: Tree, d: int, street: Street, real: _Real) -> int:
        self.stats["reentries"] += 1
        target = real.spr()
        starts = self._starts[d][street]

        def distance(v: int) -> float:
            a, b = tree.spr[v], target
            if a <= 0 or b <= 0 or math.isinf(b):
                return abs(a - b) if not math.isinf(b) else -a
            return abs(math.log(a) - math.log(b))

        return min(starts, key=distance)

    def _map_raise(self, tree: Tree, node: int, record: ActionRecord, real: _Real, rng: random.Random) -> str | None:
        tokens = tree.tokens[node]
        sizes = [(m, t) for m, t in zip(tree.measure[node], tokens) if m is not None]
        if not sizes:
            return None
        if record.all_in and "a" in tokens:
            return "a"
        owed = real.current_bet - real.street_bets[record.seat]
        x = (record.to - real.current_bet) / (real.pot + owed)
        if x <= sizes[0][0]:
            if x < sizes[0][0]:
                self.stats["below_smallest"] += 1
            return sizes[0][1]
        for (a, ta), (b, tb) in zip(sizes, sizes[1:]):
            if x <= b:
                if x == b:
                    return tb
                self.stats["off_tree"] += 1
                return ta if rng.random() < pseudo_harmonic(a, b, x) else tb
        return sizes[-1][1]

    def _token(self, tree: Tree, node: int, hand: _Hand, index: int, record: ActionRecord, real: _Real, rng: random.Random) -> str | None:
        """The abstract token of a real action at ``node``: remembered if it fits, otherwise mapped (and remembered)."""
        token = hand.tokens.get(index)
        if token in tree.tokens[node]:
            return token
        kind = record.kind
        if kind is ActionKind.BET or kind is ActionKind.RAISE:
            token = self._map_raise(tree, node, record, real, rng)
        else:
            token = {ActionKind.CHECK: "k", ActionKind.CALL: "c", ActionKind.FOLD: "f"}[kind]
        if token is not None:
            hand.tokens[index] = token
        return token

    def _street(
        self, tree: Tree, node: int, records: list[tuple[int, ActionRecord]], real: _Real, hand: _Hand, rng: random.Random
    ) -> tuple[bool, int | None]:
        """Map one street's actions from ``node``: whether that worked, and the node reached (``None`` after a terminal)."""
        at: int | None = node
        for k, (index, record) in enumerate(records):
            if at is None:
                return False, None  # the abstract hand ended before the real street did
            token = self._token(tree, at, hand, index, record, real, rng)
            real.apply(record)
            if token not in tree.tokens[at]:
                return False, None
            child = tree.children[at][tree.tokens[at].index(token)]
            at = child if child >= 0 else None
        return True, at

    def _position(self, view: SeatView, hand: _Hand, rng: random.Random) -> int | None:
        """The abstract node of the decision now facing ``view.seat``, replaying the hand's actions street by street."""
        d = hand.d
        tree = self.game.trees[d]
        real = _Real(view)
        node: int | None = 0
        for street in Street:
            if street > view.street:
                break
            real.to_street(street)
            if street > Street.PREFLOP and (node is None or tree.street[node] != street):
                node = self._reenter(tree, d, street, real)
            assert node is not None
            records = [(i, r) for i, r in enumerate(view.actions) if r.street == street]
            start = _Real.copy(real)
            ok, reached = self._street(tree, node, records, real, hand, rng)
            if not ok:
                real = _Real.copy(start)
                ok, reached = self._street(tree, self._reenter(tree, d, street, real), records, real, hand, rng)
                if not ok:
                    return None
            node = reached
        if node is None or tree.street[node] != view.street:
            node = self._reenter(tree, d, view.street, real)
        # The tree's seat 0 is the button, wherever the button really sits.
        if tree.player[node] != (0 if view.seat == view.button else 1):
            return None
        return node

    # Acting

    def _strategy_at(self, d: int, node: int, bucket: int) -> np.ndarray | None:
        tree = self.game.trees[d]
        n = len(tree.children[node])
        s = tree.street[node]
        buckets = self.game.buckets[s]
        width = tree.width[s]
        first = self.game.base[d][s] + tree.offset[node]
        own = self._strategy[first + bucket * width : first + bucket * width + n]
        if own.sum() > 0:
            self.stats["trained"] += 1
            return own / own.sum()
        rows = self._strategy[first + np.arange(buckets)[:, None] * width + np.arange(n)[None, :]]
        totals = rows.sum(axis=1)
        have = np.flatnonzero(totals > 0)
        if not len(have):
            self.stats["untrained_node"] += 1
            return None
        self.stats["borrowed"] += 1
        nearest = have[np.argmin(np.abs(have - bucket))]
        return rows[nearest] / totals[nearest]

    def act(self, view: SeatView, rng: random.Random) -> Action:
        legal = view.legal
        if legal is None:
            raise ValueError(f"S{view.seat} is not the seat to act")
        if len(view.seat_order) != 2:
            raise ValueError("the blueprint plays heads-up only")
        self.stats["decisions"] += 1
        self.last_probabilities = None
        hand = self._hand(view)
        node = self._position(view, hand, rng)
        passive = Action.check() if legal.can_check else Action.call()
        if node is None:
            self.stats["lost"] += 1
            return passive
        d = hand.d
        tree = self.game.trees[d]
        hole = view.hole_cards
        assert hole is not None
        bucket = self.tables.bucket(hole, view.board)
        probs = self._strategy_at(d, node, bucket)
        if probs is None:
            hand.tokens[len(view.actions)] = "k" if legal.can_check else "c"
            hand.seen = view.actions
            return passive
        self.last_probabilities = [float(p) for p in probs]
        x = rng.random()
        acc = 0.0
        choice = len(probs) - 1
        for i, p in enumerate(probs):
            acc += float(p)
            if x < acc:
                choice = i
                break
        token = tree.tokens[node][choice]
        hand.tokens[len(view.actions)] = token
        hand.seen = view.actions
        return self._real_action(view, tree, node, token)

    def _real_action(self, view: SeatView, tree: Tree, node: int, token: str) -> Action:
        """The engine action for an abstract choice, sized from the real pot and stacks."""
        legal = view.legal
        assert legal is not None
        options = abstract_actions(
            legal,
            street=view.street,
            level=street_level(view.actions, view.street),
            pot=view.pot,
            current_bet=view.current_bet,
            street_bets=view.street_bets,
        )
        for option in options:
            if option.token == token:
                return option.action
        if token in ("f", "k", "c"):
            return Action.check() if legal.can_check else (Action.fold() if token == "f" else Action.call())
        # The size does not exist at the real stacks: play the closest real size.
        self.stats["resized"] += 1
        want = tree.measure[node][tree.tokens[node].index(token)]
        owed = view.current_bet - view.street_bets[view.seat]
        raises = [o for o in options if o.action.amount is not None]
        if not raises or want is None:
            return Action.check() if legal.can_check else Action.call()
        return min(raises, key=lambda o: abs((o.action.amount - view.current_bet) / (view.pot + owed) - want)).action  # type: ignore[operator]


def coverage(stats: Counter[str]) -> dict[str, float | int]:
    decisions = stats["decisions"]
    out: dict[str, float | int] = dict(sorted(stats.items()))
    if decisions:
        out["trained_share"] = round(stats["trained"] / decisions, 4)
    return out


__all__: Sequence[str] = ["BlueprintPolicy", "coverage", "pseudo_harmonic"]
