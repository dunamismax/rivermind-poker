"""Simple bots: random, calling station and a tight-aggressive heuristic."""

from __future__ import annotations

import math
import random
from functools import lru_cache
from typing import Protocol

from rivermind.engine.cards import rank, suit
from rivermind.engine.evaluator import evaluate
from rivermind.engine.state import Action, ActionKind, LegalActions, Street
from rivermind.engine.view import SeatView


class Policy(Protocol):
    name: str

    def act(self, view: SeatView, rng: random.Random) -> Action:
        """Choose a legal action for ``view.seat``, which must be the seat to act."""
        ...


def _legal(view: SeatView) -> LegalActions:
    if view.legal is None:
        raise ValueError(f"S{view.seat} is not the seat to act")
    return view.legal


def _passive(legal: LegalActions) -> Action:
    return Action.check() if legal.can_check else Action.call()


class RandomPolicy:
    """Picks uniformly among fold, check or call, and bet or raise, then a uniform size.

    It never folds when it could check.
    """

    name = "random"

    def act(self, view: SeatView, rng: random.Random) -> Action:
        legal = _legal(view)
        kinds: list[str] = ["passive"]
        if legal.can_fold:
            kinds.append("fold")
        if legal.raise_kind is not None:
            kinds.append("raise")
        kind = rng.choice(kinds)
        if kind == "fold":
            return Action.fold()
        if kind == "raise":
            assert legal.raise_kind is not None
            return Action(legal.raise_kind, rng.randint(legal.min_to, legal.max_to))
        return _passive(legal)


class CallingStationPolicy:
    """Checks when it can and calls otherwise. It never folds or raises."""

    name = "calling_station"

    def act(self, view: SeatView, rng: random.Random) -> Action:
        return _passive(_legal(view))


# Hand strength


def chen_score(hole: tuple[int, int]) -> int:
    """Bill Chen's pre-flop score, from -1 (7-2 offsuit) to 20 (aces)."""
    high, low = sorted((rank(hole[0]), rank(hole[1])), reverse=True)
    value = {12: 10.0, 11: 8.0, 10: 7.0, 9: 6.0}.get(high, (high + 2) / 2)
    if high == low:
        return max(5, math.ceil(value * 2))
    if suit(hole[0]) == suit(hole[1]):
        value += 2
    gap = high - low - 1
    value -= (0, 1, 2, 4)[gap] if gap < 4 else 5
    if gap <= 1 and high < 10:
        value += 1
    return math.ceil(value)


def hand_strength(hole: tuple[int, int], board: tuple[int, ...]) -> float:
    """Share of possible opponent hands that this hand beats now, ties counting half.

    This is the classic hand-strength measure (Billings et al.): it enumerates
    every two-card holding the opponent could have on this board.
    """
    return _hand_strength(tuple(sorted(hole)), tuple(sorted(board)))


@lru_cache(maxsize=4096)
def _hand_strength(hole: tuple[int, ...], board: tuple[int, ...]) -> float:
    mine = evaluate(hole + board)
    seen = set(hole) | set(board)
    rest = [c for c in range(52) if c not in seen]
    wins = ties = total = 0
    for i, a in enumerate(rest):
        for b in rest[i + 1 :]:
            theirs = evaluate((a, b) + board)
            total += 1
            if mine < theirs:
                wins += 1
            elif mine == theirs:
                ties += 1
    return (wins + ties / 2) / total


class HeuristicPolicy:
    """A rule-based tight-aggressive bot: the "easy" bot and an evaluation opponent.

    Pre-flop it opens and re-raises by Chen score, with looser openings in
    late position, and folds the rest. After the flop it uses hand strength
    against each opponent still in: it bets strong hands for value, raises
    very strong ones, calls when its strength beats the pot odds by a margin,
    and otherwise checks or folds. It is deterministic; ``rng`` is unused.
    """

    name = "heuristic"

    def act(self, view: SeatView, rng: random.Random) -> Action:
        legal = _legal(view)
        hole = view.hole_cards
        assert hole is not None
        if view.street is Street.PREFLOP:
            return self._preflop(view, legal, chen_score(hole))
        strength = hand_strength(hole, view.board) ** max(1, len(view.opponents))
        return self._postflop(view, legal, strength)

    @staticmethod
    def _raise_to(legal: LegalActions, target: int) -> Action:
        assert legal.raise_kind is not None
        return Action(legal.raise_kind, min(max(legal.min_to, target), legal.max_to))

    def _preflop(self, view: SeatView, legal: LegalActions, score: int) -> Action:
        big = view.config.big_blind
        raises = sum(1 for a in view.street_actions if a.kind in (ActionKind.BET, ActionKind.RAISE))
        can_raise = legal.raise_kind is not None
        if raises == 0:
            limpers = sum(1 for a in view.street_actions if a.kind is ActionKind.CALL)
            order = view.seat_order
            behind = len(order) - 1 - order.index(view.seat) if view.seat in order else 0
            if view.seat == view.big_blind_seat:
                need = 9
            elif behind <= 2 or view.seat == view.small_blind_seat:
                need = 8
            elif behind <= 4:
                need = 9
            else:
                need = 10
            if score >= need and can_raise:
                return self._raise_to(legal, int(2.5 * big) + limpers * big)
            return _passive(legal) if legal.can_check else Action.fold()
        call_share = legal.call / max(1, view.stack)
        if raises == 1:
            if score >= 12 and can_raise:
                return self._raise_to(legal, 3 * view.current_bet)
            if score >= 10 and call_share <= 0.15:
                return Action.call()
        else:
            if score >= 14 and can_raise:
                return self._raise_to(legal, legal.max_to)
            if score >= 12 and call_share <= 0.3:
                return Action.call()
        return _passive(legal) if legal.can_check else Action.fold()

    def _postflop(self, view: SeatView, legal: LegalActions, strength: float) -> Action:
        pot = view.pot
        can_raise = legal.raise_kind is not None
        if legal.can_check:
            if strength >= 0.6 and can_raise:
                return self._raise_to(legal, (2 * pot) // 3 if strength < 0.85 else pot)
            return Action.check()
        odds = legal.call / (pot + legal.call)
        if strength >= 0.9 and can_raise:
            return self._raise_to(legal, view.current_bet + pot + legal.call)
        if strength >= odds + 0.15:
            return Action.call()
        return Action.fold()
