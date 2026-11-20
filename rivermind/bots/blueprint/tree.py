"""Abstract betting trees compiled from the engine (P5.3, ``docs/bots.md``).

Every node is reached by playing abstract actions through ``start_hand``,
``legal_actions`` and ``apply``, so the tree's amounts and turn order are
exactly the engine's. Seat 0 is the button, who posts the small blind and
acts first before the flop. The cards do not change the betting, so the tree
is built on a fixed deck; only terminal amounts are kept from the result.

Decision nodes are numbered depth-first, children in action order, and each
gets an offset within its street: a node with *n* actions owns *n*
consecutive slots, and a street's width is the total of its nodes' actions.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from functools import cached_property

from rivermind.engine import HandConfig, HandState, Street, apply, legal_actions, start_hand

from .abstraction import NAME, STREET_LETTERS, abstract_actions, street_level

SMALL_BLIND = 50
BIG_BLIND = 100
DEPTHS = (50, 100)
"""The depth classes in big blinds."""

FOLD = 0
SHOWDOWN = 1


@dataclass(frozen=True)
class Tree:
    """One depth class's compiled tree, as flat lists for a fast trainer.

    ``children[v][i]`` is a node number, or ``~t`` (negative) for terminal
    ``t``. A fold terminal's ``terminal_value`` is what seat 0 wins or loses;
    a showdown's is the chips each player has in the pot, won by the better
    hand.
    """

    abstraction: str
    depth: int
    """Stacks in big blinds."""
    small_blind: int
    big_blind: int
    player: list[int]
    street: list[int]
    offset: list[int]
    history: list[str]
    tokens: list[tuple[str, ...]]
    children: list[tuple[int, ...]]
    terminal_kind: list[int]
    terminal_value: list[int]
    width: tuple[int, int, int, int]
    """Slots per bucket on each street."""
    measure: list[tuple[float | None, ...]] = field(default_factory=list, compare=False)
    """Each action's size as (raise-to − current bet) / called pot, ``None`` for fold, check and call (for mapping; not hashed)."""
    spr: list[float] = field(default_factory=list, compare=False)
    """The effective stack behind over the pot at each node (for re-entering the tree; not hashed)."""
    _index: dict[str, int] = field(default_factory=dict, repr=False, compare=False)

    @property
    def stack(self) -> int:
        return self.depth * self.big_blind

    def __len__(self) -> int:
        return len(self.player)

    def nodes_on(self, street: int) -> int:
        return sum(1 for s in self.street if s == street)

    def street_starts(self, street: int) -> list[int]:
        """Nodes with no action yet on their street, after the pre-flop root."""
        return [v for v in range(len(self)) if self.street[v] == street and (self.history[v] == "" or self.history[v].endswith("/"))]

    def node(self, history: str) -> int:
        """The decision node with this history (such as ``r0c/kb1c/k``)."""
        if not self._index:
            self._index.update((h, v) for v, h in enumerate(self.history))
        try:
            return self._index[history]
        except KeyError:
            raise KeyError(f"no decision node has history {history!r}") from None

    @cached_property
    def sha256(self) -> str:
        """Hash of every node's history, player, street, offset, actions and children, and every terminal."""
        body = {
            "abstraction": self.abstraction,
            "depth": self.depth,
            "blinds": [self.small_blind, self.big_blind],
            "nodes": [
                [h, p, s, o, list(t), list(c)]
                for h, p, s, o, t, c in zip(
                    self.history, self.player, self.street, self.offset, self.tokens, self.children
                )
            ],
            "terminals": [[k, v] for k, v in zip(self.terminal_kind, self.terminal_value)],
        }
        return hashlib.sha256(json.dumps(body, separators=(",", ":")).encode()).hexdigest()

    def summary(self) -> dict[str, object]:
        return {
            "depth": self.depth,
            "decision_nodes": len(self),
            "nodes_per_street": [self.nodes_on(s) for s in range(4)],
            "width": list(self.width),
            "terminals": len(self.terminal_kind),
            "sha256": self.sha256,
        }


def start_state(depth: int) -> HandState:
    stack = depth * BIG_BLIND
    return start_hand(HandConfig(SMALL_BLIND, BIG_BLIND), [stack, stack], 0, deck=list(range(52)))


def compile_tree(depth: int) -> Tree:
    """Build the ``hu-m1`` tree for stacks of ``depth`` big blinds."""
    player: list[int] = []
    street: list[int] = []
    offset: list[int] = []
    history: list[str] = []
    tokens: list[tuple[str, ...]] = []
    children: list[tuple[int, ...]] = []
    terminal_kind: list[int] = []
    terminal_value: list[int] = []
    measure: list[tuple[float | None, ...]] = []
    spr: list[float] = []
    width = [0, 0, 0, 0]

    def terminal(state: HandState) -> int:
        result = state.result
        assert result is not None
        c0, c1 = state.contributions
        if result.showdown:
            assert c0 == c1, "heads-up showdowns have matched contributions"
            terminal_kind.append(SHOWDOWN)
            terminal_value.append(c0)
        else:
            terminal_kind.append(FOLD)
            terminal_value.append(c1 if state.folded[1] else -c0)
        return ~(len(terminal_kind) - 1)

    def visit(state: HandState, past: str) -> int:
        if state.is_over:
            return terminal(state)
        legal = legal_actions(state)
        s = state.street
        actions = abstract_actions(
            legal,
            street=s,
            level=street_level(state.actions, s),
            pot=state.pot,
            current_bet=state.current_bet,
            street_bets=state.street_bets,
        )
        v = len(player)
        player.append(legal.seat)
        street.append(int(s))
        offset.append(width[s])
        width[s] += len(actions)
        history.append(past)
        tokens.append(tuple(a.token for a in actions))
        children.append(())
        owed = state.current_bet - state.street_bets[legal.seat]
        measure.append(
            tuple(
                None if a.action.amount is None else (a.action.amount - state.current_bet) / (state.pot + owed)
                for a in actions
            )
        )
        spr.append(min(state.stacks) / state.pot)
        found = []
        for a in actions:
            child = apply(state, a.action)
            step = a.token
            if not child.is_over and child.street != s:
                step += "/" * (child.street - s)
            found.append(visit(child, past + step))
        children[v] = tuple(found)
        return v

    visit(start_state(depth), "")
    return Tree(
        abstraction=NAME,
        depth=depth,
        small_blind=SMALL_BLIND,
        big_blind=BIG_BLIND,
        player=player,
        street=street,
        offset=offset,
        history=history,
        tokens=tokens,
        children=children,
        terminal_kind=terminal_kind,
        terminal_value=terminal_value,
        width=(width[0], width[1], width[2], width[3]),
        measure=measure,
        spr=spr,
    )


def info_set_key(tree: Tree, node: int, bucket: int) -> str:
    """The text form ``<abstraction>|<depth>|<street>|<bucket>|<history>``."""
    return f"{tree.abstraction}|{tree.depth}|{STREET_LETTERS[tree.street[node]]}|{bucket}|{tree.history[node]}"
