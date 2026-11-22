"""Difficulty levels (P5.7): RiverMind Medium, a format's champion mixed with RiverMind Easy.

Medium plays each hand as one bot or the other: at its first decision in a
hand it draws once from the generator it is given, and plays the whole hand
as the champion when the draw is below ``share`` and as RiverMind Easy (the
heuristic) otherwise. A hand is never split between them, so every line it
plays is one that one of the two bots would play.

Because neither bot adapts to its opponent and each hand is decided before
it starts, Medium's expected win rate against any opponent is the same mix
of the two bots' win rates: at ``share`` one half, halfway between them.
Its own published evaluation measures it rather than relying on that.

A hand is told from the next as ``BlueprintPolicy`` tells them: by the seat,
its cards, the blinds, the starting stacks and the button, and by whether
the actions seen so far still begin the actions of the view. The
TypeScript port in ``web/src/lib/server/bots/levels.ts`` follows it draw for
draw.
"""

from __future__ import annotations

import random
from collections import Counter, OrderedDict
from dataclasses import dataclass

from rivermind.engine import Action, ActionRecord
from rivermind.engine.view import SeatView

from .policies import HeuristicPolicy, Policy

MEDIUM = "medium"
MEDIUM_SHARE = 0.5
"""The share of hands Medium plays as the champion."""
MEMORY = 64
"""Hands remembered at once; a table has one in progress per seat."""


@dataclass
class _Choice:
    strong: bool
    seen: tuple[ActionRecord, ...] = ()


class MixedPolicy:
    """Plays each hand as ``strong`` with probability ``share``, otherwise as ``weak``."""

    def __init__(self, strong: Policy, weak: Policy | None = None, share: float = MEDIUM_SHARE, *, name: str = MEDIUM) -> None:
        if not 0 <= share <= 1:
            raise ValueError("share must be between 0 and 1")
        self.name = name
        self.strong = strong
        self.weak = weak if weak is not None else HeuristicPolicy()
        self.share = share
        self.hands: Counter[str] = Counter()
        """Hands played as each bot: ``strong`` and ``weak``."""
        self.last_strong: bool | None = None
        """Whether the last decision was the strong bot's."""
        self._hands: OrderedDict[tuple[object, ...], _Choice] = OrderedDict()

    @property
    def stats(self) -> Counter[str]:
        """The strong bot's decision statistics, with the hands played as each bot (``hands_strong``, ``hands_weak``)."""
        out: Counter[str] = Counter(getattr(self.strong, "stats", None) or {})
        for kind, count in self.hands.items():
            out[f"hands_{kind}"] = count
        return out

    def new_hand(self) -> None:
        self._hands.clear()
        for policy in (self.strong, self.weak):
            reset = getattr(policy, "new_hand", None)
            if reset is not None:
                reset()

    def _choice(self, view: SeatView, rng: random.Random) -> _Choice:
        key = (
            view.seat,
            view.hole_cards,
            view.posts,
            tuple((view.stacks[s] or 0) + view.contributions[s] for s in range(view.num_seats)),
            view.button,
        )
        choice = self._hands.get(key)
        if choice is None or view.actions[: len(choice.seen)] != choice.seen:
            choice = _Choice(strong=rng.random() < self.share)
            self.hands["strong" if choice.strong else "weak"] += 1
            self._hands[key] = choice
            while len(self._hands) > MEMORY:
                self._hands.popitem(last=False)
        else:
            self._hands.move_to_end(key)
        choice.seen = view.actions
        return choice

    def act(self, view: SeatView, rng: random.Random) -> Action:
        if view.legal is None:
            raise ValueError(f"S{view.seat} is not the seat to act")
        choice = self._choice(view, rng)
        self.last_strong = choice.strong
        return (self.strong if choice.strong else self.weak).act(view, rng)


def medium(champion: Policy) -> MixedPolicy:
    """RiverMind Medium for a champion: half its hands as the champion, half as RiverMind Easy."""
    return MixedPolicy(champion, HeuristicPolicy(), MEDIUM_SHARE, name=MEDIUM)
