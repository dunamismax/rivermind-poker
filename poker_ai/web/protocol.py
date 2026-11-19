"""The browser table's wire protocol, as Pydantic models.

These models describe every HTTP body and every WebSocket message in both
directions. The server validates what clients send with them and builds
what it sends from them, so the JSON Schema they export is exact.
`rivermind-poker protocol-schema` prints that schema, and with
`--typescript` writes the client's types (`web/src/lib/protocol.ts`) from
it. A test fails if the checked-in TypeScript is stale.

WebSocket flow: the client's first message is `JoinMessage`. After that it
sends `ClientMessage`s, and the server answers every change with a
`ViewMessage` for each connected seat, or an `ErrorMessage` to the sender.
Phase 3 moves this module into `rivermind/server`.
"""
from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, RootModel, StrictInt

PROTOCOL_VERSION = 1


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# Shared values ------------------------------------------------------------------


class Suit(StrEnum):
    SPADES = "spades"
    HEARTS = "hearts"
    DIAMONDS = "diamonds"
    CLUBS = "clubs"


class Stage(StrEnum):
    """Betting stage. `show_down` and `terminal` both mean the hand is over."""

    PRE_FLOP = "pre_flop"
    FLOP = "flop"
    TURN = "turn"
    RIVER = "river"
    SHOW_DOWN = "show_down"
    TERMINAL = "terminal"


class Position(StrEnum):
    SMALL_BLIND = "small_blind"
    BIG_BLIND = "big_blind"
    BUTTON = "button"


class Action(StrEnum):
    """`call` with nothing to call is a check; `raise` with nothing to call is a bet."""

    FOLD = "fold"
    CALL = "call"
    RAISE = "raise"


class SeatKind(StrEnum):
    HUMAN = "human"
    BOT = "bot"


class OpponentKind(StrEnum):
    RANDOM = "random"
    CHECKPOINT = "checkpoint"


class ErrorCode(StrEnum):
    """Stable codes clients branch on."""

    BAD_REQUEST = "bad_request"
    STALE = "stale"
    ILLEGAL_ACTION = "illegal_action"
    NOT_YOUR_TURN = "not_your_turn"
    HAND_OVER = "hand_over"
    HAND_IN_PROGRESS = "hand_in_progress"
    UNKNOWN_TABLE = "unknown_table"
    UNKNOWN_SEAT = "unknown_seat"


class Card(_Model):
    rank: int = Field(ge=2, le=14, description="2 to 10, then 11 to 14 for J, Q, K, A.")
    suit: Suit


# The seat view ----------------------------------------------------------------------


class SeatState(_Model):
    """One seat as the viewing player may see it."""

    seat: int = Field(ge=0)
    name: str
    kind: SeatKind
    position: Position
    stack: int = Field(description="Chips behind.")
    bet: int = Field(description="Chips put in on the current street.")
    folded: bool
    is_turn: bool
    balance: int = Field(description="Net play chips won or lost this session.")
    cards: Optional[List[Card]] = Field(
        description="The viewer's own cards, or a seat's cards revealed at "
                    "showdown; null when hidden.")


class TableEvent(_Model):
    """One applied action, in order."""

    seat: int = Field(ge=0)
    action: Action
    stage: Stage = Field(description="The street the action was taken on.")
    chips: int = Field(description="Chips the action put in.")
    facing: int = Field(description="Chips the seat needed to call before acting.")


class HandResult(_Model):
    payouts: Dict[int, int] = Field(
        description="Net chips won (positive) or lost per seat, keyed by seat index.")
    showdown: bool = Field(description="False when everyone else folded.")


class SeatView(_Model):
    """Everything one seat may see. Never contains another seat's hidden cards."""

    hand: int = Field(ge=1, description="Hand number at this table, from 1.")
    seq: int = Field(ge=0, description="Changes with every action; send it back to act.")
    seat: int = Field(ge=0, description="The viewer's seat index.")
    stage: Stage
    board: List[Card]
    pot: int
    seats: List[SeatState]
    your_turn: bool
    legal_actions: List[Action] = Field(description="Empty unless it is your turn.")
    action_amounts: Dict[Action, int] = Field(
        description="Chips each legal action would add; empty unless it is your turn.")
    events: List[TableEvent]
    result: Optional[HandResult] = Field(description="Set once the hand is over.")


# HTTP -------------------------------------------------------------------------------


class ConfigResponse(_Model):
    """`GET /api/config`."""

    opponents: List[OpponentKind] = Field(description="Opponent kinds this server offers.")


class NewTableRequest(_Model):
    """`POST /api/tables`."""

    opponents: str = Field(default="random", description="One of the config's opponents.")


class NewTableResponse(_Model):
    """`POST /api/tables`, status 201. Keep the token secret: it is the seat."""

    table_id: str
    token: str


class HttpError(_Model):
    """Any HTTP error response."""

    detail: str


# WebSocket, client to server ----------------------------------------------------------


class JoinMessage(_Model):
    """Must be the first message on a socket. Rejoining uses the same token."""

    type: Literal["join"]
    table_id: str
    token: str


class ActMessage(_Model):
    type: Literal["act"]
    action: str = Field(
        description="One of the view's legal_actions; anything else is illegal_action.")
    seq: StrictInt = Field(description="The seq of the view acted on.")


class NextHandMessage(_Model):
    type: Literal["next_hand"]
    seq: StrictInt


class RefreshMessage(_Model):
    type: Literal["refresh"]


class ClientMessage(RootModel[Annotated[
    Union[ActMessage, NextHandMessage, RefreshMessage], Field(discriminator="type")
]]):
    """Any message after the join."""


# WebSocket, server to client ----------------------------------------------------------


class ViewMessage(_Model):
    type: Literal["view"]
    view: SeatView


class ErrorMessage(_Model):
    """A rejected message. `view` is the unchanged current view when there is one."""

    type: Literal["error"]
    code: ErrorCode
    message: str
    view: Optional[SeatView]


class ServerMessage(RootModel[Annotated[
    Union[ViewMessage, ErrorMessage], Field(discriminator="type")
]]):
    """Any message the server sends."""


MODELS = [
    ConfigResponse, NewTableRequest, NewTableResponse, HttpError,
    JoinMessage, ClientMessage, ServerMessage,
]


def json_schema() -> Dict[str, Any]:
    """One JSON Schema document with every protocol type under `$defs`."""
    from pydantic.json_schema import models_json_schema

    _, schema = models_json_schema(
        [(model, "validation") for model in MODELS],
        title="RiverMind Poker table protocol",
        description=f"Protocol version {PROTOCOL_VERSION}.",
    )
    for model in MODELS:  # roots come out unnamed; keep their docs
        definition = schema["$defs"][model.__name__]
        if model.__doc__ and "description" not in definition:
            definition["description"] = model.__doc__.strip()
    schema["$defs"] = dict(sorted(schema["$defs"].items()))
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", **schema}
