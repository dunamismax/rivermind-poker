"""Property tests and a short self-play fuzz run (P2.4).

The long fuzz run is ``python -m rivermind.engine.fuzz --hands 100000``.
"""

from __future__ import annotations

import random

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from rivermind.engine import (
    Action,
    ActionKind,
    HandConfig,
    IllegalActionError,
    apply,
    legal_actions,
    start_hand,
)
from rivermind.engine.fuzz import check_state, illegal_near, play_random_hand, run


@st.composite
def hands(draw: st.DrawFn) -> tuple[HandConfig, list[int | None], int, int]:
    num_seats = draw(st.integers(2, 9))
    small = draw(st.integers(1, 100))
    big = draw(st.integers(small, 2 * small))
    ante = draw(st.sampled_from([0, 0, draw(st.integers(1, big))]))
    stack = st.one_of(st.none(), st.integers(1, 3 * big), st.integers(big, 200 * big))
    stacks = draw(st.lists(stack, min_size=num_seats, max_size=num_seats).filter(lambda s: sum(1 for x in s if x) >= 2))
    button = draw(st.sampled_from([i for i, s in enumerate(stacks) if s]))
    seed = draw(st.integers(0, 2**32 - 1))
    return HandConfig(small, big, ante), stacks, button, seed


@settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(hand=hands(), data=st.data())
def test_random_legal_play_keeps_every_invariant(
    hand: tuple[HandConfig, list[int | None], int, int], data: st.DataObject
) -> None:
    config, stacks, button, seed = hand
    state = start_hand(config, stacks, button, rng=random.Random(seed))
    total = sum(s or 0 for s in stacks)
    check_state(state, total)
    for _ in range(4_000):
        if state.is_over:
            break
        legal = legal_actions(state)
        for bad in illegal_near(state, legal):
            with pytest.raises(IllegalActionError):
                apply(state, bad)
        options = list(legal.options())
        action = data.draw(st.sampled_from(options))
        if action.kind in (ActionKind.BET, ActionKind.RAISE):
            action = Action(action.kind, data.draw(st.integers(legal.min_to, legal.max_to)))
        before = state
        state = apply(state, action)
        assert state == apply(before, action), "apply is deterministic and leaves its input unchanged"
        check_state(state, total)
    assert state.is_over, "every hand ends"
    assert sum(state.stacks) == total


@settings(max_examples=200, deadline=None)
@given(hand=hands(), kind=st.sampled_from(list(ActionKind)), amount=st.one_of(st.none(), st.integers(-10, 10**6)))
def test_anything_outside_legal_actions_is_rejected(
    hand: tuple[HandConfig, list[int | None], int, int], kind: ActionKind, amount: int | None
) -> None:
    config, stacks, button, seed = hand
    state = start_hand(config, stacks, button, rng=random.Random(seed))
    if state.is_over:
        return
    action = Action(kind, amount)
    if legal_actions(state).allows(action):
        apply(state, action)
    else:
        with pytest.raises(IllegalActionError):
            apply(state, action)


@pytest.mark.parametrize("num_seats", range(2, 10))
def test_short_fuzz_every_seat_count(num_seats: int) -> None:
    rng = random.Random(f"ci:{num_seats}")
    for _ in range(300):
        play_random_hand(num_seats, rng)


def test_fuzz_report_counts_hands() -> None:
    report = run(20, [2, 9], seed=3)
    counts = report["seat_counts"]
    assert isinstance(counts, dict)
    for seat_count in ("2", "9"):
        assert counts[seat_count]["showdown"] + counts[seat_count]["fold_out"] == 20
    assert report["failures"] == 0
