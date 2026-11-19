"""Versioned JSON snapshots of whole tables (P3.5, D-4).

``table_to_dict`` captures everything a ``Table`` needs to carry on after a
restart: its configuration, every seated player, the hand in progress (or the
last one) as an engine state document, the turn clock and the event counter.
``table_from_dict`` rebuilds an identical table. Events, finished hands and
departures waiting to be drained are not part of a snapshot: they are
published, and stored, before the next snapshot is taken.

A snapshot holds every hole card and the deck, so it is as private as the
server. Turn times are seconds since the epoch, so a deadline saved before a
restart still means the same moment after it.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from typing import Any

from rivermind.engine.history import FormatError, state_from_dict, state_to_dict

from .table import Player, Table, TableConfig, Turn

FORMAT = 1
KIND = "table"

_CONFIG_FIELDS = (
    "seat_count",
    "small_blind",
    "big_blind",
    "ante",
    "min_buy_in",
    "max_buy_in",
    "action_seconds",
    "time_bank_seconds",
    "bank_refill_seconds",
)
_PLAYER_FIELDS = (
    "player_id",
    "name",
    "stack",
    "bot",
    "sitting_out",
    "sit_out_next",
    "leaving",
    "pending_rebuy",
    "time_bank",
    "connected",
    "absent_hands",
    "acted_this_hand",
    "timed_out_this_hand",
    "disconnected_this_hand",
)
_TURN_FIELDS = ("seat", "seq", "started", "deadline", "final")
_PLAYER_TYPES: dict[str, tuple[type, ...]] = {
    "player_id": (str,),
    "name": (str,),
    "stack": (int,),
    "bot": (str, type(None)),
    "pending_rebuy": (int,),
    "time_bank": (int, float),
    "absent_hands": (int,),
}


def _player(data: Mapping[str, Any]) -> Player:
    values = {name: data[name] for name in _PLAYER_FIELDS}
    for name, value in values.items():
        expected = _PLAYER_TYPES.get(name, (bool,))
        if isinstance(value, bool) and bool not in expected or not isinstance(value, expected):
            raise ValueError(f"player field {name} has the wrong type")
    if values["stack"] < 0 or values["pending_rebuy"] < 0:
        raise ValueError("a player cannot hold negative chips")
    return Player(**values)


def config_to_dict(config: TableConfig) -> dict[str, Any]:
    return {name: getattr(config, name) for name in _CONFIG_FIELDS}


def config_from_dict(data: Mapping[str, Any]) -> TableConfig:
    return TableConfig(**{name: data[name] for name in _CONFIG_FIELDS})


def table_to_dict(table: Table) -> dict[str, Any]:
    """A complete, versioned snapshot of ``table`` between changes."""
    if table.events or table.finished or table.departures:
        raise ValueError("drain a table's events, finished hands and departures before saving it")
    turn = table.turn
    return {
        "format": FORMAT,
        "kind": KIND,
        "config": config_to_dict(table.config),
        "seats": [
            None if player is None else {name: getattr(player, name) for name in _PLAYER_FIELDS}
            for player in table.seats
        ],
        "hand": None if table.hand is None else state_to_dict(table.hand),
        "hand_players": list(table.hand_players),
        "hand_no": table.hand_no,
        "button": table.button,
        "seq": table.seq,
        "turn": None if turn is None else {name: getattr(turn, name) for name in _TURN_FIELDS},
    }


def table_from_dict(data: Mapping[str, Any], clock: Callable[[], float] = time.time) -> Table:
    """Rebuild a table from ``table_to_dict``. Raises ``FormatError`` for a bad document."""
    if not isinstance(data, Mapping):
        raise FormatError("a table snapshot must be a JSON object")
    if data.get("format") != FORMAT:
        raise FormatError(f"unknown table snapshot format {data.get('format')!r}")
    if data.get("kind") != KIND:
        raise FormatError(f"expected a {KIND} document, got {data.get('kind')!r}")
    try:
        config = config_from_dict(data["config"])
        table = Table(config, clock)
        seats = data["seats"]
        if len(seats) != config.seat_count or len(data["hand_players"]) != config.seat_count:
            raise ValueError("the seat lists do not match the seat count")
        table.seats = [None if s is None else _player(s) for s in seats]
        table.hand = None if data["hand"] is None else state_from_dict(data["hand"])
        if table.hand is not None and table.hand.num_seats != config.seat_count:
            raise ValueError("the hand does not match the seat count")
        table.hand_players = list(data["hand_players"])
        table.hand_no = int(data["hand_no"])
        table.button = data["button"]
        table.seq = int(data["seq"])
        turn = data["turn"]
        table.turn = None if turn is None else Turn(**{name: turn[name] for name in _TURN_FIELDS})
    except (KeyError, TypeError, ValueError) as error:
        raise FormatError(f"bad table snapshot: {error}") from error
    return table


__all__ = ["FORMAT", "config_from_dict", "config_to_dict", "table_from_dict", "table_to_dict"]
