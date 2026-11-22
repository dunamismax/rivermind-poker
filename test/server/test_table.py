"""The table core (P3.2): seating, buy-ins, sitting out, leaving and the button.

The button and blind cases are the worked examples of ``docs/rules.md``
section 5 and rules 2.2 and 2.3, played through ``Table``.
"""

from __future__ import annotations

import random

import pytest

from rivermind.engine import Action, card_str, legal_actions
from rivermind.server import ErrorCode, Table, TableConfig, TableError

CONFIG = TableConfig(seat_count=9, small_blind=50, big_blind=100)


def table_with(seats: list[int], config: TableConfig = CONFIG, stack: int = 10_000) -> Table:
    table = Table(config)
    for seat in seats:
        table.sit(seat, f"p{seat}", f"Player {seat}", stack)
    table.drain_events()
    return table


def finish(table: Table) -> None:
    """Play the hand out with everyone checking or folding."""
    while table.hand_in_progress:
        table.time_out()


def check_down(table: Table) -> None:
    """Play the hand out with everyone checking or calling."""
    while table.hand_in_progress:
        assert table.hand is not None
        legal = legal_actions(table.hand)
        table.act_seat(legal.seat, Action.check() if legal.can_check else Action.call())


def chips(table: Table) -> int:
    return sum(table.stack_of(seat) for seat, _ in table.players()) + (
        table.hand.pot if table.hand_in_progress and table.hand is not None else 0
    )


def test_config_defaults_and_validation() -> None:
    assert (CONFIG.min_buy_in, CONFIG.max_buy_in) == (4_000, 10_000)
    custom = TableConfig(6, 5, 10, ante=1, min_buy_in=200, max_buy_in=2_000)
    assert custom.hand_config.ante == 1
    for bad in (
        dict(seat_count=1, small_blind=50, big_blind=100),
        dict(seat_count=10, small_blind=50, big_blind=100),
        dict(seat_count=6, small_blind=100, big_blind=50),
        dict(seat_count=6, small_blind=50, big_blind=100, ante=-1),
        dict(seat_count=6, small_blind=50, big_blind=100, min_buy_in=500, max_buy_in=400),
    ):
        with pytest.raises(ValueError):
            TableConfig(**bad)  # type: ignore[arg-type]


def test_sitting_down_checks_seat_player_and_buy_in() -> None:
    table = table_with([0])
    cases = [
        ((9, "x", "X", 5_000), ErrorCode.UNKNOWN_SEAT),
        ((0, "x", "X", 5_000), ErrorCode.SEAT_TAKEN),
        ((1, "p0", "Again", 5_000), ErrorCode.ALREADY_SEATED),
        ((1, "x", "X", 3_999), ErrorCode.BAD_BUY_IN),
        ((1, "x", "X", 10_001), ErrorCode.BAD_BUY_IN),
        ((1, "x", "X", 0), ErrorCode.BAD_BUY_IN),
        ((1, "", "X", 5_000), ErrorCode.BAD_REQUEST),
    ]
    for args, code in cases:
        with pytest.raises(TableError) as caught:
            table.sit(*args)
        assert caught.value.code is code
    assert table.drain_events() == []  # refused requests change nothing
    table.sit(1, "x", "X", 4_000)
    (event,) = table.drain_events()
    assert (event.kind, event.data["seat"], event.data["stack"]) == ("seated", 1, 4_000)


def test_hands_start_only_with_two_players_dealt_in() -> None:
    table = table_with([3])
    assert not table.can_start()
    with pytest.raises(TableError):
        table.start_hand(random.Random(0))
    table.sit(7, "p7", "Player 7", 5_000)
    assert table.can_start()
    table.sit_out("p7")
    assert not table.can_start()
    table.sit_in("p7")
    state = table.start_hand(random.Random(0))
    assert sorted(s for s in range(9) if state.dealt_in[s]) == [3, 7]
    assert not table.can_start()  # a hand is in progress
    with pytest.raises(TableError) as caught:
        table.start_hand(random.Random(0))
    assert caught.value.code is ErrorCode.HAND_IN_PROGRESS


def test_first_button_is_random_among_players_dealt_in() -> None:
    buttons = set()
    for seed in range(40):
        table = table_with([1, 4, 6])
        buttons.add(table.start_hand(random.Random(seed)).button)
    assert buttons == {1, 4, 6}


def test_button_moves_and_blinds_follow_rule_5_2() -> None:
    """Rules example (seats emptying), first case: S0 to S5, button on S1."""
    table = table_with([0, 1, 2, 3, 4, 5])
    table.button = 1
    state = table.start_hand(random.Random(0))
    assert (state.button, state.small_blind_seat, state.big_blind_seat) == (2, 3, 4)
    finish(table)
    state = table.start_hand(random.Random(1))
    assert (state.button, state.small_blind_seat, state.big_blind_seat) == (3, 4, 5)


def test_button_skips_a_seat_that_emptied() -> None:
    """Rules example (seats emptying): S2 has left, so the button goes to S3."""
    table = table_with([0, 1, 2, 3, 4, 5])
    table.button = 1
    table.leave("p2")
    state = table.start_hand(random.Random(0))
    assert (state.button, state.small_blind_seat, state.big_blind_seat) == (3, 4, 5)


def test_a_player_sitting_out_neither_posts_nor_plays() -> None:
    """Rules example (seats emptying): S4 sitting out, so the big blind is S5."""
    table = table_with([0, 1, 2, 3, 4, 5])
    table.button = 1
    table.sit_out("p4")
    state = table.start_hand(random.Random(0))
    assert (state.button, state.small_blind_seat, state.big_blind_seat) == (2, 3, 5)
    assert not state.dealt_in[4]
    assert all(post.seat != 4 for post in state.posts)


def test_a_new_player_is_dealt_in_next_hand_without_posting() -> None:
    """Rules example (seats filling) and rule 2.2."""
    table = table_with([0, 1, 2, 3, 4, 5])
    table.button = 0
    table.start_hand(random.Random(0))  # button S1
    table.sit(7, "p7", "Player 7", 5_000)
    assert table.hand is not None and not table.hand.dealt_in[7]
    finish(table)
    state = table.start_hand(random.Random(1))
    assert (state.button, state.small_blind_seat, state.big_blind_seat) == (2, 3, 4)
    assert state.dealt_in[7]
    assert all(post.seat != 7 for post in state.posts)
    for _ in range(2):
        finish(table)
        state = table.start_hand(random.Random(2))
    assert state.big_blind_seat == 7  # S7 first posts when its turn comes (here after S5)


def test_going_heads_up_after_a_player_busts() -> None:
    """Rules example (to heads-up): S5 is out of chips, so S3 is the button and small blind."""
    table = table_with([1, 3, 5])
    table.button = 0
    table.start_hand(random.Random(0))
    assert table.button == 1
    finish(table)
    player = table.seats[5]
    assert player is not None
    player.stack = 0  # as if S5 had lost every chip
    state = table.start_hand(random.Random(1))
    assert (state.button, state.small_blind_seat, state.big_blind_seat) == (3, 3, 1)
    assert table.seats[5] is not None  # a busted player keeps the seat and can rebuy


def test_leaving_during_a_hand_folds_at_each_turn_and_frees_the_seat_after() -> None:
    """Rule 2.3: the player folds when their turn comes; chips in the pot stay there."""
    table = table_with([0, 1, 2])
    table.button = 2
    state = table.start_hand(random.Random(0))
    # Button S0, small blind S1, big blind S2: S0 acts first pre-flop.
    assert (state.button, state.to_act) == (0, 0)
    table.act_seat(0, Action.call())
    assert table.leave("p1") is None  # the small blind leaves mid-hand
    assert table.seats[1] is not None and table.seats[1].leaving
    # It was S1's turn, so S1 folded at once and the big blind is to act.
    assert table.hand is not None and table.hand.folded[1]
    assert table.to_act == 2
    with pytest.raises(TableError) as caught:
        table.sit(1, "x", "X", 5_000)
    assert caught.value.code is ErrorCode.SEAT_TAKEN  # freed only when the hand ends
    check_down(table)
    assert table.seats[1] is None
    (departure,) = table.drain_departures()
    assert (departure.player_id, departure.seat, departure.chips) == ("p1", 1, 10_000 - 50)
    assert table.stack_of(0) + table.stack_of(2) == 20_050


def test_leaving_folds_later_turns_but_checks_when_free() -> None:
    table = table_with([0, 1, 2])
    table.button = 2
    table.start_hand(random.Random(0))  # button S0, blinds S1 and S2
    table.act_seat(0, Action.call())
    table.act_seat(1, Action.call())
    table.leave("p0")  # S0 has acted; its turn comes again on the flop
    hand = table.hand
    assert hand is not None and not hand.folded[0]
    table.act_seat(2, Action.check())  # the big blind's option ends pre-flop
    table.act_seat(1, Action.check())
    table.act_seat(2, Action.check())
    hand = table.hand
    assert hand is not None
    # S0 checked on the flop when its turn came, since checking was free.
    flop = [a for a in hand.actions if a.street.label == "flop"]
    assert [(a.seat, a.kind.value) for a in flop] == [(1, "check"), (2, "check"), (0, "check")]
    assert hand.street.label == "turn"
    table.act_seat(1, Action.bet(200))
    table.act_seat(2, Action.call())
    hand = table.hand
    assert hand is not None and hand.folded[0]  # facing a bet, S0 folded
    check_down(table)
    assert table.seats[0] is None
    assert table.drain_departures()[0].chips == 10_000 - 100


def test_leaving_between_hands_or_while_folded_out() -> None:
    table = table_with([0, 1, 2])
    departure = table.leave("p2")
    assert departure is not None and departure.chips == 10_000 and table.seats[2] is None
    with pytest.raises(TableError) as caught:
        table.leave("p2")
    assert caught.value.code is ErrorCode.NOT_SEATED


def test_sitting_out_mid_hand_applies_when_it_ends() -> None:
    table = table_with([0, 1, 2])
    table.start_hand(random.Random(3))
    table.sit_out("p0")
    player = table.seats[0]
    assert player is not None and player.sit_out_next and not player.sitting_out
    assert table.hand is not None and not table.hand.folded[0]
    finish(table)
    assert player.sitting_out
    state = table.start_hand(random.Random(4))
    assert not state.dealt_in[0]
    table.sit_in("p0")
    finish(table)
    assert table.start_hand(random.Random(5)).dealt_in[0]


def test_sitting_in_before_the_hand_ends_cancels_sitting_out() -> None:
    table = table_with([0, 1])
    table.start_hand(random.Random(0))
    table.sit_out("p1")
    table.sit_in("p1")
    finish(table)
    player = table.seats[1]
    assert player is not None and not player.sitting_out


def test_rebuys_keep_the_stack_in_the_buy_in_range() -> None:
    table = table_with([0, 1], stack=4_000)
    table.rebuy("p0", 6_000)
    assert table.stack_of(0) == 10_000
    for amount in (1, 0, -5):
        with pytest.raises(TableError) as caught:
            table.rebuy("p0", amount)
        assert caught.value.code is ErrorCode.BAD_BUY_IN
    player = table.seats[1]
    assert player is not None
    player.stack = 1_000  # as if the player had lost most of their chips
    with pytest.raises(TableError):
        table.rebuy("p1", 2_000)  # 3,000 is below the minimum buy-in
    table.rebuy("p1", 3_000)
    assert table.stack_of(1) == 4_000


def test_a_rebuy_during_a_hand_is_added_when_it_ends() -> None:
    table = table_with([0, 1], stack=5_000)
    table.start_hand(random.Random(0))
    table.rebuy("p0", 2_000)
    assert table.stack_of(0) < 5_000  # blinds posted; the rebuy has not arrived
    with pytest.raises(TableError):
        table.rebuy("p0", 4_000)  # would pass the maximum
    finish(table)
    assert table.stack_of(0) + table.stack_of(1) == 12_000
    kinds = [e.kind for e in table.drain_events()]
    assert "rebuy_pending" in kinds and kinds[-1] == "rebought"


def test_what_a_seat_has_put_into_the_hand_is_known_until_it_ends() -> None:
    table = table_with([0, 1], stack=5_000)
    assert table.in_pot_of(0) == table.in_pot_of(1) == 0  # no hand yet
    table.start_hand(random.Random(0))
    # The blinds are in: each seat's stack and what it has put in are what it sat down with.
    assert sorted(table.in_pot_of(seat) for seat in (0, 1)) == [50, 100]
    for seat in (0, 1):
        assert table.stack_of(seat) + table.in_pot_of(seat) == 5_000
    finish(table)
    assert table.in_pot_of(0) == table.in_pot_of(1) == 0  # paid out with the hand


def test_a_pending_rebuy_is_fitted_to_the_maximum() -> None:
    table = table_with([0, 1], stack=9_000)
    table.button = 1
    table.start_hand(random.Random(0))  # button S0 posts 50, S1 posts 100
    table.rebuy("p1", 1_000)
    finish(table)  # S0 folds; S1 wins the small blind and is at 9,050
    assert table.stack_of(1) == 10_000


def test_only_the_seat_to_act_may_act() -> None:
    table = table_with([0, 1, 2])
    with pytest.raises(TableError) as caught:
        table.act("p0", Action.check())
    assert caught.value.code is ErrorCode.HAND_OVER
    state = table.start_hand(random.Random(0))
    other = next(s for s in (0, 1, 2) if s != state.to_act)
    with pytest.raises(TableError) as caught:
        table.act(f"p{other}", Action.call())
    assert caught.value.code is ErrorCode.NOT_YOUR_TURN
    with pytest.raises(TableError) as caught:
        table.act(f"p{state.to_act}", Action.check())  # facing the big blind
    assert caught.value.code is ErrorCode.ILLEGAL_ACTION
    with pytest.raises(TableError) as caught:
        table.act("nobody", Action.call())
    assert caught.value.code is ErrorCode.NOT_SEATED


def test_events_are_numbered_and_never_reveal_unshown_cards() -> None:
    table = table_with([0, 1, 2])
    table.start_hand(random.Random(7))
    check_down(table)
    events = table.drain_events()
    assert [e.seq for e in events] == list(range(events[0].seq, events[0].seq + len(events)))
    kinds = [e.kind for e in events]
    assert kinds[0] == "hand_started" and kinds[-1] == "hand_ended"
    assert kinds.count("board") == 3
    state = table.hand
    assert state is not None and state.result is not None
    text = repr([e.data for e in events if e.kind != "hand_ended"])
    for seat in range(3):
        hole = state.hole_cards[seat]
        assert hole is not None
        for c in hole:
            assert f"'{card_str(c)}'" not in text
    (ended,) = [e for e in events if e.kind == "hand_ended"]
    assert {s["seat"] for s in ended.data["shown"]} == set(state.result.shown)


@pytest.mark.parametrize("seat_count", [2, 3, 6, 9])
def test_chips_are_conserved_through_random_seating_and_play(seat_count: int) -> None:
    """Players come and go, sit out, rebuy and act at random; no chip appears or vanishes.

    Seen from the wallets (P4.2): every accepted buy-in and rebuy is paid
    when it is asked for, and every departure pays chips back. What was
    paid minus what went back always equals the chips at the table plus
    the rebuys still waiting for a hand to end.
    """
    rng = random.Random(seat_count)
    config = TableConfig(seat_count, 5, 10, ante=rng.choice((0, 1)))
    table = Table(config)
    paid = removed = 0
    next_id = 0
    hands = 0
    for _ in range(4_000):
        roll = rng.random()
        seated = [p.player_id for _, p in table.players()]
        try:
            if roll < 0.08:
                next_id += 1
                amount = rng.randint(config.min_buy_in, config.max_buy_in)
                table.sit(rng.randrange(seat_count), f"n{next_id}", "N", amount)
                paid += amount
            elif roll < 0.11 and seated:
                table.leave(rng.choice(seated))
            elif roll < 0.14 and seated:
                table.sit_out(rng.choice(seated))
            elif roll < 0.2 and seated:
                table.sit_in(rng.choice(seated))
            elif roll < 0.24 and seated:
                amount = rng.randint(1, config.max_buy_in)
                table.rebuy(rng.choice(seated), amount)
                paid += amount
            elif table.hand_in_progress:
                assert table.hand is not None
                legal = legal_actions(table.hand)
                table.act_seat(legal.seat, rng.choice(legal.options()))
            elif table.can_start():
                table.start_hand(rng)
                hands += 1
        except TableError:
            pass
        for event in table.drain_events():
            if event.kind == "left":
                removed += event.data["stack"]
        assert removed == sum(d.chips for d in table.departures if d.left)
        waiting = sum(p.pending_rebuy for _, p in table.players())
        assert chips(table) + waiting == paid - sum(d.chips for d in table.departures)
        for _, player in table.players():
            assert player.stack >= 0  # stacks may pass the maximum buy-in by winning
    assert hands > 50
    assert any(not d.left for d in table.departures)  # some waiting rebuys went back
