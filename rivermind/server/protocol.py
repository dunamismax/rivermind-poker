"""The no-limit table protocol, version 2 (P3.4), as Pydantic models.

These models describe every HTTP body and WebSocket message of the table
server in `rivermind.server.app`. The server validates what clients send
with them and builds what it sends from them. ``rivermind-poker
protocol-schema --version 2`` exports their JSON Schema, and
`--typescript` writes the client's types (`web/src/lib/protocol-v2.ts`).
A test fails if the checked-in TypeScript is stale.

Lobby (P4.3). `GET /api/tables` lists the open public tables, with filters;
`POST /api/quick-seat` finds a seat or starts a table; `POST
/api/tables/{id}/seat` holds a seat and, with a buy-in, sits in it; a full
table has a waitlist (`/api/tables/{id}/waitlist`). A private table is not
listed: its invite code, from `GET /api/invites/{code}`, lets people join.

Flow. `POST /api/session` makes an anonymous player on the first visit, or
returns the one this browser already is, and sets the signed session cookie
(P4.1). The cookie authenticates `POST /api/tables` and the WebSocket, and
the server refuses both from pages on other origins. Every socket opens
with a `hello` message.
One socket can follow several tables: `join_table` subscribes to one and
sends its current `table` message. After every change at a table, each
subscribed socket receives a `table` message with that viewer's view and
the new public events, numbered by `seq` without gaps. Views and events
never contain another seat's hidden cards. An `act` carries the `seq` of
the view it answers; an action sent for an earlier turn is refused as
`stale`.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, StrictInt

PROTOCOL_VERSION = 2


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# Shared values


class Suit(StrEnum):
    SPADES = "spades"
    HEARTS = "hearts"
    DIAMONDS = "diamonds"
    CLUBS = "clubs"


class Card(_Model):
    rank: int = Field(ge=2, le=14, description="2 to 10, then 11 to 14 for J, Q, K, A.")
    suit: Suit


class Street(StrEnum):
    PRE_FLOP = "pre-flop"
    FLOP = "flop"
    TURN = "turn"
    RIVER = "river"


class ActionKind(StrEnum):
    FOLD = "fold"
    CHECK = "check"
    CALL = "call"
    BET = "bet"
    RAISE = "raise"


class RaiseKind(StrEnum):
    BET = "bet"
    RAISE = "raise"


class PostKind(StrEnum):
    ANTE = "ante"
    SMALL_BLIND = "small_blind"
    BIG_BLIND = "big_blind"


class SeatKind(StrEnum):
    HUMAN = "human"
    BOT = "bot"


class ErrorCode(StrEnum):
    """Stable codes clients branch on."""

    BAD_REQUEST = "bad_request"
    UNAUTHORIZED = "unauthorized"
    STALE = "stale"
    ILLEGAL_ACTION = "illegal_action"
    NOT_YOUR_TURN = "not_your_turn"
    HAND_OVER = "hand_over"
    HAND_IN_PROGRESS = "hand_in_progress"
    UNKNOWN_TABLE = "unknown_table"
    UNKNOWN_SEAT = "unknown_seat"
    SEAT_TAKEN = "seat_taken"
    ALREADY_SEATED = "already_seated"
    NOT_SEATED = "not_seated"
    BAD_BUY_IN = "bad_buy_in"
    NOT_SUBSCRIBED = "not_subscribed"
    INSUFFICIENT_CHIPS = "insufficient_chips"


class EventKind(StrEnum):
    """What a `TableEvent` reports. The fields it sets are listed per kind."""

    SEATED = "seated"
    """`seat`, `name`, `amount` (the buy-in)."""
    LEFT = "left"
    """`seat`, `amount` (chips taken away)."""
    LEAVING = "leaving"
    """`seat`: leaves when the hand ends, folding until then."""
    SAT_OUT = "sat_out"
    """`seat`, `reason` (`asked` or `away`)."""
    SITTING_OUT_NEXT = "sitting_out_next"
    SAT_IN = "sat_in"
    REBUY_PENDING = "rebuy_pending"
    """`seat`, `amount`: added when the hand ends."""
    REBOUGHT = "rebought"
    """`seat`, `amount`."""
    REBUY_DROPPED = "rebuy_dropped"
    """`seat`, `amount`: the waiting rebuy no longer fit and went back to the wallet."""
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    HAND_STARTED = "hand_started"
    """`hand_no`, `seat` (the button)."""
    TURN = "turn"
    """`seat`: whose turn it is; the view's `turn` has the clock."""
    TIMED_OUT = "timed_out"
    """`seat`: the clock ran out; an `action` event follows."""
    ACTION = "action"
    """`seat`, `action`, `amount` (the street total after it), `added`, `all_in`."""
    BOARD = "board"
    """`street`, `cards` (the new cards)."""
    HAND_ENDED = "hand_ended"
    """`hand_no`; the view's `hand.result` has the details."""
    RESERVED = "reserved"
    """`seat`, `name`: the seat is held for that player while they buy in."""
    RESERVATION_ENDED = "reservation_ended"
    """`seat`, `reason` (`expired`, `cancelled` or `moved`)."""
    WAITLIST = "waitlist"
    """`count`: how many players are waiting for a seat."""


class TableEvent(_Model):
    """A public change at a table."""

    seq: int = Field(ge=1, description="Increases by one per event at a table.")
    kind: EventKind
    seat: int | None = None
    name: str | None = None
    amount: int | None = None
    added: int | None = None
    all_in: bool | None = None
    action: ActionKind | None = None
    street: Street | None = None
    cards: list[Card] | None = None
    reason: str | None = None
    hand_no: int | None = None
    count: int | None = None


# The table view


class TableSettings(_Model):
    seat_count: int = Field(ge=2, le=9)
    small_blind: int
    big_blind: int
    ante: int
    min_buy_in: int
    max_buy_in: int
    action_seconds: float
    time_bank_seconds: float


class SeatInfo(_Model):
    """An occupied seat as the viewer may see it."""

    seat: int = Field(ge=0, le=8)
    name: str
    kind: SeatKind
    bot: str | None = Field(description="The bot kind for a bot seat (bots are always labelled).")
    stack: int = Field(description="Chips behind right now.")
    bet: int = Field(description="Chips put in on the current street.")
    in_hand: bool = Field(description="Dealt into the hand in progress and not folded.")
    folded: bool
    all_in: bool
    sitting_out: bool
    leaving: bool
    connected: bool
    has_cards: bool = Field(description="Holds cards in the hand in progress, shown or not.")
    cards: list[Card] | None = Field(
        description="The viewer's own cards, or cards shown at showdown; null when hidden."
    )


class Post(_Model):
    seat: int
    kind: PostKind
    amount: int
    all_in: bool


class ActionRecord(_Model):
    seat: int
    street: Street
    action: ActionKind
    to: int = Field(description="The seat's street total after the action.")
    added: int = Field(description="Chips the action put in.")
    all_in: bool


class PotResult(_Model):
    amount: int
    eligible: list[int]
    winners: list[int]
    shares: list[int] = Field(description="Chips each winner took, in the order of winners.")


class Uncalled(_Model):
    seat: int
    amount: int


class HandResult(_Model):
    pots: list[PotResult]
    uncalled: Uncalled | None = Field(description="An uncalled bet returned before the pots were formed.")
    showdown: bool = Field(description="False when everyone else folded.")
    shown: list[int] = Field(description="Seats whose cards were shown, in showing order.")
    mucked: list[int] = Field(description="Seats that mucked without showing.")
    winnings: list[int] = Field(description="Chips won from the pots per seat.")
    net: list[int] = Field(description="Chips won or lost in the hand per seat (0 for seats not dealt in).")


class HandInfo(_Model):
    """The current hand, or the last one until the next starts."""

    hand_no: int = Field(ge=1)
    button: int
    small_blind_seat: int
    big_blind_seat: int
    street: Street
    board: list[Card]
    pot: int = Field(description="Everything put in so far, including this street's bets.")
    current_bet: int
    to_act: int | None
    posts: list[Post]
    actions: list[ActionRecord]
    result: HandResult | None = Field(description="Set once the hand is over.")


class Turn(_Model):
    """The clock of the seat to act, in seconds since the epoch on the server."""

    seat: int
    seq: int = Field(description="The seq of this turn's event; an act must carry at least this.")
    started: float
    deadline: float = Field(description="When the action time runs out and the time bank starts.")
    final: float = Field(description="When the seat is timed out.")


class Legal(_Model):
    """What the viewer may do now (rule 7.7)."""

    can_fold: bool
    can_check: bool
    call: int = Field(description="Chips a call adds; 0 when there is nothing to call.")
    raise_kind: RaiseKind | None
    min_to: int = Field(description="Smallest bet or raise, as a street total.")
    max_to: int = Field(description="Largest bet or raise (all-in), as a street total.")


class SeatHold(_Model):
    """A seat held for a player while they buy in (rule 2.4)."""

    seat: int = Field(ge=0, le=8)
    name: str
    ready: bool = Field(description="False while a bot plays out the hand before giving up the seat.")
    until: float | None = Field(description="When the hold runs out; null until it is ready.")


class You(_Model):
    player_id: str
    seat: int | None = Field(description="The viewer's seat, or null when not seated.")
    hold: SeatHold | None = Field(description="The seat held for the viewer, if any.")
    waitlist_position: int | None = Field(description="The viewer's place on the waitlist, from 1.")
    legal: Legal | None = Field(description="Set when it is the viewer's turn.")
    time_bank: float | None
    pending_rebuy: int
    sitting_out: bool
    sitting_out_next: bool


class TableView(_Model):
    """Everything one player may see at a table."""

    table_id: str
    name: str
    seq: int = Field(ge=0, description="The seq of the last event at the table.")
    server_time: float = Field(description="The server's clock when the view was made, for the timers.")
    settings: TableSettings
    seats: list[SeatInfo | None] = Field(description="One entry per seat; null for an empty seat.")
    hand: HandInfo | None
    turn: Turn | None
    you: You
    private: bool
    invite: str | None = Field(description="A private table's invite code, for its people to share.")
    holds: list[SeatHold]
    waitlist: int = Field(description="Players waiting for a seat.")


# HTTP


class BotOption(_Model):
    kind: str
    label: str


class Stakes(_Model):
    small_blind: int
    big_blind: int


class ConfigResponse(_Model):
    """`GET /api/config`."""

    protocol: int
    bots: list[BotOption]
    seat_counts: list[int]
    stakes: list[Stakes]


class SessionRequest(_Model):
    """`POST /api/session`, with an optional body."""

    legacy_token: str | None = Field(
        default=None,
        max_length=200,
        description="The bearer token a Phase 3 client kept, to move that player onto a session cookie.",
    )


class SessionResponse(_Model):
    """`POST /api/session`: the player this browser is. The session itself is in an `HttpOnly` cookie."""

    player_id: str
    name: str
    created: bool = Field(description="Whether this request made a new player.")
    balance: int = Field(description="Play chips in the wallet, after any grant or top-up this visit paid.")


class LedgerKind(StrEnum):
    GRANT = "grant"
    TOP_UP = "top_up"
    BUY_IN = "buy_in"
    REBUY = "rebuy"
    CASH_OUT = "cash_out"
    REFUND = "refund"


class LedgerItem(_Model):
    """One change to the wallet."""

    kind: LedgerKind
    amount: int = Field(description="Positive for chips paid in, negative for chips paid out.")
    balance_after: int
    table_id: str | None
    at: float = Field(description="Seconds since the epoch.")


class WalletResponse(_Model):
    """`GET /api/wallet` with the session cookie: the balance and the newest entries first."""

    balance: int
    notice: str = Field(description="The play-money statement (D-1), to show with the chips.")
    entries: list[LedgerItem]


class NewTableRequest(_Model):
    """`POST /api/tables` with the session cookie. The player takes seat 0."""

    seats: StrictInt = Field(default=6, ge=2, le=9)
    bots: str | None = Field(
        default="heuristic",
        description="The kind of bot in every other seat, which gives up its seat when a person wants it; "
        "null leaves the seats for people.",
    )
    big_blind: StrictInt = Field(default=100, description="One of the config's stakes.")
    buy_in: StrictInt | None = Field(default=None, description="Defaults to as much of the maximum as the wallet holds.")
    private: bool = Field(default=False, description="Unlisted; people join with the invite code.")


class NewTableResponse(_Model):
    """`POST /api/tables`, status 201."""

    table_id: str
    seat: int
    invite: str | None = Field(default=None, description="A private table's invite code.")


class TableSummary(_Model):
    """A table as the lobby lists it."""

    table_id: str
    name: str
    seat_count: int
    small_blind: int
    big_blind: int
    min_buy_in: int
    max_buy_in: int
    private: bool
    people: int = Field(description="People seated.")
    bots: int = Field(description="Bots seated.")
    free_seats: int = Field(description="Empty seats nobody holds.")
    bot_seats: int = Field(description="Bots' seats a person can claim; the bot leaves when its hand ends.")
    holds: int = Field(description="Seats held for players buying in.")
    waitlist: int
    hand_no: int = Field(description="Hands dealt so far.")
    seated: bool = Field(description="Whether the viewer has a seat here.")
    hold: SeatHold | None = Field(description="The seat held for the viewer here, if any.")
    waitlist_position: int | None = Field(description="The viewer's place on the waitlist here, from 1.")


class TableListResponse(_Model):
    """`GET /api/tables`, with optional filters `seats`, `big_blind` and `open` (only tables with a seat to take).

    Public tables, and private ones the viewer is at, most people first.
    """

    tables: list[TableSummary]


class SeatRequest(_Model):
    """`POST /api/tables/{table_id}/seat`: hold a seat and, unless `hold_only`, buy in and sit in it."""

    seat: StrictInt | None = Field(default=None, description="A seat to take; by default the server picks one.")
    buy_in: StrictInt | None = Field(default=None, description="Defaults to as much of the maximum as the wallet holds.")
    hold_only: bool = Field(default=False, description="Only hold the seat, to buy in later with a `sit` message.")
    invite: str | None = Field(default=None, max_length=100, description="Needed for a private table.")


class SeatResponse(_Model):
    """`POST /api/tables/{table_id}/seat` and `POST /api/quick-seat`."""

    table_id: str
    seat: int
    seated: bool = Field(description="True when the player now sits at the table.")
    hold: SeatHold | None = Field(
        description="When not seated: the held seat. Sit in it with a `sit` message once it is ready."
    )


class WaitlistRequest(_Model):
    """`POST /api/tables/{table_id}/waitlist`: wait for a seat at a full table."""

    invite: str | None = Field(default=None, max_length=100, description="Needed for a private table.")


class WaitlistResponse(_Model):
    table_id: str
    position: int = Field(description="The player's place in line, from 1.")


class QuickSeatRequest(_Model):
    """`POST /api/quick-seat`: a seat at the busiest matching public table, or a new table with bots."""

    seats: StrictInt | None = Field(default=None, ge=2, le=9)
    big_blind: StrictInt | None = None
    buy_in: StrictInt | None = Field(default=None, description="Defaults to as much of the maximum as the wallet holds.")


class HttpError(_Model):
    """Any HTTP error response."""

    detail: str


# WebSocket, client to server


class HelloMessage(_Model):
    """Must be the first message on a socket."""

    type: Literal["hello"]
    protocol: Literal[2]


class JoinTableMessage(_Model):
    """Follow a table. Rejoining after a reconnect is the same message."""

    type: Literal["join_table"]
    table_id: str


class LeaveTableMessage(_Model):
    """Stop following a table and give up the seat (at the end of the hand if in one)."""

    type: Literal["leave_table"]
    table_id: str


class SitMessage(_Model):
    type: Literal["sit"]
    table_id: str
    seat: StrictInt
    buy_in: StrictInt


class SitOutMessage(_Model):
    type: Literal["sit_out"]
    table_id: str


class SitInMessage(_Model):
    type: Literal["sit_in"]
    table_id: str


class RebuyMessage(_Model):
    type: Literal["rebuy"]
    table_id: str
    amount: StrictInt


class ActMessage(_Model):
    type: Literal["act"]
    table_id: str
    seq: StrictInt = Field(description="The seq of the view acted on.")
    action: ActionKind
    amount: StrictInt | None = Field(default=None, description="The street total, for a bet or raise only.")


class RefreshMessage(_Model):
    type: Literal["refresh"]
    table_id: str


class ClientMessage(
    RootModel[
        Annotated[
            JoinTableMessage
            | LeaveTableMessage
            | SitMessage
            | SitOutMessage
            | SitInMessage
            | RebuyMessage
            | ActMessage
            | RefreshMessage,
            Field(discriminator="type"),
        ]
    ]
):
    """Any message after the hello."""


# WebSocket, server to client


class WelcomeMessage(_Model):
    type: Literal["welcome"]
    protocol: int
    player_id: str
    name: str


class TableMessage(_Model):
    """A table's view after a change, with the events since the last one sent."""

    type: Literal["table"]
    table_id: str
    view: TableView
    events: list[TableEvent]


class LeftTableMessage(_Model):
    type: Literal["left_table"]
    table_id: str


class TableClosedMessage(_Model):
    type: Literal["table_closed"]
    table_id: str
    message: str


class ErrorMessage(_Model):
    """A refused message. The table and the view are unchanged."""

    type: Literal["error"]
    code: ErrorCode
    message: str
    table_id: str | None


class ServerMessage(
    RootModel[
        Annotated[
            WelcomeMessage | TableMessage | LeftTableMessage | TableClosedMessage | ErrorMessage,
            Field(discriminator="type"),
        ]
    ]
):
    """Any message the server sends."""


MODELS: list[type[BaseModel]] = [
    ConfigResponse,
    SessionRequest,
    SessionResponse,
    WalletResponse,
    NewTableRequest,
    NewTableResponse,
    TableListResponse,
    TableSummary,
    SeatRequest,
    SeatResponse,
    WaitlistRequest,
    WaitlistResponse,
    QuickSeatRequest,
    HttpError,
    HelloMessage,
    ClientMessage,
    ServerMessage,
]


def json_schema() -> dict[str, Any]:
    """One JSON Schema document with every protocol type under `$defs`."""
    from pydantic.json_schema import models_json_schema

    _, schema = models_json_schema(
        [(model, "validation") for model in MODELS],
        title="RiverMind Poker no-limit table protocol",
        description=f"Protocol version {PROTOCOL_VERSION}.",
    )
    for model in MODELS:
        definition = schema["$defs"][model.__name__]
        if model.__doc__ and "description" not in definition:
            definition["description"] = model.__doc__.strip()
    schema["$defs"] = dict(sorted(schema["$defs"].items()))
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", **schema}
