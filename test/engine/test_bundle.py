"""Serving bundles (P4B.6): export, read-back and the bots' differential reference.

The TypeScript side is checked by ``pnpm bots:parity`` and
``web/src/lib/server/bots/bots.spec.ts``. These tests build a small fake
table set and checkpoint, so they need neither the real tables nor training.
"""

from __future__ import annotations

import hashlib
import io
import json
import random
from dataclasses import asdict
from pathlib import Path

import numpy as np
import pytest
from click.testing import CliRunner

from poker_ai.cli.runner import cli
from rivermind.bots.blueprint import Game, Settings, compile_tree
from rivermind.bots.blueprint.bundle import (
    BundleError,
    ServingBundle,
    quantize,
    synthetic_bundle,
    table_set_digest,
)
from rivermind.bots.blueprint.policy import BlueprintPolicy
from rivermind.bots.cards import CardTables
from rivermind.bots.cards.build import FORMAT as TABLE_FORMAT
from rivermind.bots.cards.build import KIND as TABLE_KIND
from rivermind.bots.cards.build import file_hashes
from rivermind.bots.differential import bucket_report, write_blueprint, write_policies
from rivermind.engine import Action, HandConfig, apply, start_hand
from rivermind.engine.history import hand_record, loads, replay_record
from rivermind.engine.view import seat_view

BUCKETS = (169, 3, 3, 3)
BOARDS = {"flop": 22_100, "turn": 270_725, "river": 2_598_960}


def fake_tables(path: Path, seed: int = 0) -> CardTables:
    """A format-1 table set of 3 buckets a street, each board in one of 4 classes."""
    rng = np.random.default_rng(seed)
    path.mkdir(parents=True)
    np.save(path / "preflop.npy", rng.integers(0, 169, 1326).astype(np.uint16))
    for street, boards in BOARDS.items():
        np.save(path / f"{street}_board_class.npy", rng.integers(0, 4, boards).astype(np.int32))
        np.save(path / f"{street}_board_perm.npy", rng.integers(0, 24, boards).astype(np.uint8))
        np.save(path / f"{street}.npy", rng.integers(0, 3, (4, 1326)).astype(np.uint16))
    manifest = {
        "format": TABLE_FORMAT,
        "kind": TABLE_KIND,
        "settings": {"abstraction": "hu-m1", "flop_buckets": 3, "turn_buckets": 3, "river_buckets": 3, "seed": seed},
        "classes": {"flop": 4, "turn": 4, "river": 4},
        "files": file_hashes(path),
    }
    (path / "manifest.json").write_text(json.dumps(manifest))
    return CardTables(path, verify=True)


def fake_checkpoint(path: Path, tables: CardTables, seed: int = 0) -> Game:
    """A checkpoint of the hu-m1 trees on ``tables`` with random sums and some untrained info sets."""
    rng = np.random.default_rng(seed)
    trees = (compile_tree(50), compile_tree(100))
    game = Game(trees, BUCKETS)
    sums = rng.random(game.size) * 1e6
    sums[rng.random(game.size) < 0.2] = 0
    path.mkdir(parents=True)
    np.save(path / "strategy.npy", sums)
    np.save(path / "regrets.npy", np.zeros(game.size, dtype=np.int32))
    files = {}
    for name in ("strategy.npy", "regrets.npy"):
        files[name] = {"sha256": hashlib.sha256((path / name).read_bytes()).hexdigest(), "bytes": (path / name).stat().st_size}
    manifest = {
        "format": 1,
        "kind": "rivermind-blueprint-checkpoint",
        "abstraction": "hu-m1",
        "iteration": 1000,
        "batch": 1,
        "settings": asdict(Settings()),
        "game": game.describe(),
        "cards": {"kind": "card-tables", "path": str(tables.path), "abstraction": "hu-m1", "seed": seed, "sha256": tables.sha256},
        "engine": {"version": "test"},
        "files": files,
    }
    (path / "manifest.json").write_text(json.dumps(manifest))
    return game


@pytest.fixture(scope="module")
def exported(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path, Path]:
    root = tmp_path_factory.mktemp("bundle")
    tables = fake_tables(root / "tables")
    fake_checkpoint(root / "checkpoint", tables)
    result = CliRunner().invoke(cli, ["blueprint", "export", str(root / "checkpoint"), "--out", str(root / "bundle")])
    assert result.exit_code == 0, result.output
    return root / "checkpoint", root / "tables", root / "bundle"


def test_quantizing_keeps_each_info_set_a_distribution() -> None:
    game = Game((compile_tree(50),), (1, 1, 1, 1))
    rng = np.random.default_rng(1)
    sums = rng.random(game.size)
    tree = game.trees[0]
    untrained = game.slot(0, 3, 0)
    sums[untrained : untrained + len(tree.tokens[3])] = 0
    q = quantize(game, sums)
    for v in range(len(tree)):
        first = game.slot(0, v, 0)
        n = len(tree.tokens[v])
        row, served = sums[first : first + n], q[first : first + n].astype(np.int64)
        if row.sum() == 0:
            assert served.sum() == 0
            continue
        assert abs(int(served.sum()) - 255) <= n  # each rounding moves at most half a level
        assert np.all(np.abs(served / 255 - row / row.sum()) <= 0.5 / 255 + 1e-12)


def test_the_export_carries_the_checkpoint_and_its_tables(exported: tuple[Path, Path, Path]) -> None:
    checkpoint, tables_path, path = exported
    manifest = json.loads((path / "manifest.json").read_text())
    tables = CardTables(tables_path)
    assert manifest["kind"] == "rivermind-serving-bundle" and manifest["checkpoint"]["iteration"] == 1000
    assert manifest["cards"]["table_set"] == table_set_digest(tables.sha256)
    assert manifest["cards"]["sha256"] == tables.sha256
    assert sorted(manifest["files"]) == sorted(p.name for p in path.iterdir() if p.name != "manifest.json")
    bundle = ServingBundle(path, table_set=table_set_digest(tables.sha256))
    sums = np.load(checkpoint / "strategy.npy")
    assert np.array_equal(np.asarray(bundle.strategy), quantize(bundle.game, sums))
    rng = random.Random(0)
    for _ in range(2_000):
        dealt = rng.sample(range(52), 7)
        hole, board = dealt[:2], dealt[2 : 2 + rng.choice((0, 3, 4, 5))]
        assert bundle.tables.bucket(hole, board) == tables.bucket(hole, board)
    assert bucket_report(bundle.tables, 20, 0) == bucket_report(tables, 20, 0)


def test_a_damaged_or_mismatched_bundle_is_refused(exported: tuple[Path, Path, Path], tmp_path: Path) -> None:
    _, _, path = exported
    with pytest.raises(BundleError, match="table set"):
        ServingBundle(path, table_set="0" * 64)
    copy = tmp_path / "copy"
    copy.mkdir()
    for f in path.iterdir():
        (copy / f.name).write_bytes(f.read_bytes())
    with (copy / "strategy.u8").open("r+b") as f:
        f.write(b"\x07")
    with pytest.raises(BundleError, match="strategy.u8"):
        ServingBundle(copy)
    # Exporting again refuses to overwrite, and other tables are refused.
    runner = CliRunner()
    again = runner.invoke(cli, ["blueprint", "export", str(exported[0]), "--out", str(path)])
    assert again.exit_code != 0 and "already exists" in again.output
    other = fake_tables(tmp_path / "other", seed=1)
    wrong = runner.invoke(cli, ["blueprint", "export", str(exported[0]), "--out", str(tmp_path / "b"), "--tables", str(other.path)])
    assert wrong.exit_code != 0 and "not the ones" in wrong.output


def test_the_bundle_plays_what_the_checkpoint_would_round_to(exported: tuple[Path, Path, Path]) -> None:
    _, _, path = exported
    bot = BlueprintPolicy.from_bundle(path)
    state = start_hand(HandConfig(50, 100), [10_000, 10_000], 0, deck=list(range(52)))
    rng = random.Random(0)
    while not state.is_over:
        seat = state.to_act
        assert seat is not None
        action = bot.act(seat_view(state, seat), rng)
        if bot.last_probabilities is not None:
            assert sum(bot.last_probabilities) == pytest.approx(1)
        state = apply(state, action)
    assert bot.stats["decisions"] >= 2 and "lost" not in bot.stats


def test_the_blueprint_plays_its_tree_from_either_seat_on_the_button(exported: tuple[Path, Path, Path]) -> None:
    _, _, path = exported
    bot = BlueprintPolicy.from_bundle(path)
    for stacks, button in (([10_000, 10_000], 1), ([None, 10_000, 10_000], 2), ([10_000, None, 10_000], 0)):
        state = start_hand(HandConfig(50, 100), stacks, button, deck=list(range(52)))
        assert state.to_act == button
        while not state.is_over:
            seat = state.to_act
            assert seat is not None
            state = apply(state, bot.act(seat_view(state, seat), random.Random(1)))
    assert "lost" not in bot.stats and bot.stats["trained"] + bot.stats["borrowed"] + bot.stats["untrained_node"] == bot.stats["decisions"]
    # The button acts first before the flop whichever seat it is in, and its open is the tree's.
    button_one = start_hand(HandConfig(50, 100), [10_000, 10_000], 1, deck=list(range(52)))
    assert bot.act(seat_view(button_one, 1), random.Random(0)) in (
        Action.fold(),
        Action.call(),
        Action.raise_to(250),
        Action.raise_to(400),
        Action.raise_to(10_000),
    )


def test_the_differential_reference_repeats_and_replays(tmp_path: Path) -> None:
    out, again = io.StringIO(), io.StringIO()
    write_policies(out, 5, [2, 6, 9], 3)
    write_policies(again, 5, [2, 6, 9], 3)
    assert out.getvalue() == again.getvalue()
    for line in out.getvalue().splitlines():
        meta, record = line.split("\t")
        assert len(json.loads(meta)["bots"]) in (2, 6, 9)
        assert json.dumps(hand_record(replay_record(loads(record))), separators=(",", ":"), sort_keys=True) == record
    synthetic_bundle(tmp_path / "syn", seed=2)
    hands = io.StringIO()
    assert write_blueprint(hands, tmp_path / "syn", 50, 0) > 0
    decisions = sum(len(json.loads(line.split("\t")[0])["probabilities"]) for line in hands.getvalue().splitlines())
    assert decisions >= 50
