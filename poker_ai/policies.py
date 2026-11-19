"""Bot decision policies shared by every client.

A policy sees a `SeatView`: what the acting seat may know (its own hole
cards, the public board, betting history, stacks, pot and legal actions)
and never the opponents' cards or the deck. Clients build the view with
`seat_view(state)` and apply the returned action to their own state.
"""
from __future__ import annotations

import os
import random
from dataclasses import dataclass
from typing import Dict, Mapping, Optional, Protocol, Tuple, Union

import joblib

from poker_ai.games.short_deck.state import ShortDeckPokerState
from poker_ai.poker.card import Card

Strategy = Mapping[str, Mapping[str, float]]


@dataclass(frozen=True)
class SeatView:
    """Information available to the seat whose turn it is."""

    seat: int
    hole_cards: Tuple[Card, ...]
    community_cards: Tuple[Card, ...]
    betting_stage: str
    history: Tuple[Tuple[str, Tuple[str, ...]], ...]
    legal_actions: Tuple[str, ...]
    pot: int
    stacks: Tuple[int, ...]
    bets: Tuple[int, ...]
    # Checkpoint key (card bucket plus history); None without card tables.
    info_set: Optional[str] = None


def seat_view(state: ShortDeckPokerState) -> SeatView:
    """Build the acting seat's view of a non-terminal state."""
    if state.is_terminal:
        raise ValueError("No seat acts in a terminal state.")
    player = state.current_player
    return SeatView(
        seat=state.player_i,
        hole_cards=tuple(player.cards),
        community_cards=tuple(state.community_cards),
        betting_stage=state.betting_stage,
        history=tuple(
            (stage, tuple(str(action) for action in actions))
            for stage, actions in state._history.items()
        ),
        legal_actions=tuple(state.legal_actions),
        pot=state._table.pot.total,
        stacks=tuple(p.n_chips for p in state.players),
        bets=tuple(p.n_bet_chips for p in state.players),
        info_set=state.info_set if state.card_info_lut else None,
    )


class Policy(Protocol):
    """Choose one of `view.legal_actions`."""

    name: str

    def choose(self, view: SeatView) -> str:
        ...


class RandomPolicy:
    """Pick uniformly among the legal actions."""

    name = "random"

    def __init__(self, rng: Optional[random.Random] = None):
        self._rng = rng or random.Random()

    def action_probabilities(self, view: SeatView) -> Dict[str, float]:
        p = 1 / len(view.legal_actions)
        return {action: p for action in view.legal_actions}

    def choose(self, view: SeatView) -> str:
        return self._rng.choice(view.legal_actions)


class CheckpointPolicy:
    """
    Sample from a trained checkpoint's accumulated strategy.

    Weights for the seat's information set are restricted to the legal
    actions and normalised. An information set missing from the checkpoint,
    or one with no positive weight on a legal action, falls back to the
    uniform legal policy.
    """

    def __init__(
        self,
        strategy: Strategy,
        rng: Optional[random.Random] = None,
        name: str = "offline",
    ):
        self._strategy = strategy
        self._rng = rng or random.Random()
        self.name = name

    @classmethod
    def from_checkpoint(
        cls, path: Union[str, os.PathLike], rng: Optional[random.Random] = None
    ) -> CheckpointPolicy:
        """Load `agent.joblib` (trusted files only: joblib uses pickle)."""
        return cls(joblib.load(path)["strategy"], rng=rng)

    def has_info_set(self, view: SeatView) -> bool:
        return view.info_set is not None and view.info_set in self._strategy

    def action_probabilities(self, view: SeatView) -> Dict[str, float]:
        if view.info_set is None:
            raise ValueError(
                "Checkpoint play needs card tables to compute the info set."
            )
        weights = self._strategy.get(view.info_set, {})
        legal = {
            action: max(float(weights.get(action, 0.0)), 0.0)
            for action in view.legal_actions
        }
        total = sum(legal.values())
        if total <= 0:
            p = 1 / len(view.legal_actions)
            return {action: p for action in view.legal_actions}
        return {action: weight / total for action, weight in legal.items()}

    def choose(self, view: SeatView) -> str:
        probabilities = self.action_probabilities(view)
        actions = list(probabilities)
        return self._rng.choices(actions, weights=list(probabilities.values()))[0]
