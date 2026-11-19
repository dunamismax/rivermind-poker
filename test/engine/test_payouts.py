"""Table-driven payouts for the fixed hands in fixtures.py (docs/rules.md 9 to 12)."""

from __future__ import annotations

import pytest

from rivermind.engine.pots import build_pots, split, uncalled_bet

from .fixtures import FIXTURES, Fixture
from .helpers import deal, play


def test_there_are_at_least_thirty_fixture_hands() -> None:
    assert len(FIXTURES) >= 30
    assert len({f.name for f in FIXTURES}) == len(FIXTURES)


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda f: f.name)
def test_fixture_hand(fixture: Fixture) -> None:
    state = play(
        deal(fixture.stacks, fixture.button, fixture.holes, fixture.board, fixture.config),
        fixture.script,
    )
    assert state.is_over, "the script should finish the hand"
    result = state.result
    assert result is not None
    assert state.final_stacks == fixture.final
    assert sum(s or 0 for s in fixture.final) == sum(s or 0 for s in fixture.stacks)
    assert sum(result.winnings) == sum(p.amount for p in result.pots)
    if fixture.pots is not None:
        assert [(p.amount, p.winners) for p in result.pots] == list(fixture.pots)
        for pot in result.pots:
            assert sum(pot.shares) == pot.amount
    assert result.uncalled == fixture.uncalled
    if fixture.shown is not None:
        assert result.shown == fixture.shown
    if fixture.mucked is not None:
        assert result.mucked == fixture.mucked
    if fixture.tabled is not None:
        assert result.tabled == fixture.tabled


def test_9_2_side_pot_table() -> None:
    # A 100, B 300, C 600, D 600, E 200; E folded.
    pots = build_pots([100, 300, 600, 600, 200], live=[0, 1, 2, 3])
    assert [(p.amount, p.eligible) for p in pots] == [(500, (0, 1, 2, 3)), (700, (1, 2, 3)), (600, (2, 3))]


def test_9_1_uncalled_counts_folded_players() -> None:
    assert uncalled_bet([50, 100, 0]) == (1, 50)
    assert uncalled_bet([1000, 400, 50, 100]) == (0, 600)
    assert uncalled_bet([300, 300, 100]) is None


def test_11_2_odd_chip_examples() -> None:
    assert split(301, [2, 5], button=4, num_seats=6) == ((5, 2), (151, 150))
    assert split(100, [1, 3, 6], button=6, num_seats=9) == ((1, 3, 6), (34, 33, 33))
