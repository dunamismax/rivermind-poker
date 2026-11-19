"""Hand histories and serialization (P2.5)."""

from __future__ import annotations

import random

import pytest

from rivermind.engine import Action, HandConfig, apply, legal_actions, start_hand
from rivermind.engine.cards import pretty
from rivermind.engine.fuzz import play_random_hand
from rivermind.engine.history import (
    FORMAT,
    FormatError,
    dumps,
    format_text,
    hand_record,
    history_from_dict,
    history_of,
    history_to_dict,
    loads,
    replay,
    replay_record,
    state_from_dict,
    state_to_dict,
)

from .fixtures import FIXTURES, Fixture
from .helpers import deal, parse_action


def states_of(fixture: Fixture):  # type: ignore[no-untyped-def]
    state = deal(fixture.stacks, fixture.button, fixture.holes, fixture.board, fixture.config)
    yield state
    for token in fixture.script.split():
        state = apply(state, parse_action(state, token.partition(":")[2]))
        yield state


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda f: f.name)
def test_fixture_states_round_trip_and_replay(fixture: Fixture) -> None:
    for state in states_of(fixture):
        document = loads(dumps(state_to_dict(state)))
        assert document["format"] == FORMAT
        assert state_from_dict(document) == state
        assert replay(history_from_dict(loads(dumps(history_to_dict(history_of(state)))))) == state
    record = loads(dumps(hand_record(state)))
    assert replay_record(record) == state
    format_text(state)
    for seat, stack in enumerate(state.starting_stacks):
        if stack:
            format_text(state, viewer=seat)


def test_fuzzed_hands_round_trip_and_replay() -> None:
    rng = random.Random("history")
    for i in range(400):
        state = play_random_hand(2 + i % 8, rng, check_illegal=False)
        assert state_from_dict(loads(dumps(state_to_dict(state)))) == state
        assert replay_record(loads(dumps(hand_record(state)))) == state
        format_text(state, viewer=state.button)


def test_in_progress_hand_round_trips() -> None:
    state = start_hand(HandConfig(50, 100, ante=5), [1_000, 2_000, None, 3_000], 3, rng=random.Random(1))
    state = apply(state, Action.raise_to(300))
    assert state_from_dict(state_to_dict(state)) == state
    resumed = state_from_dict(loads(dumps(state_to_dict(state))))
    assert apply(resumed, Action.call()) == apply(state, Action.call())
    assert "in progress" in format_text(state)


def test_unknown_format_and_kind_are_rejected() -> None:
    state = deal([10_000, 10_000], 0)
    document = state_to_dict(state)
    with pytest.raises(FormatError):
        state_from_dict({**document, "format": FORMAT + 1})
    with pytest.raises(FormatError):
        history_from_dict(document)
    with pytest.raises(FormatError):
        state_from_dict({**document, "deck": ["Zz"] * 52})
    with pytest.raises(FormatError):
        loads("[]")


def test_tampered_record_fails_replay() -> None:
    fixture = next(f for f in FIXTURES if f.name == "kicker decides heads-up")
    *_, state = states_of(fixture)
    record = hand_record(state)
    record["final_stacks"] = list(reversed(record["final_stacks"]))
    with pytest.raises(FormatError):
        replay_record(record)


def test_text_history_reads_like_a_hand_and_hides_mucked_cards() -> None:
    fixture = next(f for f in FIXTURES if f.name == "river bettor shows first and a loser mucks")
    *_, state = states_of(fixture)
    text = format_text(state)
    assert text.splitlines()[:2] == [
        "RiverMind Poker · No-limit hold'em · 6 seats · Blinds 50/100",
        "Button S0 · Small blind S1 · Big blind S3",
    ]
    for line in (
        "S1 posts the small blind 50",
        "S5 calls 100",
        "*** Flop *** 2♣ 7♦ 9♥",
        "*** River *** 2♣ 7♦ 9♥ J♠ · 3♠",
        "S1 bets 200",
        "S1 shows 9♣ 7♣ (Two Pair)",
        "S3 mucks J♦ 4♦",
        "S5 shows 8♣ T♦ (Straight)",
        "Pot 900: S5 wins 900",
        "Final stacks: S0 10,000 · S1 9,700 · S3 9,700 · S5 10,600",
    ):
        assert line in text.splitlines()
    for viewer in (0, 1, 5):
        seen = format_text(state, viewer)
        assert "S3 mucks" in seen.splitlines()
        assert pretty(state.hole_cards[3][0]) + " " + pretty(state.hole_cards[3][1]) not in seen  # type: ignore[index]
        assert "4♥ 5♠" not in seen if viewer != 0 else "4♥ 5♠" in seen
    assert "J♦ 4♦" in format_text(state, 3)


def test_tabled_hands_appear_before_the_runout() -> None:
    fixture = next(f for f in FIXTURES if f.name == "heads-up all-in pre-flop is tabled")
    *_, state = states_of(fixture)
    lines = format_text(state, viewer=0).splitlines()
    tabled = lines.index("*** All in: hands shown ***")
    assert tabled < next(i for i, line in enumerate(lines) if line.startswith("*** Flop ***"))
    assert "S5 shows A♥ A♦" in lines


def test_legal_actions_unchanged_after_round_trip() -> None:
    state = start_hand(HandConfig(5, 10), [500, 80, 900], 0, rng=random.Random(4))
    assert legal_actions(state_from_dict(state_to_dict(state))) == legal_actions(state)
