"""A no-limit cash table: seats, buy-ins and hands on the Phase 2 engine (P3.2).

``Table`` is synchronous and deterministic. It owns the seats and the hand in
progress, applies every change and records each one as a public ``Event``
with a sequence number. It never sleeps, never decides for bots and takes
randomness only from its caller, so tests drive it directly. ``TableRunner``
(``runner.py``) runs a table as an asyncio task, asks bots for decisions and
starts hands automatically.

Seating follows ``docs/rules.md``:

- A player is dealt in when seated, not sitting out and holding chips
  (rule 2.1). A hand can start whenever at least two players are dealt in.
- A player who sits down or comes back is dealt in from the next hand, with
  no missed-blind charges (rule 2.2).
- Leaving or sitting out takes effect between hands. A player who leaves
  during a hand they are in folds when their turn comes, and their seat
  frees up when the hand ends (rule 2.3).
- The button moves as rule 5.2 says (``seating.next_button``).

Buy-ins and rebuys keep a stack between the table's minimum and maximum
buy-in. A rebuy asked for during a hand the player is in is added when the
hand ends. Chips are play money only (D-1); the wallet arrives in P4.2.
"""

from __future__ import annotations

import random
from collections.abc import Iterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from rivermind.engine import (
    Action,
    HandConfig,
    HandState,
    IllegalActionError,
    apply,
    card_str,
    initial_button,
    legal_actions,
    next_button,
    start_hand,
    timeout_action,
)
from rivermind.engine.view import SeatView, seat_view

DEFAULT_MIN_BUY_IN_BB = 40
DEFAULT_MAX_BUY_IN_BB = 100


class ErrorCode(StrEnum):
    """Why a table refused a request. Clients branch on these codes."""

    BAD_REQUEST = "bad_request"
    UNKNOWN_SEAT = "unknown_seat"
    SEAT_TAKEN = "seat_taken"
    ALREADY_SEATED = "already_seated"
    NOT_SEATED = "not_seated"
    BAD_BUY_IN = "bad_buy_in"
    NOT_YOUR_TURN = "not_your_turn"
    ILLEGAL_ACTION = "illegal_action"
    HAND_OVER = "hand_over"
    HAND_IN_PROGRESS = "hand_in_progress"


class TableError(Exception):
    """A request the table refused. The table is unchanged."""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class TableConfig:
    """A table's stakes and size. Buy-ins default to 40 and 100 big blinds."""

    seat_count: int
    small_blind: int
    big_blind: int
    ante: int = 0
    min_buy_in: int = 0
    max_buy_in: int = 0

    def __post_init__(self) -> None:
        if type(self.seat_count) is not int or not 2 <= self.seat_count <= 9:
            raise ValueError("a table has 2 to 9 seats")
        hand = HandConfig(self.small_blind, self.big_blind, self.ante)  # validates the stakes
        if not self.min_buy_in:
            object.__setattr__(self, "min_buy_in", DEFAULT_MIN_BUY_IN_BB * hand.big_blind)
        if not self.max_buy_in:
            object.__setattr__(self, "max_buy_in", DEFAULT_MAX_BUY_IN_BB * hand.big_blind)
        for name in ("min_buy_in", "max_buy_in"):
            if type(getattr(self, name)) is not int:
                raise TypeError(f"{name} must be an int")
        if not 0 < self.min_buy_in <= self.max_buy_in:
            raise ValueError("buy-ins must satisfy 0 < minimum <= maximum")

    @property
    def hand_config(self) -> HandConfig:
        return HandConfig(self.small_blind, self.big_blind, self.ante)


@dataclass(slots=True)
class Player:
    """Someone in a seat. ``stack`` is the stack between hands.

    During a hand the engine state holds the live stack; ``Table.stack_of``
    gives the current one either way.
    """

    player_id: str
    name: str
    stack: int
    bot: str | None = None
    """The bot kind for a bot seat, ``None`` for a person (D-7)."""
    sitting_out: bool = False
    sit_out_next: bool = False
    """Sit out when the current hand ends."""
    leaving: bool = False
    """Leave when the current hand ends, folding at every turn until then."""
    pending_rebuy: int = 0
    """Chips to add when the current hand ends."""

    @property
    def is_bot(self) -> bool:
        return self.bot is not None


@dataclass(frozen=True, slots=True)
class Event:
    """A public change at the table. ``seq`` increases by one per event."""

    seq: int
    kind: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Departure:
    """A player who left, with the chips they took with them."""

    player_id: str
    seat: int
    chips: int


class Table:
    """One cash table. Every method either applies a whole change or raises ``TableError``."""

    def __init__(self, config: TableConfig) -> None:
        self.config = config
        self.seats: list[Player | None] = [None] * config.seat_count
        self.hand: HandState | None = None
        """The current hand, or the last one once it is over, until the next starts."""
        self.hand_no = 0
        self.button: int | None = None
        """The button seat of the last hand dealt."""
        self.seq = 0
        self.events: list[Event] = []
        """Events not yet taken with ``drain_events``."""
        self.finished: list[tuple[int, HandState]] = []
        """Finished hands (hand number, final state) not yet taken with ``drain_finished``."""
        self.departures: list[Departure] = []
        """Players who left, not yet taken with ``drain_departures``."""

    # Reading the table

    @property
    def hand_in_progress(self) -> bool:
        return self.hand is not None and not self.hand.is_over

    def players(self) -> Iterator[tuple[int, Player]]:
        for seat, player in enumerate(self.seats):
            if player is not None:
                yield seat, player

    def seat_of(self, player_id: str) -> int | None:
        for seat, player in self.players():
            if player.player_id == player_id:
                return seat
        return None

    def in_hand(self, seat: int) -> bool:
        """Whether ``seat`` was dealt into the hand in progress."""
        hand = self.hand
        return hand is not None and not hand.is_over and hand.dealt_in[seat]

    def stack_of(self, seat: int) -> int:
        """The seat's chips behind right now, including during a hand."""
        player = self.seats[seat]
        if player is None:
            raise TableError(ErrorCode.UNKNOWN_SEAT, f"S{seat} is empty")
        if self.in_hand(seat):
            assert self.hand is not None
            return self.hand.stacks[seat]
        return player.stack

    def dealt_in_next(self) -> list[int]:
        """Seats that would be dealt into a hand started now (rule 2.1)."""
        return [
            seat
            for seat, player in self.players()
            if not player.sitting_out and not player.leaving and player.stack > 0
        ]

    def can_start(self) -> bool:
        return not self.hand_in_progress and len(self.dealt_in_next()) >= 2

    @property
    def to_act(self) -> int | None:
        return self.hand.to_act if self.hand_in_progress and self.hand is not None else None

    def view(self, seat: int) -> SeatView | None:
        """The engine's private view of the current or last hand for ``seat``."""
        if self.hand is None:
            return None
        return seat_view(self.hand, seat)

    # Seating

    def _seated(self, player_id: str) -> tuple[int, Player]:
        seat = self.seat_of(player_id)
        if seat is None:
            raise TableError(ErrorCode.NOT_SEATED, f"{player_id} is not seated here")
        player = self.seats[seat]
        assert player is not None
        return seat, player

    def sit(self, seat: int, player_id: str, name: str, buy_in: int, *, bot: str | None = None) -> None:
        """Seat a player with a buy-in. They are dealt in from the next hand."""
        if type(seat) is not int or not 0 <= seat < self.config.seat_count:
            raise TableError(ErrorCode.UNKNOWN_SEAT, f"there is no seat {seat!r}")
        if not player_id or not name:
            raise TableError(ErrorCode.BAD_REQUEST, "a player needs an id and a name")
        if self.seat_of(player_id) is not None:
            raise TableError(ErrorCode.ALREADY_SEATED, f"{player_id} already has a seat here")
        if self.seats[seat] is not None:
            raise TableError(ErrorCode.SEAT_TAKEN, f"S{seat} is taken")
        self._check_buy_in(buy_in, 0)
        self.seats[seat] = Player(player_id, name, buy_in, bot=bot)
        self._emit("seated", seat=seat, name=name, bot=bot, stack=buy_in)

    def _check_buy_in(self, amount: int, stack: int) -> None:
        low, high = self.config.min_buy_in, self.config.max_buy_in
        if type(amount) is not int or amount <= 0:
            raise TableError(ErrorCode.BAD_BUY_IN, "a buy-in is a positive whole number of chips")
        if not low <= stack + amount <= high:
            raise TableError(
                ErrorCode.BAD_BUY_IN,
                f"the stack after buying in must be {low} to {high} chips; it would be {stack + amount}",
            )

    def leave(self, player_id: str) -> Departure | None:
        """Leave now, or when the current hand ends if the player is in it.

        Returns the departure when the seat is freed at once, otherwise ``None``.
        """
        seat, player = self._seated(player_id)
        if not self.in_hand(seat):
            return self._remove(seat)
        if not player.leaving:
            player.leaving = True
            self._emit("leaving", seat=seat)
            self._fold_absent()
        return None

    def sit_out(self, player_id: str) -> None:
        """Sit out now, or when the current hand ends if the player is in it."""
        seat, player = self._seated(player_id)
        if player.sitting_out or player.sit_out_next:
            return
        if self.in_hand(seat):
            player.sit_out_next = True
            self._emit("sitting_out_next", seat=seat)
        else:
            player.sitting_out = True
            self._emit("sat_out", seat=seat)

    def sit_in(self, player_id: str) -> None:
        """Come back from sitting out; dealt in from the next hand (rule 2.2)."""
        seat, player = self._seated(player_id)
        if player.leaving:
            raise TableError(ErrorCode.BAD_REQUEST, "a player who is leaving cannot sit in")
        if not (player.sitting_out or player.sit_out_next):
            return
        player.sitting_out = False
        player.sit_out_next = False
        self._emit("sat_in", seat=seat)

    def rebuy(self, player_id: str, amount: int) -> None:
        """Add chips, keeping the stack within the buy-in range.

        During a hand the player is in, the chips are added when it ends.
        """
        seat, player = self._seated(player_id)
        if player.leaving:
            raise TableError(ErrorCode.BAD_REQUEST, "a player who is leaving cannot rebuy")
        if self.in_hand(seat):
            # The stack at the end of the hand is not known yet. Check against
            # the chips behind now, and fit the rebuy to the range when it is added.
            assert self.hand is not None
            if type(amount) is not int or amount <= 0:
                raise TableError(ErrorCode.BAD_BUY_IN, "a rebuy is a positive whole number of chips")
            if player.pending_rebuy + amount + self.hand.stacks[seat] > self.config.max_buy_in:
                raise TableError(
                    ErrorCode.BAD_BUY_IN, f"the stack after a rebuy must be at most {self.config.max_buy_in} chips"
                )
            player.pending_rebuy += amount
            self._emit("rebuy_pending", seat=seat, amount=amount)
            return
        self._check_buy_in(amount, player.stack)
        player.stack += amount
        self._emit("rebought", seat=seat, amount=amount, stack=player.stack)

    def _remove(self, seat: int) -> Departure:
        player = self.seats[seat]
        assert player is not None
        self.seats[seat] = None
        departure = Departure(player.player_id, seat, player.stack)
        self.departures.append(departure)
        self._emit("left", seat=seat, stack=player.stack)
        return departure

    # Hands

    def start_hand(self, rng: random.Random) -> HandState:
        """Deal the next hand. ``rng`` shuffles and, for the first hand, picks the button."""
        if self.hand_in_progress:
            raise TableError(ErrorCode.HAND_IN_PROGRESS, "a hand is already in progress")
        dealt = self.dealt_in_next()
        if len(dealt) < 2:
            raise TableError(ErrorCode.BAD_REQUEST, "a hand needs at least two players dealt in")
        stacks: list[int | None] = [None] * self.config.seat_count
        for seat in dealt:
            player = self.seats[seat]
            assert player is not None
            stacks[seat] = player.stack
        if self.button is None:
            button = initial_button(dealt, rng)
        else:
            button = next_button(self.button, dealt, self.config.seat_count)
        state = start_hand(self.config.hand_config, stacks, button, rng=rng)
        self.hand = state
        self.hand_no += 1
        self.button = button
        self._emit(
            "hand_started",
            hand_no=self.hand_no,
            button=button,
            small_blind_seat=state.small_blind_seat,
            big_blind_seat=state.big_blind_seat,
            dealt_in=[s for s in range(state.num_seats) if state.dealt_in[s]],
            stacks=list(state.starting_stacks),
            posts=[{"seat": p.seat, "kind": p.kind.value, "amount": p.amount, "all_in": p.all_in} for p in state.posts],
        )
        self._after_change(None, state)
        return state

    def act(self, player_id: str, action: Action) -> None:
        """Apply the player's action. Only the seat to act may act."""
        seat, _ = self._seated(player_id)
        self.act_seat(seat, action)

    def act_seat(self, seat: int, action: Action) -> None:
        hand = self.hand
        if hand is None or hand.is_over:
            raise TableError(ErrorCode.HAND_OVER, "there is no hand in progress")
        if hand.to_act != seat:
            raise TableError(ErrorCode.NOT_YOUR_TURN, f"it is S{hand.to_act}'s turn, not S{seat}'s")
        try:
            after = apply(hand, action)
        except IllegalActionError as error:
            raise TableError(ErrorCode.ILLEGAL_ACTION, str(error)) from error
        self.hand = after
        self._after_change(hand, after)
        self._fold_absent()

    def time_out(self) -> Action:
        """Rule 13.1: the seat to act checks if it can, otherwise folds."""
        hand = self.hand
        if hand is None or hand.is_over or hand.to_act is None:
            raise TableError(ErrorCode.HAND_OVER, "there is no hand in progress")
        action = timeout_action(hand)
        self._emit("timed_out", seat=hand.to_act)
        self.act_seat(hand.to_act, action)
        return action

    def _fold_absent(self) -> None:
        """Fold for players who have left, whenever their turn comes (rule 2.3)."""
        while self.hand_in_progress:
            assert self.hand is not None
            seat = self.hand.to_act
            assert seat is not None
            player = self.seats[seat]
            if player is None or not player.leaving:
                return
            legal = legal_actions(self.hand)
            # A player who is leaving never puts in more chips; checking costs nothing.
            action = Action.check() if legal.can_check else Action.fold()
            before = self.hand
            self.hand = apply(before, action)
            self._after_change(before, self.hand)

    def _after_change(self, before: HandState | None, after: HandState) -> None:
        if before is not None and len(after.actions) > len(before.actions):
            record = after.actions[-1]
            self._emit(
                "action",
                seat=record.seat,
                street=record.street.label,
                action=record.kind.value,
                to=record.to,
                added=record.added,
                all_in=record.all_in,
                pot=after.pot,
            )
        shown = len(before.board) if before is not None else 0
        if len(after.board) > shown:
            self._emit("board", street=after.street.label, cards=[card_str(c) for c in after.board[shown:]],
                       board=[card_str(c) for c in after.board])
        if after.is_over:
            self._finish_hand(after)

    def _finish_hand(self, final: HandState) -> None:
        result = final.result
        assert result is not None
        for seat in range(final.num_seats):
            if final.dealt_in[seat]:
                player = self.seats[seat]
                assert player is not None, "a seat dealt in is freed only after the hand"
                player.stack = final.stacks[seat]
        self._emit(
            "hand_ended",
            hand_no=self.hand_no,
            uncalled=None if result.uncalled is None else {"seat": result.uncalled[0], "amount": result.uncalled[1]},
            pots=[
                {"amount": p.amount, "eligible": list(p.eligible), "winners": list(p.winners), "shares": list(p.shares)}
                for p in result.pots
            ],
            showdown=result.showdown,
            shown=[
                {"seat": s, "cards": [card_str(c) for c in hole]}
                for s in result.shown
                if (hole := final.hole_cards[s]) is not None
            ],
            mucked=list(result.mucked),
            winnings=list(result.winnings),
            stacks=list(final.final_stacks),
        )
        self.finished.append((self.hand_no, final))
        for seat, player in list(self.players()):
            if player.leaving:
                self._remove(seat)
                continue
            if player.pending_rebuy:
                amount, player.pending_rebuy = player.pending_rebuy, 0
                try:
                    self._check_buy_in(amount, player.stack)
                except TableError:
                    # Still within the maximum: add what fits, if that reaches the minimum.
                    amount = min(amount, self.config.max_buy_in - player.stack)
                    if amount <= 0 or player.stack + amount < self.config.min_buy_in:
                        self._emit("rebuy_dropped", seat=seat)
                        amount = 0
                if amount:
                    player.stack += amount
                    self._emit("rebought", seat=seat, amount=amount, stack=player.stack)
            if player.sit_out_next:
                player.sit_out_next = False
                player.sitting_out = True
                self._emit("sat_out", seat=seat)

    # Events

    def _emit(self, kind: str, **data: Any) -> None:
        self.seq += 1
        self.events.append(Event(self.seq, kind, data))

    def drain_events(self) -> list[Event]:
        events, self.events = self.events, []
        return events

    def drain_finished(self) -> list[tuple[int, HandState]]:
        finished, self.finished = self.finished, []
        return finished

    def drain_departures(self) -> list[Departure]:
        departures, self.departures = self.departures, []
        return departures


__all__ = [
    "Departure",
    "ErrorCode",
    "Event",
    "Player",
    "Table",
    "TableConfig",
    "TableError",
]
