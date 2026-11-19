"""Fixture tests for docs/rules.md sections 1 to 8 and 13: dealing, seats,
blinds, button movement, action order and legal actions.

Payouts (sections 9 to 12) are covered hand by hand in test_payouts.py.
"""

from __future__ import annotations

import random

import pytest

from rivermind.engine import (
    Action,
    ActionKind,
    HandConfig,
    IllegalActionError,
    PostKind,
    Street,
    apply,
    blind_seats,
    initial_button,
    legal_actions,
    next_button,
    start_hand,
    timeout_action,
)
from rivermind.engine.cards import FULL_DECK

from .helpers import acting_order, check_down, deal, play

STACK = 10_000


def seats(n: int, stack: int = STACK) -> list[int | None]:
    return [stack] * n


# Section 1 · Deck and dealing


def test_1_4_deal_positions_six_players() -> None:
    state = start_hand(HandConfig(50, 100), seats(6), 2, deck=FULL_DECK)
    d = FULL_DECK
    assert state.hole_cards[3] == (d[0], d[6])
    assert state.hole_cards[4] == (d[1], d[7])
    assert state.hole_cards[2] == (d[5], d[11])
    assert [state.hole_cards[s] for s in (5, 0, 1)] == [(d[2], d[8]), (d[3], d[9]), (d[4], d[10])]
    state = play(state, "S5:c S0:c S1:c S2:c S3:c S4:k")
    assert state.street is Street.FLOP and state.board == (d[13], d[14], d[15])
    state = play(state, "S3:k S4:k S5:k S0:k S1:k S2:k")
    assert state.board[3] == d[17]
    state = play(state, "S3:k S4:k S5:k S0:k S1:k S2:k")
    assert state.board[4] == d[19]


def test_1_4_unreached_streets_are_not_dealt() -> None:
    state = play(deal(seats(3), 0), "S0:f S1:f")
    assert state.is_over and state.board == ()


def test_1_1_deck_or_rng_required() -> None:
    with pytest.raises(ValueError):
        start_hand(HandConfig(50, 100), seats(2), 0)
    with pytest.raises(ValueError):
        start_hand(HandConfig(50, 100), seats(2), 0, deck=FULL_DECK, rng=random.Random(1))
    with pytest.raises(ValueError):
        start_hand(HandConfig(50, 100), seats(2), 0, deck=FULL_DECK[:-1])
    a = start_hand(HandConfig(50, 100), seats(6), 0, rng=random.Random(7))
    b = start_hand(HandConfig(50, 100), seats(6), 0, rng=random.Random(7))
    assert a == b


# Section 2 · Seats and players dealt in


def test_2_1_two_players_at_nine_seats_play_heads_up() -> None:
    stacks: list[int | None] = [None] * 9
    stacks[1] = stacks[6] = STACK
    state = deal(stacks, 6)
    assert (state.small_blind_seat, state.big_blind_seat) == (6, 1)
    assert state.to_act == 6


def test_2_1_needs_two_players_dealt_in() -> None:
    stacks: list[int | None] = [None] * 9
    stacks[1] = STACK
    stacks[6] = 0
    with pytest.raises(ValueError):
        start_hand(HandConfig(50, 100), stacks, 1, deck=FULL_DECK)
    with pytest.raises(ValueError):
        start_hand(HandConfig(50, 100), [STACK] * 10, 0, deck=FULL_DECK)
    with pytest.raises(ValueError):
        start_hand(HandConfig(50, 100), [STACK, None, STACK], 1, deck=FULL_DECK)


def test_2_2_new_player_dealt_in_next_hand() -> None:
    stacks: list[int | None] = [None] * 9
    stacks[1] = stacks[6] = STACK
    stacks[3] = STACK
    button = next_button(6, {1, 3, 6}, 9)
    state = deal(stacks, button)
    assert button == 1 and (state.small_blind_seat, state.big_blind_seat) == (3, 6)
    assert sum(state.dealt_in) == 3


# Section 3 · Blinds and antes


def test_3_2_antes_are_not_street_bets() -> None:
    state = deal(seats(6), 2, config=HandConfig(50, 100, ante=10))
    assert state.pot == 210
    assert [p.kind for p in state.posts] == [PostKind.ANTE] * 6 + [PostKind.SMALL_BLIND, PostKind.BIG_BLIND]
    assert [p.seat for p in state.posts[:6]] == [3, 4, 5, 0, 1, 2]
    assert state.to_act == 5
    legal = legal_actions(state)
    assert (legal.call, legal.raise_kind, legal.min_to) == (100, ActionKind.RAISE, 200)


def test_3_3_short_big_blind_keeps_the_price() -> None:
    stacks = seats(6)
    stacks[4] = 60
    state = deal(stacks, 2)
    assert state.posts[-1].amount == 60 and state.posts[-1].all_in
    assert state.current_bet == 100
    legal = legal_actions(state)
    assert (legal.call, legal.min_to) == (100, 200)


def test_3_3_short_ante_is_all_in_before_the_deal() -> None:
    stacks: list[int | None] = [STACK, 5, STACK]
    state = deal(stacks, 0, config=HandConfig(50, 100, ante=10))
    ante = state.posts[0]
    assert (ante.seat, ante.kind, ante.amount, ante.all_in) == (1, PostKind.ANTE, 5, True)
    small = state.posts[3]
    assert (small.seat, small.kind, small.amount, small.all_in) == (1, PostKind.SMALL_BLIND, 0, True)


def test_3_4_big_blind_option() -> None:
    state = play(deal(seats(6), 2), "S5:c S0:c S1:c S2:c S3:c")
    assert state.to_act == 4
    legal = legal_actions(state)
    assert legal.can_check and not legal.can_fold and legal.raise_kind is ActionKind.RAISE
    assert legal.min_to == 200


# Section 4 · Heads-up


def test_4_heads_up_blinds_dealing_and_order() -> None:
    stacks: list[int | None] = [STACK, None, None, None, None, STACK]
    state = start_hand(HandConfig(50, 100), stacks, 0, deck=FULL_DECK)
    assert (state.small_blind_seat, state.big_blind_seat) == (0, 5)
    assert state.hole_cards[5] == (FULL_DECK[0], FULL_DECK[2])
    assert state.hole_cards[0] == (FULL_DECK[1], FULL_DECK[3])
    assert state.to_act == 0
    legal = legal_actions(state)
    assert (legal.can_fold, legal.call, legal.min_to) == (True, 50, 200)
    state = play(state, "S0:c S5:k")
    assert state.street is Street.FLOP
    assert acting_order(state) == [5, 0]


# Section 5 · The button


def test_5_1_initial_button_is_random_dealt_in_player() -> None:
    picks = {initial_button({1, 4, 7}, random.Random(seed)) for seed in range(50)}
    assert picks == {1, 4, 7}


def test_5_2_seats_emptying() -> None:
    everyone = set(range(6))
    assert next_button(1, everyone, 6) == 2
    assert blind_seats(2, everyone, 6) == (3, 4)
    without_s2 = everyone - {2}
    assert next_button(1, without_s2, 6) == 3
    assert blind_seats(3, without_s2, 6) == (4, 5)
    without_s4 = everyone - {4}
    assert next_button(1, without_s4, 6) == 2
    assert blind_seats(2, without_s4, 6) == (3, 5)


def test_5_2_seats_filling() -> None:
    dealt = set(range(6)) | {7}
    button = next_button(1, dealt, 9)
    assert button == 2 and blind_seats(button, dealt, 9) == (3, 4)
    buttons = [button]
    for _ in range(2):
        buttons.append(next_button(buttons[-1], dealt, 9))
    assert blind_seats(buttons[-1], dealt, 9) == (5, 7)


def test_5_3_to_heads_up() -> None:
    button = next_button(1, {1, 3}, 6)
    assert button == 3 and blind_seats(button, {1, 3}, 6) == (3, 1)


# Section 6 · Betting rounds and order of action


@pytest.mark.parametrize(
    ("num_seats", "button", "preflop", "postflop"),
    [
        (2, 0, [0, 1], [1, 0]),
        (2, 1, [1, 0], [0, 1]),
        (3, 0, [0, 1, 2], [1, 2, 0]),
        (3, 2, [2, 0, 1], [0, 1, 2]),
        (6, 2, [5, 0, 1, 2, 3, 4], [3, 4, 5, 0, 1, 2]),
        (9, 0, [3, 4, 5, 6, 7, 8, 0, 1, 2], [1, 2, 3, 4, 5, 6, 7, 8, 0]),
        (9, 8, [2, 3, 4, 5, 6, 7, 8, 0, 1], [0, 1, 2, 3, 4, 5, 6, 7, 8]),
    ],
)
def test_6_action_order_every_street(num_seats: int, button: int, preflop: list[int], postflop: list[int]) -> None:
    state = deal(seats(num_seats), button)
    assert acting_order(state) == preflop
    state = check_down_street(state, preflop)
    for street in (Street.FLOP, Street.TURN, Street.RIVER):
        assert state.street is street
        assert acting_order(state) == postflop
        state = check_down_street(state, postflop)
    assert state.is_over and state.result is not None and state.result.showdown


def check_down_street(state, order):  # type: ignore[no-untyped-def]
    for seat in order:
        assert state.to_act == seat
        legal = legal_actions(state)
        state = apply(state, Action.check() if legal.can_check else Action.call())
    return state


def test_6_2_order_skips_empty_and_all_in_seats() -> None:
    stacks: list[int | None] = [STACK, None, STACK, STACK, None, STACK, STACK, None, STACK]
    state = deal(stacks, 2)
    assert (state.small_blind_seat, state.big_blind_seat) == (3, 5)
    assert acting_order(state) == [6, 8, 0, 2, 3, 5]
    stacks = seats(6)
    stacks[3] = 100
    state = play(deal(stacks, 2), "S5:c S0:c S1:c S2:c S3:c S4:k")
    assert state.street is Street.FLOP and state.to_act == 4


def test_6_3_round_continues_after_a_raise() -> None:
    state = play(deal(seats(6), 2), "S5:c S0:c S1:c S2:c S3:c S4:r300")
    assert acting_order(state) == [5, 0, 1, 2, 3]
    state = play(deal(seats(4), 0), "S3:c S0:c S1:c S2:k S1:b100 S2:r300 S3:c S0:c S1:c")
    assert state.street is Street.TURN


def test_6_4_all_in_skips_later_betting() -> None:
    state = play(deal([2_000, STACK, STACK], 0), "S0:a S1:c S2:c")
    assert state.street is Street.FLOP and state.to_act == 1
    state = play(state, "S1:b500 S2:c")
    assert state.street is Street.TURN
    state = play(state, "S1:a S2:c")
    assert state.is_over and state.result is not None and state.result.tabled
    assert len(state.board) == 5
    state = play(deal(seats(2), 0), "S0:r10000 S1:c")
    assert state.is_over and len(state.board) == 5 and state.result.tabled  # type: ignore[union-attr]


def test_6_4_no_option_when_everyone_else_is_all_in() -> None:
    state = deal([30, STACK], 0)
    assert state.is_over and len(state.board) == 5


def test_6_5_fold_out_wins_at_once() -> None:
    state = play(deal(seats(3), 0), "S0:r300 S1:f S2:f")
    assert state.is_over and state.board == ()
    assert state.result is not None and not state.result.showdown and state.result.shown == ()


# Section 7 · Legal actions and amounts


def test_7_preflop_reraise_range() -> None:
    state = play(deal(seats(6), 2), "S5:r300")
    legal = legal_actions(state)
    assert legal.seat == 0
    assert (legal.call, legal.min_to, legal.max_to) == (300, 500, STACK)


def test_7_postflop_reraise_and_call_for_less() -> None:
    state = play(deal(seats(6), 2), "S5:c S0:c S1:c S2:c S3:c S4:k S3:b100 S4:r350")
    legal = legal_actions(state)
    assert (legal.seat, legal.min_to) == (5, 600)
    stacks = seats(6)
    stacks[5] = 180
    state = play(deal(stacks, 2), "S5:c S0:c S1:c S2:c S3:c S4:k S3:b100 S4:r350")
    legal = legal_actions(state)
    assert (legal.call, legal.raise_kind) == (80, None)
    state = play(state, "S5:c")
    assert state.stacks[5] == 0 and state.street_bets[5] == 80 and state.actions[-1].all_in


def test_7_short_stack_can_only_raise_all_in() -> None:
    stacks = seats(6)
    stacks[1] = 150
    state = play(deal(stacks, 2), "S5:f S0:f")
    legal = legal_actions(state)
    assert (legal.can_fold, legal.call, legal.raise_kind) == (True, 100, ActionKind.RAISE)
    assert (legal.min_to, legal.max_to) == (150, 150)
    with pytest.raises(IllegalActionError):
        apply(state, Action.raise_to(140))


def test_7_3_minimum_opening_bet_is_one_big_blind() -> None:
    state = play(deal(seats(3), 0), "S0:c S1:c S2:k")
    legal = legal_actions(state)
    assert (legal.raise_kind, legal.min_to, legal.can_check, legal.can_fold) == (ActionKind.BET, 100, True, False)
    with pytest.raises(IllegalActionError):
        apply(state, Action.bet(99))
    with pytest.raises(IllegalActionError):
        apply(state, Action.raise_to(100))
    with pytest.raises(IllegalActionError):
        apply(state, Action.fold())


def test_7_8_no_raise_when_everyone_else_is_all_in() -> None:
    state = play(deal([STACK, None, 20_000], 0), "S0:a")
    legal = legal_actions(state)
    assert (legal.seat, legal.call, legal.raise_kind) == (2, 9_900, None)
    stacks: list[int | None] = [STACK, None, None, None, None, 60]
    state = deal(stacks, 0)
    legal = legal_actions(state)
    assert (legal.call, legal.raise_kind) == (50, None)


# Section 8 · Incomplete raises and reopening


def test_8_incomplete_raise_does_not_reopen() -> None:
    state = play(deal([STACK, STACK, 250, STACK], 0), "S3:c S0:c S1:c S2:k S1:b100 S2:a")
    assert state.current_bet == 150 and state.min_raise == 100
    legal = legal_actions(state)
    assert (legal.seat, legal.call, legal.min_to) == (3, 150, 250)
    state = play(state, "S3:c S0:f")
    legal = legal_actions(state)
    assert (legal.seat, legal.call, legal.raise_kind) == (1, 50, None)


def test_8_2_incomplete_raises_add_up() -> None:
    state = play(deal([STACK, STACK, 250, 310], 0), "S3:c S0:c S1:c S2:k S1:b100 S2:a S3:a S0:c")
    legal = legal_actions(state)
    assert (legal.seat, legal.call, legal.raise_kind, legal.min_to) == (1, 110, ActionKind.RAISE, 310)


def test_8_1_raiser_cannot_reraise_after_incomplete_raise() -> None:
    state = play(deal([STACK, STACK, STACK, 350], 0), "S3:c S0:c S1:c S2:k S1:b100 S2:r200 S3:a S0:f")
    legal = legal_actions(state)
    assert (legal.seat, legal.raise_kind, legal.min_to) == (1, ActionKind.RAISE, 350)
    state = play(state, "S1:c")
    legal = legal_actions(state)
    assert (legal.seat, legal.call, legal.raise_kind) == (2, 50, None)


# Section 13 · Timeouts


def test_13_timeout_checks_or_folds() -> None:
    state = play(deal(seats(6), 2), "S5:c S0:c S1:c S2:c S3:c S4:k S3:k S4:k S5:k S0:k S1:k")
    assert state.to_act == 2 and timeout_action(state) == Action.check()
    state = play(deal(seats(6), 2), "S5:c S0:c S1:c S2:c S3:c S4:k S3:b100")
    assert timeout_action(state) == Action.fold()
    state = play(deal(seats(6), 2), "S5:c S0:c S1:c S2:c S3:c")
    assert timeout_action(state) == Action.check()
    state = play(deal(seats(6), 2), "S5:c S0:c S1:c S2:c")
    assert timeout_action(state) == Action.fold()


def test_illegal_actions_are_rejected() -> None:
    state = deal(seats(3), 0)
    for bad in (Action.check(), Action.bet(200), Action.raise_to(199), Action.raise_to(10_001), Action(ActionKind.CALL, 100)):
        with pytest.raises(IllegalActionError):
            apply(state, bad)
    over = play(state, "S0:f S1:f")
    with pytest.raises(IllegalActionError):
        legal_actions(over)
    with pytest.raises(IllegalActionError):
        apply(over, Action.check())
