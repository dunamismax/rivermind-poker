"""Abstract betting trees compiled from the engine (P5.3 and P5.6, ``docs/bots.md``).

Every node is reached by playing abstract actions through ``start_hand``,
``legal_actions`` and ``apply``, so the tree's amounts and turn order are
exactly the engine's. Seat 0 is the button. Heads-up it posts the small
blind and acts first before the flop; at a bigger table seat 1 posts the
small blind, seat 2 the big blind and seat 3 acts first. The cards do not
change the betting, so the tree is built on a fixed deck; only terminal
amounts are kept from the result.

Decision nodes are numbered depth-first, children in action order, and each
gets an offset within its street: a node with *n* actions owns *n*
consecutive slots, and a street's width is the total of its nodes' actions.

A **merged** abstraction (``6max-s1``) compiles a graph, not a tree: two
histories that leave the same players in with the same chips, bets and
rights to act are one node, numbered where the depth-first walk first
meets it. That is what makes six seats small enough to train; the bot no
longer tells such histories apart.
"""

from __future__ import annotations

import hashlib
import json
import os
import pickle
import re
import sys
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

from rivermind.engine import HandConfig, HandState, Street, apply, legal_actions, start_hand

from .abstraction import HU_M1, NAME, STREET_LETTERS, Abstraction, abstract_actions, street_level

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
    seats: int = 2
    merged: bool = False
    # The rest is filled for trees of more than two seats and for merged ones, whose
    # terminals are (kind, what each remaining seat has in, the pot, the remaining seats).
    contribution: list[int] = field(default_factory=list, compare=False)
    """What the seat to act has put in at each node: what folding there loses."""
    folds: list[bool] = field(default_factory=list, compare=False)
    """Whether each node's first action is a fold."""
    live: list[int] = field(default_factory=list, compare=False)
    """The seats still in at each node, as a bit mask."""
    terminal_pot: list[int] = field(default_factory=list, compare=False)
    terminal_live: list[tuple[int, ...]] = field(default_factory=list, compare=False)
    starts: tuple[tuple[int, ...], ...] = field(default=(), compare=False)
    """The nodes that open each street."""
    parent: list[int] = field(default_factory=list, repr=False, compare=False)
    """The node the walk first reached each node from, and by which action: one history of it (not hashed)."""
    parent_action: list[int] = field(default_factory=list, repr=False, compare=False)

    @property
    def stack(self) -> int:
        return self.depth * self.big_blind

    @property
    def multiway(self) -> bool:
        """Whether this tree was compiled with the fields a table of more than two, or a merged graph, needs."""
        return bool(self.contribution)

    def __len__(self) -> int:
        return len(self.player)

    @cached_property
    def _nodes_per_street(self) -> tuple[int, int, int, int]:
        counts = [0, 0, 0, 0]
        for s in self.street:
            counts[s] += 1
        return (counts[0], counts[1], counts[2], counts[3])

    def nodes_on(self, street: int) -> int:
        return self._nodes_per_street[street]

    def street_starts(self, street: int) -> list[int]:
        """Nodes with no action yet on their street, after the pre-flop root."""
        if self.multiway:
            return list(self.starts[street])
        return [v for v in range(len(self)) if self.street[v] == street and (self.history[v] == "" or self.history[v].endswith("/"))]

    def history_of(self, node: int) -> str:
        """A node's history. A merged node has several; this is the one the walk met first."""
        if self.history:
            return self.history[node]
        steps = []
        v = node
        while v != 0:
            p = self.parent[v]
            step = self.tokens[p][self.parent_action[v]]
            if self.street[v] != self.street[p]:
                step += "/" * (self.street[v] - self.street[p])
            steps.append(step)
            v = p
        return "".join(reversed(steps))

    def node(self, history: str) -> int:
        """The decision node with this history (such as ``r0c/kb1c/k``)."""
        if self.multiway:
            v = 0
            for token in _TOKEN.findall(history.replace("/", "")):
                if v < 0 or token not in self.tokens[v]:
                    raise KeyError(f"no decision node has history {history!r}")
                v = self.children[v][self.tokens[v].index(token)]
            if v < 0 or "".join(_TOKEN.findall(history)) != history.replace("/", ""):
                raise KeyError(f"no decision node has history {history!r}")
            return v
        if not self._index:
            self._index.update((h, v) for v, h in enumerate(self.history))
        try:
            return self._index[history]
        except KeyError:
            raise KeyError(f"no decision node has history {history!r}") from None

    @cached_property
    def sha256(self) -> str:
        """Hash of every node's history, player, street, offset, actions and children, and every terminal.

        A multiway tree hashes each node's contribution and remaining seats
        in place of its history, and each terminal's pot and remaining seats.
        """
        if self.multiway:
            digest = hashlib.sha256()
            head = {
                "abstraction": self.abstraction,
                "depth": self.depth,
                "blinds": [self.small_blind, self.big_blind],
                "seats": self.seats,
                "merged": self.merged,
                "width": list(self.width),
            }
            digest.update(json.dumps(head, separators=(",", ":")).encode())
            for row in zip(self.player, self.street, self.offset, self.tokens, self.children, self.contribution, self.live):
                digest.update(json.dumps(row, separators=(",", ":")).encode())
            for row in zip(self.terminal_kind, self.terminal_value, self.terminal_pot, self.terminal_live):
                digest.update(json.dumps(row, separators=(",", ":")).encode())
            return digest.hexdigest()
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

    def slim(self) -> Tree:
        """A copy holding only what the trainer's walk reads, for worker processes."""
        import dataclasses

        other = dataclasses.replace(self, history=[], tokens=[], measure=[], spr=[], parent=[], parent_action=[], live=[], _index={})
        other.__dict__["sha256"] = self.sha256
        other.__dict__["_nodes_per_street"] = self._nodes_per_street
        return other


_TOKEN = re.compile(r"[fkca]|[br]\d+")


def start_state(depth: int, seats: int = 2) -> HandState:
    stack = depth * BIG_BLIND
    return start_hand(HandConfig(SMALL_BLIND, BIG_BLIND), [stack] * seats, 0, deck=list(range(52)))


def compile_tree(depth: int, abstraction: Abstraction = HU_M1) -> Tree:
    """Build an abstraction's tree for stacks of ``depth`` big blinds.

    A merged abstraction's graph takes the engine tens of seconds to walk,
    so it is kept in a cache file (``tree_cache``) named after everything
    it depends on, and read from there when it exists.
    """
    if abstraction is HU_M1:
        return _compile_heads_up(depth)
    path = tree_cache(depth, abstraction)
    if path is not None and path.exists():
        try:
            with path.open("rb") as f:
                tree = pickle.load(f)  # our own file, named by a hash of the code that wrote it
            if isinstance(tree, Tree) and tree.depth == depth and tree.abstraction == abstraction.name:
                return tree
        except Exception:  # a damaged cache file is rebuilt
            pass
    tree = _compile_multiway(depth, abstraction)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        with tmp.open("wb") as f:
            pickle.dump(tree, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, path)
    return tree


def tree_cache(depth: int, abstraction: Abstraction) -> Path | None:
    """Where a compiled multiway tree is cached, or ``None`` with ``RIVERMIND_TREE_CACHE`` set empty.

    The name carries a hash of the abstraction, this module, the abstraction
    module and the engine's source, so a change to any of them compiles
    again. The default directory is ``artifacts/trees`` beside the package.
    """
    root = os.environ.get("RIVERMIND_TREE_CACHE")
    if root == "":
        return None
    here = Path(__file__).resolve()
    base = Path(root) if root else here.parents[3] / "artifacts" / "trees"
    digest = hashlib.sha256()
    digest.update(repr((abstraction.name, abstraction.seats, abstraction.preflop, sorted(abstraction.postflop.items()), abstraction.merged, depth)).encode())
    for source in (here, here.with_name("abstraction.py"), *sorted((here.parents[2] / "engine").glob("*.py"))):
        digest.update(source.name.encode() + b"\0" + source.read_bytes() + b"\0")
    return base / f"{abstraction.name}-{depth}-{digest.hexdigest()[:16]}.pickle"


def _merge_key(state: HandState, level: int) -> tuple[object, ...]:
    """Everything that decides a betting state's actions and what follows them.

    Seats that have folded count only through what they left in the pot.
    ``acted_at`` and ``min_raise`` carry the engine's rights to raise
    (rules 7.4 and 8.1), and ``other`` is the bet a raise is judged against.
    """
    seat = state.to_act
    live = tuple(i for i, folded in enumerate(state.folded) if not folded)
    return (
        int(state.street),
        seat,
        live,
        tuple(state.contributions[i] for i in live),
        state.pot,
        tuple(state.street_bets[i] for i in live),
        tuple(state.acted_at[i] for i in live),
        state.current_bet,
        state.min_raise,
        max(b for i, b in enumerate(state.street_bets) if i != seat),
        level,
    )


def _compile_multiway(depth: int, abstraction: Abstraction) -> Tree:
    """Build a tree for any number of seats, merging equal betting states when the abstraction says so."""
    seats = abstraction.seats
    player: list[int] = []
    street: list[int] = []
    offset: list[int] = []
    tokens: list[tuple[str, ...]] = []
    children: list[tuple[int, ...]] = []
    contribution: list[int] = []
    folds: list[bool] = []
    live_mask: list[int] = []
    measure: list[tuple[float | None, ...]] = []
    spr: list[float] = []
    parent: list[int] = []
    parent_action: list[int] = []
    starts: list[list[int]] = [[], [], [], []]
    terminal_kind: list[int] = []
    terminal_value: list[int] = []
    terminal_pot: list[int] = []
    terminal_live: list[tuple[int, ...]] = []
    width = [0, 0, 0, 0]
    nodes: dict[tuple[object, ...], int] = {}
    terminals: dict[tuple[object, ...], int] = {}
    shared: dict[tuple[object, ...], tuple[object, ...]] = {}

    def terminal(state: HandState) -> int:
        result = state.result
        assert result is not None
        live = tuple(i for i, folded in enumerate(state.folded) if not folded)
        each = state.contributions[live[0]]
        if result.showdown:
            assert all(state.contributions[i] == each for i in live), "equal stacks leave one pot at a showdown"
        else:
            assert len(live) == 1
        key = (result.showdown, live, each, state.pot)
        t = terminals.get(key)
        if t is None:
            t = terminals[key] = len(terminal_kind)
            terminal_kind.append(SHOWDOWN if result.showdown else FOLD)
            terminal_value.append(each)
            terminal_pot.append(state.pot)
            terminal_live.append(live)
        return ~t

    def visit(state: HandState, came_from: int, by: int, opens: bool) -> int:
        if state.is_over:
            return terminal(state)
        s = state.street
        level = street_level(state.actions, s)
        key: tuple[object, ...] | None = None
        if abstraction.merged:
            key = _merge_key(state, level)
            found = nodes.get(key)
            if found is not None:
                return found
        legal = legal_actions(state)
        seat = legal.seat
        actions = abstract_actions(
            legal,
            street=s,
            level=level,
            pot=state.pot,
            current_bet=state.current_bet,
            street_bets=state.street_bets,
            abstraction=abstraction,
        )
        v = len(player)
        if key is not None:
            nodes[key] = v
        player.append(seat)
        street.append(int(s))
        offset.append(width[s])
        width[s] += len(actions)
        names = tuple(a.token for a in actions)
        tokens.append(shared.setdefault(names, names))  # type: ignore[arg-type]
        children.append(())
        contribution.append(state.contributions[seat])
        folds.append(names[0] == "f")
        live_mask.append(sum(1 << i for i, folded in enumerate(state.folded) if not folded))
        owed = state.current_bet - state.street_bets[seat]
        sizes = tuple(None if a.action.amount is None else (a.action.amount - state.current_bet) / (state.pot + owed) for a in actions)
        measure.append(shared.setdefault(sizes, sizes))  # type: ignore[arg-type]
        spr.append(state.stacks[seat] / state.pot)
        parent.append(came_from)
        parent_action.append(by)
        if opens:
            starts[s].append(v)
        found_children = []
        for i, a in enumerate(actions):
            child = apply(state, a.action)
            found_children.append(visit(child, v, i, child.street != s))
        children[v] = tuple(found_children)
        return v

    limit = sys.getrecursionlimit()
    sys.setrecursionlimit(max(limit, 10_000))
    try:
        visit(start_state(depth, seats), 0, 0, True)
    finally:
        sys.setrecursionlimit(limit)
    return Tree(
        abstraction=abstraction.name,
        depth=depth,
        small_blind=SMALL_BLIND,
        big_blind=BIG_BLIND,
        player=player,
        street=street,
        offset=offset,
        history=[],
        tokens=tokens,
        children=children,
        terminal_kind=terminal_kind,
        terminal_value=terminal_value,
        width=(width[0], width[1], width[2], width[3]),
        measure=measure,
        spr=spr,
        seats=seats,
        merged=abstraction.merged,
        contribution=contribution,
        folds=folds,
        live=live_mask,
        terminal_pot=terminal_pot,
        terminal_live=terminal_live,
        starts=(tuple(starts[0]), tuple(starts[1]), tuple(starts[2]), tuple(starts[3])),
        parent=parent,
        parent_action=parent_action,
    )


def _compile_heads_up(depth: int) -> Tree:
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
    return f"{tree.abstraction}|{tree.depth}|{STREET_LETTERS[tree.street[node]]}|{bucket}|{tree.history_of(node)}"
