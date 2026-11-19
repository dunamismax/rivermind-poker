"""Versioned JSON for hand states and histories, replay and plain-text histories.

A *state* document is a complete snapshot of a ``HandState`` (for durable
tables, P3.5). A *history* document records only what is needed to replay a
hand: the stakes, starting stacks, button, deck order and actions. Replaying
it reproduces the identical final state. Both carry ``"format"`` (the version
of this layout) and ``"kind"``. Cards are written as text such as ``"As"``.

Both documents include every hole card and the deck, so they are private to
the server. ``format_text`` renders a readable history for a viewer and leaves
out the cards that viewer may not see.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .cards import card, card_str, pretty
from .evaluator import describe
from .pots import Pot
from .state import (
    Action,
    ActionKind,
    ActionRecord,
    HandConfig,
    HandResult,
    HandState,
    Post,
    PostKind,
    Street,
    apply,
    start_hand,
)

FORMAT = 1
STATE_KIND = "hand_state"
HISTORY_KIND = "hand_history"

_STREET_NAMES = ("preflop", "flop", "turn", "river")


class FormatError(ValueError):
    """A document has an unknown format, the wrong kind or bad contents."""


@dataclass(frozen=True, slots=True)
class HandHistory:
    """The inputs of a hand: enough to replay it exactly."""

    config: HandConfig
    starting_stacks: tuple[int | None, ...]
    button: int
    deck: tuple[int, ...]
    actions: tuple[Action, ...]


def history_of(state: HandState) -> HandHistory:
    """The history of the hand so far."""
    return HandHistory(
        config=state.config,
        starting_stacks=state.starting_stacks,
        button=state.button,
        deck=state.deck,
        actions=tuple(_as_action(record) for record in state.actions),
    )


def _as_action(record: ActionRecord) -> Action:
    if record.kind in (ActionKind.BET, ActionKind.RAISE):
        return Action(record.kind, record.to)
    return Action(record.kind)


def replay(history: HandHistory) -> HandState:
    """Replay a history from its first state."""
    state = start_hand(history.config, history.starting_stacks, history.button, deck=history.deck)
    for action in history.actions:
        state = apply(state, action)
    return state


# JSON documents


def _cards(cs: Sequence[int]) -> list[str]:
    return [card_str(c) for c in cs]


def _parse_cards(values: Sequence[str]) -> tuple[int, ...]:
    return tuple(card(v) for v in values)


def _config(config: HandConfig) -> dict[str, int]:
    return {"small_blind": config.small_blind, "big_blind": config.big_blind, "ante": config.ante}


def _parse_config(data: Mapping[str, Any]) -> HandConfig:
    return HandConfig(data["small_blind"], data["big_blind"], data.get("ante", 0))


def _action(action: Action) -> dict[str, Any]:
    doc: dict[str, Any] = {"action": action.kind.value}
    if action.amount is not None:
        doc["amount"] = action.amount
    return doc


def _check(data: Mapping[str, Any], kind: str) -> None:
    if not isinstance(data, Mapping):
        raise FormatError("a document must be a JSON object")
    if data.get("format") != FORMAT:
        raise FormatError(f"unsupported format {data.get('format')!r}; this engine reads format {FORMAT}")
    if data.get("kind") != kind:
        raise FormatError(f"expected a {kind} document, got {data.get('kind')!r}")


def history_to_dict(history: HandHistory) -> dict[str, Any]:
    """A history document. A finished hand also records its final stacks."""
    return {
        "format": FORMAT,
        "kind": HISTORY_KIND,
        "game": "no_limit_holdem",
        "config": _config(history.config),
        "starting_stacks": list(history.starting_stacks),
        "button": history.button,
        "deck": _cards(history.deck),
        "actions": [_action(a) for a in history.actions],
    }


def history_from_dict(data: Mapping[str, Any]) -> HandHistory:
    _check(data, HISTORY_KIND)
    try:
        return HandHistory(
            config=_parse_config(data["config"]),
            starting_stacks=tuple(data["starting_stacks"]),
            button=data["button"],
            deck=_parse_cards(data["deck"]),
            actions=tuple(
                Action(ActionKind(a["action"]), a.get("amount")) for a in data["actions"]
            ),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise FormatError(f"bad hand history: {error}") from error


def hand_record(state: HandState) -> dict[str, Any]:
    """A history document for a hand, with a summary used to check the replay."""
    doc = history_to_dict(history_of(state))
    if state.result is not None:
        doc["final_stacks"] = list(state.final_stacks)
        doc["board"] = _cards(state.board)
    return doc


def replay_record(data: Mapping[str, Any]) -> HandState:
    """Replay a history document and check it against its recorded summary."""
    state = replay(history_from_dict(data))
    if "final_stacks" in data and list(state.final_stacks) != list(data["final_stacks"]):
        raise FormatError("replay does not reproduce the recorded final stacks")
    if "board" in data and _cards(state.board) != list(data["board"]):
        raise FormatError("replay does not reproduce the recorded board")
    return state


def state_to_dict(state: HandState) -> dict[str, Any]:
    """A complete, versioned snapshot of a state."""
    return {
        "format": FORMAT,
        "kind": STATE_KIND,
        "game": "no_limit_holdem",
        "config": _config(state.config),
        "button": state.button,
        "small_blind_seat": state.small_blind_seat,
        "big_blind_seat": state.big_blind_seat,
        "starting_stacks": list(state.starting_stacks),
        "deck": _cards(state.deck),
        "dealt_in": list(state.dealt_in),
        "hole_cards": [None if h is None else _cards(h) for h in state.hole_cards],
        "stacks": list(state.stacks),
        "street_bets": list(state.street_bets),
        "contributions": list(state.contributions),
        "folded": list(state.folded),
        "acted_at": list(state.acted_at),
        "street": _STREET_NAMES[state.street],
        "board": _cards(state.board),
        "current_bet": state.current_bet,
        "min_raise": state.min_raise,
        "to_act": state.to_act,
        "posts": [
            {"seat": p.seat, "kind": p.kind.value, "amount": p.amount, "all_in": p.all_in}
            for p in state.posts
        ],
        "actions": [
            {
                "seat": r.seat,
                "street": _STREET_NAMES[r.street],
                "action": r.kind.value,
                "to": r.to,
                "added": r.added,
                "all_in": r.all_in,
            }
            for r in state.actions
        ],
        "result": None if state.result is None else _result(state.result),
    }


def _result(result: HandResult) -> dict[str, Any]:
    return {
        "uncalled": None if result.uncalled is None else list(result.uncalled),
        "pots": [
            {
                "amount": p.amount,
                "eligible": list(p.eligible),
                "winners": list(p.winners),
                "shares": list(p.shares),
            }
            for p in result.pots
        ],
        "showdown": result.showdown,
        "tabled": result.tabled,
        "shown": list(result.shown),
        "mucked": list(result.mucked),
        "hand_ranks": list(result.hand_ranks),
        "winnings": list(result.winnings),
    }


def state_from_dict(data: Mapping[str, Any]) -> HandState:
    _check(data, STATE_KIND)
    try:
        hole_cards: tuple[tuple[int, int] | None, ...] = tuple(
            None if h is None else (card(h[0]), card(h[1])) for h in data["hole_cards"]
        )
        result_data = data["result"]
        return HandState(
            config=_parse_config(data["config"]),
            button=data["button"],
            small_blind_seat=data["small_blind_seat"],
            big_blind_seat=data["big_blind_seat"],
            starting_stacks=tuple(data["starting_stacks"]),
            deck=_parse_cards(data["deck"]),
            dealt_in=tuple(data["dealt_in"]),
            hole_cards=hole_cards,
            stacks=tuple(data["stacks"]),
            street_bets=tuple(data["street_bets"]),
            contributions=tuple(data["contributions"]),
            folded=tuple(data["folded"]),
            acted_at=tuple(data["acted_at"]),
            street=Street(_STREET_NAMES.index(data["street"])),
            board=_parse_cards(data["board"]),
            current_bet=data["current_bet"],
            min_raise=data["min_raise"],
            to_act=data["to_act"],
            posts=tuple(
                Post(p["seat"], PostKind(p["kind"]), p["amount"], p["all_in"]) for p in data["posts"]
            ),
            actions=tuple(
                ActionRecord(
                    r["seat"],
                    Street(_STREET_NAMES.index(r["street"])),
                    ActionKind(r["action"]),
                    r["to"],
                    r["added"],
                    r["all_in"],
                )
                for r in data["actions"]
            ),
            result=None if result_data is None else _parse_result(result_data),
        )
    except (KeyError, TypeError, ValueError, IndexError) as error:
        raise FormatError(f"bad hand state: {error}") from error


def _parse_result(data: Mapping[str, Any]) -> HandResult:
    uncalled = data["uncalled"]
    return HandResult(
        uncalled=None if uncalled is None else (uncalled[0], uncalled[1]),
        pots=tuple(
            Pot(p["amount"], tuple(p["eligible"]), tuple(p["winners"]), tuple(p["shares"]))
            for p in data["pots"]
        ),
        showdown=data["showdown"],
        tabled=data["tabled"],
        shown=tuple(data["shown"]),
        mucked=tuple(data["mucked"]),
        hand_ranks=tuple(data["hand_ranks"]),
        winnings=tuple(data["winnings"]),
    )


def dumps(document: Mapping[str, Any]) -> str:
    """Compact, stable JSON text for a document."""
    return json.dumps(document, separators=(",", ":"), sort_keys=True)


def loads(text: str) -> dict[str, Any]:
    data = json.loads(text)
    if not isinstance(data, dict):
        raise FormatError("a document must be a JSON object")
    return data


# Plain-text histories


def _chips(amount: int) -> str:
    return f"{amount:,}"


def _hand(cs: Sequence[int]) -> str:
    return " ".join(pretty(c) for c in cs)


_POST_WORDS = {
    PostKind.ANTE: "the ante",
    PostKind.SMALL_BLIND: "the small blind",
    PostKind.BIG_BLIND: "the big blind",
}


def _action_text(record: ActionRecord) -> str:
    seat = f"S{record.seat}"
    if record.kind is ActionKind.FOLD:
        text = f"{seat} folds"
    elif record.kind is ActionKind.CHECK:
        text = f"{seat} checks"
    elif record.kind is ActionKind.CALL:
        text = f"{seat} calls {_chips(record.added)}"
    elif record.kind is ActionKind.BET:
        text = f"{seat} bets {_chips(record.to)}"
    else:
        text = f"{seat} raises to {_chips(record.to)}"
    return text + (" and is all-in" if record.all_in else "")


def _street_header(street: Street, board: Sequence[int]) -> str:
    if street is Street.FLOP:
        return f"*** Flop *** {_hand(board[:3])}"
    if street is Street.TURN:
        return f"*** Turn *** {_hand(board[:3])} · {pretty(board[3])}"
    return f"*** River *** {_hand(board[:4])} · {pretty(board[4])}"


def format_text(state: HandState, viewer: int | None = None) -> str:
    """A readable hand history.

    With ``viewer=None`` every hole card is shown, as the server sees the
    hand. With a seat number, only that seat's cards and the hands shown at
    showdown appear; mucked and folded hands stay hidden (rule 12.4).
    """
    config = state.config
    result = state.result
    shown = set(result.shown) if result else set()
    ante = f" · Ante {_chips(config.ante)}" if config.ante else ""
    lines = [
        f"RiverMind Poker · No-limit hold'em · {state.num_seats} seats · "
        f"Blinds {_chips(config.small_blind)}/{_chips(config.big_blind)}{ante}",
        f"Button S{state.button} · Small blind S{state.small_blind_seat} · Big blind S{state.big_blind_seat}",
    ]
    for seat, stack in enumerate(state.starting_stacks):
        if state.dealt_in[seat]:
            lines.append(f"S{seat}: {_chips(stack or 0)} chips")
    for post in state.posts:
        all_in = " and is all-in" if post.all_in else ""
        lines.append(f"S{post.seat} posts {_POST_WORDS[post.kind]} {_chips(post.amount)}{all_in}")

    def visible(seat: int) -> bool:
        return viewer is None or seat == viewer

    lines.append("*** Hole cards ***")
    for seat in state.seat_order:
        hole = state.hole_cards[seat]
        if hole is not None and visible(seat):
            lines.append(f"S{seat}: {_hand(hole)}")

    street = Street.PREFLOP
    lines.append("*** Pre-flop ***")
    tabled_at = None
    if result is not None and result.tabled:
        tabled_at = state.actions[-1].street if state.actions else Street.PREFLOP

    def table_hands() -> None:
        assert result is not None
        lines.append("*** All in: hands shown ***")
        for seat in result.shown:
            hole = state.hole_cards[seat]
            assert hole is not None
            lines.append(f"S{seat} shows {_hand(hole)}")

    for record in state.actions:
        while record.street > street:
            street = Street(street + 1)
            lines.append(_street_header(street, state.board))
        lines.append(_action_text(record))
    if result is not None:
        if tabled_at is not None:
            table_hands()
        while street < Street.RIVER and len(state.board) >= 3 + street:
            street = Street(street + 1)
            lines.append(_street_header(street, state.board))
        if result.showdown:
            lines.append("*** Showdown ***")
            for seat in (*result.shown, *result.mucked) if not result.tabled else result.shown:
                hole = state.hole_cards[seat]
                rank = result.hand_ranks[seat]
                assert hole is not None and rank is not None
                if seat in shown:
                    lines.append(f"S{seat} shows {_hand(hole)} ({describe(rank)})")
                elif visible(seat):
                    lines.append(f"S{seat} mucks {_hand(hole)}")
                else:
                    lines.append(f"S{seat} mucks")
        lines.append("*** Result ***")
        if result.uncalled is not None:
            seat, amount = result.uncalled
            lines.append(f"Uncalled bet of {_chips(amount)} returned to S{seat}")
        for i, pot in enumerate(result.pots):
            name = "Pot" if len(result.pots) == 1 else ("Main pot" if i == 0 else f"Side pot {i}")
            wins = ", ".join(f"S{s} wins {_chips(share)}" for s, share in zip(pot.winners, pot.shares))
            lines.append(f"{name} {_chips(pot.amount)}: {wins}")
        finals = " · ".join(
            f"S{seat} {_chips(stack)}" for seat, stack in enumerate(state.final_stacks) if stack is not None
        )
        lines.append(f"Final stacks: {finals}")
    else:
        lines.append(f"(in progress: S{state.to_act} to act, pot {_chips(state.pot)})")
    return "\n".join(lines) + "\n"
