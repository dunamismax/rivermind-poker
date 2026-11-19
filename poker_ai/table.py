"""A server-owned play-chip table built on the short-deck engine.

The table owns the deck, turn order, action validation and payouts. Clients
identify their seat with a secret token and only ever receive `view(token)`:
their own hole cards, the public board, stacks, bets, the pot, the actions
they may take and the public action log. Opponents' cards are disclosed only
for players who reach a showdown.

Every applied action (human or bot) increments `seq`. A client must send
the `seq` of the view it acted on, so duplicate submissions and actions from
a stale view are rejected without changing the hand. Reconnecting is just
asking for `view(token)` again. The module is transport-independent: an
HTTP or WebSocket server wraps these calls.
"""
from __future__ import annotations

import random
import secrets
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from poker_ai import utils
from poker_ai.games.short_deck.state import (
    InfoSetLookupTable, ShortDeckPokerState, new_game,
)
from poker_ai.policies import Policy, seat_view

N_SEATS = 3
# Engine player index -> position. The engine always puts the small blind
# at index 0; the table rotates which seat sits there each hand.
POSITIONS = ["small_blind", "big_blind", "button"]
# The engine deals from the process-wide `random` and NumPy generators, so
# engine calls from all tables are serialised and each table reseeds them
# from its own generator before every action. Python's generators are not
# cryptographic: this is adequate for a free play-chip game.
_ENGINE_LOCK = threading.Lock()


class TableError(Exception):
    """A rejected request. `code` is stable for clients to branch on."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class _Seat:
    name: str
    token: Optional[str] = None  # humans only
    policy: Optional[Policy] = None  # bots only
    balance: int = 0

    @property
    def is_human(self) -> bool:
        return self.token is not None


@dataclass
class SeatConfig:
    """A seat to create: give `policy` for a bot, leave it None for a human."""

    name: str
    policy: Optional[Policy] = None


@dataclass
class _Event:
    seat: int
    action: str
    stage: str


@dataclass
class _HandResult:
    payouts: Dict[int, int]
    showdown: bool
    revealed: Dict[int, List[Dict[str, Any]]] = field(default_factory=dict)


class Table:
    """One three-seat table. All methods are thread-safe."""

    def __init__(
        self,
        seats: List[SeatConfig],
        card_info_lut: Optional[InfoSetLookupTable] = None,
        seed: Optional[int] = None,
    ):
        if len(seats) != N_SEATS:
            raise ValueError(f"A table has {N_SEATS} seats.")
        self._seats = [
            _Seat(
                name=s.name,
                token=None if s.policy else secrets.token_urlsafe(16),
                policy=s.policy,
            )
            for s in seats
        ]
        if not any(seat.is_human for seat in self._seats):
            raise ValueError("A table needs at least one human seat.")
        self._card_info_lut = card_info_lut or {}
        self._rng = random.Random(secrets.randbits(64) if seed is None else seed)
        self._lock = threading.RLock()
        self._hand = 0
        self._seq = 0
        self._button_offset = 0
        self._start_hand()

    # Public API -----------------------------------------------------------

    @property
    def tokens(self) -> Dict[int, str]:
        """Seat index -> token for each human seat (give each to its player)."""
        return {i: s.token for i, s in enumerate(self._seats) if s.is_human}

    def view(self, token: str) -> Dict[str, Any]:
        """The current table as the token's seat may see it."""
        with self._lock:
            return self._view(self._seat_for(token))

    def act(self, token: str, action: str, seq: int) -> Dict[str, Any]:
        """Apply `action` for the token's seat, then let bots act."""
        with self._lock:
            seat = self._seat_for(token)
            self._check_seq(seq)
            if self._result is not None:
                raise TableError("hand_over", "The hand is over.")
            if self._seat_of_player(self._state.player_i) != seat:
                raise TableError("not_your_turn", "It is not your turn.")
            if action not in self._state.legal_actions:
                raise TableError(
                    "illegal_action",
                    f"{action!r} is not one of {self._state.legal_actions}.",
                )
            self._apply(action)
            self._run_bots()
            return self._view(seat)

    def next_hand(self, token: str, seq: int) -> Dict[str, Any]:
        """Start the next hand once the current one is over."""
        with self._lock:
            seat = self._seat_for(token)
            self._check_seq(seq)
            if self._result is None:
                raise TableError("hand_in_progress", "The hand is not over.")
            self._button_offset = (self._button_offset + 1) % N_SEATS
            self._start_hand()
            return self._view(seat)

    # Internals ------------------------------------------------------------

    def _seat_for(self, token: str) -> int:
        if not isinstance(token, str):
            raise TableError("unknown_seat", "That token does not hold a seat.")
        for i, seat in enumerate(self._seats):
            if seat.token is not None and secrets.compare_digest(seat.token, token):
                return i
        raise TableError("unknown_seat", "That token does not hold a seat.")

    def _check_seq(self, seq: int):
        if seq != self._seq:
            raise TableError(
                "stale",
                f"The table has moved on (seq {self._seq}, request {seq}); "
                f"refresh the view.",
            )

    def _player_of_seat(self, seat: int) -> int:
        return (seat - self._button_offset) % N_SEATS

    def _seat_of_player(self, player_i: int) -> int:
        return (player_i + self._button_offset) % N_SEATS

    def _start_hand(self):
        with _ENGINE_LOCK:
            utils.random.seed(self._rng.randrange(2**32))
            if self._card_info_lut:
                self._state: ShortDeckPokerState = new_game(
                    N_SEATS, self._card_info_lut
                )
            else:
                self._state = new_game(N_SEATS, {}, load_card_lut=False)
        self._hand += 1
        self._seq += 1
        self._events: List[_Event] = []
        self._board: List[Any] = []
        self._result: Optional[_HandResult] = None
        self._run_bots()

    def _apply(self, action: str):
        before = self._state
        stage = before.betting_stage
        with _ENGINE_LOCK:
            utils.random.seed(self._rng.randrange(2**32))
            self._state = before.apply_action(action)
        self._seq += 1
        self._events.append(
            _Event(self._seat_of_player(before.player_i), action, stage)
        )
        state = self._state
        if state.betting_stage == "terminal":
            # Everyone else folded. The engine deals a flop it never shows
            # when that happens pre-flop, so keep the board as it was.
            self._board = list(before.community_cards)
        else:
            self._board = list(state.community_cards)
        if state.is_terminal:
            self._finish_hand(showdown=state.betting_stage == "show_down")

    def _finish_hand(self, showdown: bool):
        payouts = {
            self._seat_of_player(p): chips for p, chips in self._state.payout.items()
        }
        for seat, chips in payouts.items():
            self._seats[seat].balance += chips
        revealed = {}
        if showdown:
            for p, player in enumerate(self._state.players):
                if player.is_active:
                    revealed[self._seat_of_player(p)] = [
                        c.to_dict() for c in player.cards
                    ]
        self._result = _HandResult(payouts, showdown, revealed)

    def _run_bots(self):
        while self._result is None:
            seat = self._seats[self._seat_of_player(self._state.player_i)]
            if seat.is_human:
                return
            action = seat.policy.choose(seat_view(self._state))
            if action not in self._state.legal_actions:
                raise RuntimeError(f"Bot {seat.name} chose illegal {action!r}")
            self._apply(action)

    def _view(self, seat: int) -> Dict[str, Any]:
        state = self._state
        over = self._result is not None
        acting_seat = None if over else self._seat_of_player(state.player_i)
        seats = []
        for i, s in enumerate(self._seats):
            player = state.players[self._player_of_seat(i)]
            if i == seat:
                cards = [c.to_dict() for c in player.cards]
            elif over and i in self._result.revealed:
                cards = self._result.revealed[i]
            else:
                cards = None
            seats.append({
                "seat": i,
                "name": s.name,
                "kind": "human" if s.is_human else "bot",
                "position": POSITIONS[self._player_of_seat(i)],
                "stack": player.n_chips,
                "bet": player.n_bet_chips,
                "folded": not player.is_active,
                "is_turn": i == acting_seat,
                "balance": s.balance,
                "cards": cards,
            })
        your_turn = acting_seat == seat
        return {
            "hand": self._hand,
            "seq": self._seq,
            "seat": seat,
            "stage": state.betting_stage,
            "board": [c.to_dict() for c in self._board],
            "pot": state._table.pot.total,
            "seats": seats,
            "your_turn": your_turn,
            "legal_actions": list(state.legal_actions) if your_turn else [],
            "events": [vars(e).copy() for e in self._events],
            "result": None if not over else {
                "payouts": dict(self._result.payouts),
                "showdown": self._result.showdown,
            },
        }
