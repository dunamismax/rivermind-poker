"""Nine seats on the six-seat blueprint, option 1 (P5.6, ``docs/bots.md``)."""

from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np
import pytest

from rivermind.bots.blueprint.bundle import ServingBundle, synthetic_bundle
from rivermind.bots.blueprint.nine import (
    ACTIONS,
    ROW_INDEX,
    ROWS,
    SHAPE,
    EarlyTable,
    NineSeatPolicy,
    early_seats,
    export,
    load_policy,
    load_table,
    read_manifest,
    train,
)
from rivermind.bots.blueprint.policy import MultiwayBlueprintPolicy
from rivermind.bots.match import deck_for, describe_policy, evaluate, make_policy, policy_seats
from rivermind.engine import Action, HandConfig, apply, start_hand
from rivermind.engine.view import seat_view

CONFIG = HandConfig(50, 100)


@pytest.fixture(scope="module")
def six(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A synthetic six-seat bundle on the 50 big blind graph."""
    path = tmp_path_factory.mktemp("six") / "bundle"
    synthetic_bundle(path, seed=3, abstraction="6max-s1", depths=(50,))
    return path


def nine_policy(six: Path, weights: np.ndarray | None = None) -> NineSeatPolicy:
    base = ServingBundle(six, verify=False).policy()
    if weights is None:
        weights = np.random.default_rng(1).random(SHAPE)
    return NineSeatPolicy(base.blueprint, base.tables, EarlyTable(weights))


def folding() -> np.ndarray:
    w = np.zeros(SHAPE)
    w[:, :, ACTIONS.index("f")] = 1
    return w


def test_the_early_table_has_a_row_for_every_position_and_what_came_before() -> None:
    # Two depth classes; at 7, 8 and 9 seats one, two and three early seats, each after 4^i contexts.
    assert len(ROWS) == 2 * (1 + (1 + 4) + (1 + 4 + 16))
    assert all(ROW_INDEX[r] == n for n, r in enumerate(ROWS))
    assert SHAPE == (54, 169, 4)
    assert early_seats(tuple(range(9))) == (2, 3, 4) and early_seats(tuple(range(7))) == (2,) and early_seats(tuple(range(6))) == ()


def test_a_nine_seat_hand_whose_early_seats_fold_is_the_six_seat_hand(six: Path) -> None:
    """Once the first three fold, every decision is the six-seat policy's, node for node."""
    nine = nine_policy(six, folding())
    base = ServingBundle(six, verify=False).policy()
    assert type(base) is MultiwayBlueprintPolicy
    to_nine = {0: 0, 1: 1, 2: 2, 3: 6, 4: 7, 5: 8}
    compared = 0
    for deal in range(40):
        rng = random.Random(deal)
        s6 = start_hand(CONFIG, [10_000] * 6, 0, deck=deck_for(0, deal))
        s9 = start_hand(CONFIG, [10_000] * 9, 0, deck=deck_for(1, deal))
        base.new_hand()
        nine.new_hand()
        for _ in range(3):
            s9 = apply(s9, nine.act(seat_view(s9, s9.to_act), rng))  # type: ignore[arg-type]
        assert all(r.kind.value == "fold" for r in s9.actions)
        while not s6.is_over:
            seat = s6.to_act
            assert seat is not None and s9.to_act == to_nine[seat]
            v6, v9 = seat_view(s6, seat), seat_view(s9, to_nine[seat])
            n6 = base._position(v6, base._hand(v6), random.Random(seat))
            n9 = nine._position(v9, nine._hand(v9), random.Random(seat))
            assert n6 == n9 and n6 is not None
            compared += 1
            action = base.act(v6, rng)
            s6, s9 = apply(s6, action), apply(s9, action)
    assert compared > 200
    assert nine.stats["dropped"] == 0 and nine.stats["lost"] == 0


def test_players_are_placed_in_their_order_of_play(six: Path) -> None:
    nine = nine_policy(six)

    def place(seats: int, actions: list[Action]) -> tuple[dict[int, int], frozenset[int]] | None:
        state = start_hand(CONFIG, [10_000] * seats, 0, deck=deck_for(0, 0))
        for a in actions:
            state = apply(state, a)
        return nine.place(seat_view(state, state.to_act))  # type: ignore[arg-type]

    fold, call, raise_to = Action.fold(), Action.call(), Action.raise_to
    # Seven dealt in, the early seat folds: the six-seat seats exactly.
    assert place(7, [fold]) == ({4: 3, 5: 4, 6: 5, 0: 0, 1: 1, 2: 2}, frozenset())
    # Nine, UTG raises and the next two fold: UTG takes the first seat, the lojack to act the next;
    # the hijack, still to act, makes way.
    assert place(9, [raise_to(250), fold, fold]) == ({3: 3, 6: 4, 8: 5, 0: 0, 1: 1, 2: 2}, frozenset())
    # Once the lojack has folded, it makes way instead, and the hijack to act has its seat.
    assert place(9, [raise_to(250), fold, fold, fold]) == ({3: 3, 7: 4, 8: 5, 0: 0, 1: 1, 2: 2}, frozenset())
    # Two early players in and two later folds: four besides the blinds.
    assert place(9, [raise_to(250), call, fold, fold, fold]) == ({3: 3, 4: 4, 8: 5, 0: 0, 1: 1, 2: 2}, frozenset())
    # Five in besides the blinds, with the button to act: no room.
    assert place(9, [call, call, call, call, call, call]) is None


def test_the_nine_seat_policy_plays_full_tables_and_keeps_its_place(six: Path) -> None:
    # Early seats that fold nine hands in ten; the synthetic six-seat strategy is random, so far more
    # players enter than at a real table, where the champion lost its place in 0.2% of decisions.
    weights = np.random.default_rng(1).random(SHAPE)
    weights[:, :, ACTIONS.index("f")] = 9 * weights[:, :, 1:].sum(axis=2)
    nine = nine_policy(six, weights)
    rng = random.Random(4)
    for seats in (7, 8, 9):
        for deal in range(25):
            nine.new_hand()
            state = start_hand(CONFIG, [10_000] * seats, deal % seats, deck=deck_for(seats, deal))
            while not state.is_over:
                state = apply(state, nine.act(seat_view(state, state.to_act), rng))  # type: ignore[arg-type]
    st = nine.stats
    assert st["early"] == 25 * (1 + 2 + 3)
    assert st["lost"] < 0.1 * st["decisions"]
    with pytest.raises(ValueError, match="three to 9"):
        nine._check_table(seat_view(start_hand(CONFIG, [10_000] * 2, 0, deck=deck_for(0, 0)), 0))


def test_training_does_not_depend_on_the_number_of_workers_and_exports_a_bundle(six: Path, tmp_path: Path) -> None:
    runs = [train(tmp_path / f"w{w}", six, batches=2, chunks=3, per_chunk=8, seed=5, workers=w) for w in (1, 2)]
    files = [{f: e["sha256"] for f, e in read_manifest(r, verify=True)["files"].items()} for r in runs]
    assert files[0] == files[1]
    manifest = read_manifest(runs[0])
    assert manifest["iteration"] == 48 and manifest["abstraction"] == "9max-o1" and manifest["seats"] == 9
    sums = np.load(runs[0] / "strategy.npy")
    assert sums.shape == SHAPE and (sums >= 0).all() and sums.sum() > 0
    bundle = export(runs[0], tmp_path / "bundle")
    served = load_table(bundle)
    assert served.weights.dtype == np.uint8 and served.weights.shape == SHAPE
    visited = sums.sum(axis=2) > 0
    assert (served.weights.sum(axis=2)[visited] > 0).all() and (served.weights.sum(axis=2)[~visited] == 0).all()
    assert isinstance(load_policy(bundle), NineSeatPolicy)
    # The model names its six-seat bundle by every file's hash.
    other = tmp_path / "other"
    synthetic_bundle(other, seed=9, abstraction="6max-s1", depths=(50,))
    with pytest.raises(ValueError, match="not the six-seat bundle"):
        load_policy(bundle, six=other)


def test_a_nine_seat_model_is_evaluated_at_nine(six: Path, tmp_path: Path) -> None:
    model = train(tmp_path / "run", six, batches=1, chunks=2, per_chunk=4, workers=1)
    spec = f"nine:{model}"
    assert policy_seats(spec) == 9 and isinstance(make_policy(spec), NineSeatPolicy)
    described = describe_policy(spec)
    assert described["spec"] == "nine" and described["builds_on"]["spec"] == "bundle"
    report = evaluate(spec, [("heuristic", 50)], deals=2, seed=1)
    assert report["game"]["seats"] == 9
    (result,) = report["results"]
    assert result["hands"] == 18
    assert json.loads(json.dumps(report)) == report
