"""The no-limit hold'em hand as an immutable state machine.

``start_hand`` posts antes and blinds, deals hole cards and returns the first
``HandState``. ``legal_actions`` describes what the player to act may do and
``apply`` returns the next state. States are never changed in place, so any
state can be kept, compared, serialized or explored further. Every rule
number below refers to ``docs/rules.md``.

The engine takes randomness only from its caller (rule 1.1): pass either a
complete deck order or a random generator to ``start_hand``.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import IntEnum, StrEnum

from . import evaluator
from .cards import DECK_SIZE
from .pots import Pot, build_pots, split, uncalled_bet
from .seating import blind_seats, deal_order


class Street(IntEnum):
    PREFLOP = 0
    FLOP = 1
    TURN = 2
    RIVER = 3

    @property
    def label(self) -> str:
        return ("pre-flop", "flop", "turn", "river")[self]


class ActionKind(StrEnum):
    FOLD = "fold"
    CHECK = "check"
    CALL = "call"
    BET = "bet"
    RAISE = "raise"


class PostKind(StrEnum):
    ANTE = "ante"
    SMALL_BLIND = "small_blind"
    BIG_BLIND = "big_blind"


class IllegalActionError(ValueError):
    """The action is not one of the legal actions for the player to act."""


@dataclass(frozen=True, slots=True)
class HandConfig:
    """Stakes for one hand. Chips are whole numbers (Conventions)."""

    small_blind: int
    big_blind: int
    ante: int = 0

    def __post_init__(self) -> None:
        for name in ("small_blind", "big_blind", "ante"):
            value = getattr(self, name)
            if type(value) is not int:
                raise TypeError(f"{name} must be an int")
        if not 0 < self.small_blind <= self.big_blind:
            raise ValueError("blinds must satisfy 0 < small blind <= big blind")
        if self.ante < 0:
            raise ValueError("ante must not be negative")


@dataclass(frozen=True, slots=True)
class Action:
    """A decision. For a bet or raise, ``amount`` is the new street total (Conventions)."""

    kind: ActionKind
    amount: int | None = None

    @staticmethod
    def fold() -> Action:
        return Action(ActionKind.FOLD)

    @staticmethod
    def check() -> Action:
        return Action(ActionKind.CHECK)

    @staticmethod
    def call() -> Action:
        return Action(ActionKind.CALL)

    @staticmethod
    def bet(to: int) -> Action:
        return Action(ActionKind.BET, to)

    @staticmethod
    def raise_to(to: int) -> Action:
        return Action(ActionKind.RAISE, to)


@dataclass(frozen=True, slots=True)
class Post:
    """An ante or blind posted before the cards are dealt."""

    seat: int
    kind: PostKind
    amount: int
    all_in: bool


@dataclass(frozen=True, slots=True)
class ActionRecord:
    """An applied action. ``to`` is the seat's street bet afterwards."""

    seat: int
    street: Street
    kind: ActionKind
    to: int
    added: int
    all_in: bool


@dataclass(frozen=True, slots=True)
class LegalActions:
    """What the player to act may do (rule 7.7).

    ``call`` is the number of chips a call adds, which is less than the amount
    owed when calling puts the player all-in; it is 0 when there is nothing to
    call. ``raise_kind`` is ``BET`` or ``RAISE`` when the player may bet or
    raise, with ``min_to`` and ``max_to`` the allowed street totals.
    """

    seat: int
    can_fold: bool
    can_check: bool
    call: int
    raise_kind: ActionKind | None
    min_to: int = 0
    max_to: int = 0

    @property
    def can_call(self) -> bool:
        return self.call > 0

    @property
    def can_raise(self) -> bool:
        return self.raise_kind is not None

    def allows(self, action: Action) -> bool:
        kind = action.kind
        if kind is ActionKind.FOLD:
            return self.can_fold and action.amount is None
        if kind is ActionKind.CHECK:
            return self.can_check and action.amount is None
        if kind is ActionKind.CALL:
            return self.call > 0 and action.amount is None
        return (
            kind is self.raise_kind
            and type(action.amount) is int
            and self.min_to <= action.amount <= self.max_to
        )

    def options(self) -> tuple[Action, ...]:
        """The legal actions, with a bet or raise at its minimum and maximum."""
        found: list[Action] = []
        if self.can_fold:
            found.append(Action.fold())
        if self.can_check:
            found.append(Action.check())
        if self.call:
            found.append(Action.call())
        if self.raise_kind is not None:
            found.append(Action(self.raise_kind, self.min_to))
            if self.max_to != self.min_to:
                found.append(Action(self.raise_kind, self.max_to))
        return tuple(found)


@dataclass(frozen=True, slots=True)
class HandResult:
    """How a finished hand was settled (rules 9, 11 and 12)."""

    uncalled: tuple[int, int] | None
    """Seat and amount of an uncalled bet returned before the pots were formed."""
    pots: tuple[Pot, ...]
    showdown: bool
    """Whether two or more players reached showdown."""
    tabled: bool
    """Whether every hand was turned face up at once (rule 12.1)."""
    shown: tuple[int, ...]
    """Seats whose hands were shown, in showing order."""
    mucked: tuple[int, ...]
    """Seats whose hands were mucked unseen (rule 12.3), in showing order."""
    hand_ranks: tuple[int | None, ...]
    """Evaluator rank per seat for players at showdown, otherwise ``None``."""
    winnings: tuple[int, ...]
    """Chips won from the pots per seat, not counting a returned uncalled bet."""


@dataclass(frozen=True, slots=True)
class HandState:
    """One moment of a hand. Per-seat tuples are indexed by seat number."""

    config: HandConfig
    button: int
    small_blind_seat: int
    big_blind_seat: int
    starting_stacks: tuple[int | None, ...]
    deck: tuple[int, ...] = field(repr=False)
    dealt_in: tuple[bool, ...]
    hole_cards: tuple[tuple[int, int] | None, ...] = field(repr=False)
    stacks: tuple[int, ...]
    """Chips behind for players dealt in, and 0 for every other seat."""
    street_bets: tuple[int, ...]
    contributions: tuple[int, ...]
    folded: tuple[bool, ...]
    acted_at: tuple[int | None, ...]
    """The current bet just after each seat last acted on this street (rule 8.1)."""
    street: Street
    board: tuple[int, ...]
    current_bet: int
    min_raise: int
    """The minimum raise increment on this street (rule 7.4)."""
    to_act: int | None
    posts: tuple[Post, ...]
    actions: tuple[ActionRecord, ...]
    result: HandResult | None = None

    @property
    def num_seats(self) -> int:
        return len(self.starting_stacks)

    @property
    def is_over(self) -> bool:
        return self.result is not None

    @property
    def pot(self) -> int:
        """Everything put in so far, including the current street's bets."""
        return sum(self.contributions)

    @property
    def seat_order(self) -> tuple[int, ...]:
        """Players dealt in, clockwise from the player left of the button."""
        return deal_order(self.button, _true_seats(self.dealt_in), self.num_seats)

    @property
    def final_stacks(self) -> tuple[int | None, ...]:
        """Stacks for the seats dealt in, ``None`` elsewhere; final once ``is_over``."""
        return tuple(s if d else None for s, d in zip(self.stacks, self.dealt_in))


def _true_seats(flags: Sequence[bool]) -> frozenset[int]:
    return frozenset(i for i, flag in enumerate(flags) if flag)


def start_hand(
    config: HandConfig,
    stacks: Sequence[int | None],
    button: int,
    *,
    deck: Sequence[int] | None = None,
    rng: random.Random | None = None,
) -> HandState:
    """Post antes and blinds and deal hole cards for a new hand.

    ``stacks`` has one entry per seat (2 to 9 seats). A seat with ``None`` or 0
    chips is not dealt in (rule 2.1); the table leaves sitting-out players as
    ``None``. ``button`` must be a seat dealt in; the table chooses it with
    ``seating.initial_button`` and ``seating.next_button``. Supply exactly one
    of ``deck`` (a full 52-card order) and ``rng`` (which shuffles one).
    """
    num_seats = len(stacks)
    if not 2 <= num_seats <= 9:
        raise ValueError("a table has 2 to 9 seats")
    for stack in stacks:
        if stack is not None and (type(stack) is not int or stack < 0):
            raise ValueError("stacks must be None or whole numbers of chips")
    dealt = tuple(bool(stack) for stack in stacks)
    in_hand = _true_seats(dealt)
    if len(in_hand) < 2:
        raise ValueError("a hand needs at least two players dealt in")
    if not 0 <= button < num_seats or not dealt[button]:
        raise ValueError("the button must be a player dealt in")
    if (deck is None) == (rng is None):
        raise ValueError("pass exactly one of deck and rng")
    if deck is None:
        shuffled = list(range(DECK_SIZE))
        assert rng is not None
        rng.shuffle(shuffled)
        deck_order = tuple(shuffled)
    else:
        deck_order = tuple(deck)
        if len(deck_order) != DECK_SIZE or set(deck_order) != set(range(DECK_SIZE)):
            raise ValueError("deck must be an order of all 52 cards")

    small_seat, big_seat = blind_seats(button, in_hand, num_seats)
    order = deal_order(button, in_hand, num_seats)
    chips = [stack or 0 for stack in stacks]
    bets = [0] * num_seats
    contributed = [0] * num_seats
    posts: list[Post] = []

    def post(seat: int, kind: PostKind, amount: int, street_bet: bool) -> None:
        paid = min(amount, chips[seat])
        chips[seat] -= paid
        contributed[seat] += paid
        if street_bet:
            bets[seat] += paid
        posts.append(Post(seat, kind, paid, chips[seat] == 0))

    if config.ante:
        for seat in order:
            post(seat, PostKind.ANTE, config.ante, street_bet=False)
    post(small_seat, PostKind.SMALL_BLIND, config.small_blind, street_bet=True)
    post(big_seat, PostKind.BIG_BLIND, config.big_blind, street_bet=True)

    n = len(order)
    holes: list[tuple[int, int] | None] = [None] * num_seats
    for i, seat in enumerate(order):
        holes[seat] = (deck_order[i], deck_order[n + i])

    state = HandState(
        config=config,
        button=button,
        small_blind_seat=small_seat,
        big_blind_seat=big_seat,
        starting_stacks=tuple(stacks),
        deck=deck_order,
        dealt_in=dealt,
        hole_cards=tuple(holes),
        stacks=tuple(chips),
        street_bets=tuple(bets),
        contributions=tuple(contributed),
        folded=(False,) * num_seats,
        acted_at=(None,) * num_seats,
        street=Street.PREFLOP,
        board=(),
        current_bet=config.big_blind,
        min_raise=config.big_blind,
        to_act=None,
        posts=tuple(posts),
        actions=(),
    )
    # Rule 6.2: pre-flop the first to act is left of the big blind, or the
    # button heads-up.
    first = button if n == 2 else order[2 % n]
    return _Builder(state).advance(first)


def legal_actions(state: HandState) -> LegalActions:
    """The legal actions for the player to act (rules 7 and 8)."""
    seat = state.to_act
    if seat is None:
        raise IllegalActionError("the hand is over")
    stack = state.stacks[seat]
    street_bet = state.street_bets[seat]
    current = state.current_bet
    owed = current - street_bet
    if owed > 0:
        can_fold, can_check, call = True, False, min(owed, stack)
    else:
        can_fold, can_check, call = False, True, 0
    if stack > owed:
        acted = state.acted_at[seat]
        # Rule 8: a player who has acted may raise again only after a full
        # raise in total. Rule 7.8: there must be someone left to call it.
        reopened = acted is None or current - acted >= state.min_raise
        if reopened and _anyone_else_has_chips(state, seat):
            most = street_bet + stack
            least = min(current + state.min_raise, most)
            kind = ActionKind.BET if current == 0 else ActionKind.RAISE
            return LegalActions(seat, can_fold, can_check, call, kind, least, most)
    return LegalActions(seat, can_fold, can_check, call, None)


def timeout_action(state: HandState) -> Action:
    """Rule 13.1: when the clock runs out, check if possible, otherwise fold."""
    return Action.check() if legal_actions(state).can_check else Action.fold()


def _anyone_else_has_chips(state: HandState, seat: int) -> bool:
    stacks = state.stacks
    folded = state.folded
    dealt = state.dealt_in
    for other in range(len(stacks)):
        if other != seat and dealt[other] and not folded[other] and stacks[other] > 0:
            return True
    return False


def apply(state: HandState, action: Action) -> HandState:
    """Apply a legal action and return the next state.

    Raises ``IllegalActionError`` (leaving ``state`` untouched) for anything
    that ``legal_actions`` does not allow.
    """
    legal = legal_actions(state)
    if not isinstance(action, Action) or not legal.allows(action):
        raise IllegalActionError(f"{action!r} is not legal; legal actions are {legal!r}")
    seat = legal.seat
    builder = _Builder(state)
    kind = action.kind
    if kind is ActionKind.FOLD:
        builder.folded[seat] = True
        added = 0
    elif kind is ActionKind.CHECK:
        added = 0
    elif kind is ActionKind.CALL:
        added = legal.call
    else:
        assert action.amount is not None
        added = action.amount - state.street_bets[seat]
        increment = action.amount - state.current_bet
        if increment >= state.min_raise:
            builder.min_raise = increment
        builder.current_bet = action.amount
    builder.stacks[seat] -= added
    builder.street_bets[seat] += added
    builder.contributions[seat] += added
    builder.acted_at[seat] = builder.current_bet
    builder.actions.append(
        ActionRecord(
            seat,
            state.street,
            kind,
            builder.street_bets[seat],
            added,
            builder.stacks[seat] == 0 and kind is not ActionKind.FOLD,
        )
    )
    return builder.advance((seat + 1) % state.num_seats)


class _Builder:
    """Mutable working copy of a state, used inside one transition."""

    def __init__(self, state: HandState) -> None:
        self.base = state
        self.stacks = list(state.stacks)
        self.street_bets = list(state.street_bets)
        self.contributions = list(state.contributions)
        self.folded = list(state.folded)
        self.acted_at = list(state.acted_at)
        self.street = state.street
        self.board = state.board
        self.current_bet = state.current_bet
        self.min_raise = state.min_raise
        self.actions = list(state.actions)
        self.to_act: int | None = None
        self.result: HandResult | None = None

    def build(self) -> HandState:
        base = self.base
        return HandState(
            config=base.config,
            button=base.button,
            small_blind_seat=base.small_blind_seat,
            big_blind_seat=base.big_blind_seat,
            starting_stacks=base.starting_stacks,
            deck=base.deck,
            dealt_in=base.dealt_in,
            hole_cards=base.hole_cards,
            stacks=tuple(self.stacks),
            street_bets=tuple(self.street_bets),
            contributions=tuple(self.contributions),
            folded=tuple(self.folded),
            acted_at=tuple(self.acted_at),
            street=self.street,
            board=self.board,
            current_bet=self.current_bet,
            min_raise=self.min_raise,
            to_act=self.to_act,
            posts=base.posts,
            actions=tuple(self.actions),
            result=self.result,
        )

    def advance(self, start: int) -> HandState:
        """Find the next player to act from ``start`` clockwise, or move the hand on."""
        dealt = self.base.dealt_in
        num_seats = len(dealt)
        while True:
            live = [s for s in range(num_seats) if dealt[s] and not self.folded[s]]
            if len(live) == 1:
                self._settle(live, showdown=False, tabled=False)
                return self.build()
            active = [s for s in live if self.stacks[s] > 0]
            current = self.current_bet
            # Rule 6.4: no more betting once at most one player still in has
            # chips and has matched the current bet.
            if len(active) == 0 or (len(active) == 1 and self.street_bets[active[0]] >= current):
                self._deal_through(Street.RIVER)
                self._settle(live, showdown=True, tabled=True)
                return self.build()
            for step in range(num_seats):
                seat = (start + step) % num_seats
                if self.stacks[seat] > 0 and dealt[seat] and not self.folded[seat]:
                    if self.acted_at[seat] is None or self.street_bets[seat] < current:
                        self.to_act = seat
                        return self.build()
            # Rule 6.3: the betting round is complete.
            if self.street is Street.RIVER:
                self._settle(live, showdown=True, tabled=False)
                return self.build()
            self._deal_through(Street(self.street + 1))
            self.street_bets = [0] * num_seats
            self.acted_at = [None] * num_seats
            self.current_bet = 0
            self.min_raise = self.base.config.big_blind
            start = (self.base.button + 1) % num_seats

    def _deal_through(self, street: Street) -> None:
        """Deal board cards up to ``street`` (rules 1.3 and 1.4)."""
        n = sum(self.base.dealt_in)
        deck = self.base.deck
        board = list(self.board)
        if street >= Street.FLOP and len(board) < 3:
            board.extend(deck[2 * n + 1 : 2 * n + 4])
        if street >= Street.TURN and len(board) < 4:
            board.append(deck[2 * n + 5])
        if street >= Street.RIVER and len(board) < 5:
            board.append(deck[2 * n + 7])
        self.board = tuple(board)
        self.street = max(self.street, street)

    def _settle(self, live: list[int], *, showdown: bool, tabled: bool) -> None:
        base = self.base
        num_seats = len(base.dealt_in)
        contributions = list(self.contributions)
        uncalled = uncalled_bet(contributions)
        if uncalled is not None:
            seat, amount = uncalled
            contributions[seat] -= amount
            self.stacks[seat] += amount
            self.contributions[seat] -= amount
        pots = build_pots(contributions, live)
        ranks: list[int | None] = [None] * num_seats
        shown: tuple[int, ...] = ()
        mucked: tuple[int, ...] = ()
        if showdown:
            for seat in live:
                hole = base.hole_cards[seat]
                assert hole is not None
                ranks[seat] = evaluator.evaluate((*hole, *self.board))
            shown, mucked = _show_order(base, self.actions, live, pots, ranks, tabled)
        winnings = [0] * num_seats
        awarded: list[Pot] = []
        for pot in pots:
            if showdown:
                best = min(ranks[s] for s in pot.eligible)  # type: ignore[type-var]
                winners = [s for s in pot.eligible if ranks[s] == best]
            else:
                winners = list(pot.eligible)
            ordered, shares = split(pot.amount, winners, base.button, num_seats)
            for seat, share in zip(ordered, shares):
                winnings[seat] += share
                self.stacks[seat] += share
            awarded.append(Pot(pot.amount, pot.eligible, ordered, shares))
        self.to_act = None
        self.result = HandResult(
            uncalled=uncalled,
            pots=tuple(awarded),
            showdown=showdown,
            tabled=tabled,
            shown=shown,
            mucked=mucked,
            hand_ranks=tuple(ranks),
            winnings=tuple(winnings),
        )


def _show_order(
    base: HandState,
    actions: Sequence[ActionRecord],
    live: Sequence[int],
    pots: Sequence[Pot],
    ranks: Sequence[int | None],
    tabled: bool,
) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Rule 12: which hands are shown, in order, and which are mucked."""
    num_seats = len(base.dealt_in)
    first = (base.button + 1) % num_seats
    if not tabled:
        for record in reversed(actions):
            if record.street is not Street.RIVER:
                break
            if record.kind in (ActionKind.BET, ActionKind.RAISE):
                first = record.seat
                break
    order = sorted(live, key=lambda seat: (seat - first) % num_seats)
    if tabled:
        return tuple(order), ()
    best: list[int | None] = [None] * len(pots)
    shown: list[int] = []
    mucked: list[int] = []
    for seat in order:
        rank = ranks[seat]
        assert rank is not None
        eligible = [i for i, pot in enumerate(pots) if seat in pot.eligible]
        if any(best[i] is None or rank <= best[i] for i in eligible):  # type: ignore[operator]
            shown.append(seat)
            for i in eligible:
                if best[i] is None or rank < best[i]:  # type: ignore[operator]
                    best[i] = rank
        else:
            mucked.append(seat)
    return tuple(shown), tuple(mucked)
