"""Helpers for engine tests: arranged deals and compact action scripts.

A script is a space-separated list of ``S<seat>:<action>`` tokens, such as
``"S5:r300 S0:c S1:f"``. Actions are ``f`` (fold), ``k`` (check), ``c``
(call), ``b<total>`` (bet), ``r<total>`` (raise) and ``a`` (all-in: the
largest bet or raise, or a call when no raise is allowed). Each token also
asserts that its seat is the one to act.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from rivermind.engine import (
    Action,
    ActionKind,
    HandConfig,
    HandState,
    apply,
    build_deck,
    cards,
    deal_order,
    legal_actions,
    seats_dealt_in,
    start_hand,
)
from rivermind.engine.cards import FULL_DECK

BLINDS = HandConfig(50, 100)


def deal(
    stacks: Sequence[int | None],
    button: int,
    holes: Mapping[int, str] | None = None,
    board: str = "",
    config: HandConfig = BLINDS,
) -> HandState:
    """Start a hand whose hole cards and board are given as text."""
    order = deal_order(button, seats_dealt_in(stacks), len(stacks))
    given = {seat: cards(text) for seat, text in (holes or {}).items()}
    board_cards = cards(board) if board else ()
    used = {c for hole in given.values() for c in hole} | set(board_cards)
    spare = iter(c for c in FULL_DECK if c not in used)
    hole_list = [given.get(seat) or (next(spare), next(spare)) for seat in order]
    deck = build_deck(hole_list, board_cards)
    return start_hand(config, stacks, button, deck=deck)


def parse_action(state: HandState, token: str) -> Action:
    legal = legal_actions(state)
    code, amount = token[0], token[1:]
    if code == "f":
        return Action.fold()
    if code == "k":
        return Action.check()
    if code == "c":
        return Action.call()
    if code == "b":
        return Action.bet(int(amount))
    if code == "r":
        return Action.raise_to(int(amount))
    if code == "a":
        if legal.raise_kind is not None:
            return Action(legal.raise_kind, legal.max_to)
        return Action.call()
    raise ValueError(f"unknown action code in {token!r}")


def play(state: HandState, script: str) -> HandState:
    """Apply a script, checking the seat to act before each action."""
    for token in script.split():
        seat_text, _, action_text = token.partition(":")
        seat = int(seat_text.removeprefix("S"))
        assert state.to_act == seat, f"expected S{seat} to act at {token!r}, but it is {state.to_act}"
        state = apply(state, parse_action(state, action_text))
    return state


def check_down(state: HandState) -> HandState:
    """Check (or call) until the hand ends."""
    while not state.is_over:
        legal = legal_actions(state)
        state = apply(state, Action.check() if legal.can_check else Action.call())
    return state


def acting_order(state: HandState, kind: ActionKind = ActionKind.CALL) -> list[int]:
    """Seats to act on the current street if everyone checks or calls."""
    seats = []
    street = state.street
    while not state.is_over and state.street == street:
        seats.append(state.to_act)
        legal = legal_actions(state)
        state = apply(state, Action.check() if legal.can_check else Action(kind))
    return seats
