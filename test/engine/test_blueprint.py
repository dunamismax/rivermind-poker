"""Heads-up blueprint training (P5.3): the hu-m1 trees, MCCFR, batching, resume and checkpoints."""

from __future__ import annotations

import json
import shutil
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest
from click.testing import CliRunner

from poker_ai.cli.runner import cli
from rivermind.bots.blueprint import (
    Blueprint,
    CardDealer,
    CheckpointError,
    Game,
    Settings,
    Trainer,
    compile_tree,
    info_set_key,
    latest_checkpoint,
    read_manifest,
)
from rivermind.bots.blueprint.abstraction import abstract_actions, sizes
from rivermind.bots.blueprint.train import RunInUseError
from rivermind.bots.blueprint.tree import FOLD, SHOWDOWN, start_state
from rivermind.engine import Action, ActionKind, LegalActions, Street, apply, legal_actions
from rivermind.engine.evaluator import evaluate

from .blueprint_helpers import SCALE, VALUE, KuhnDealer, exploitability, expected_value, kuhn_game, strategy_profile

TABLES = Path(__file__).resolve().parents[2] / "artifacts" / "tables" / "hu-m1"
needs_tables = pytest.mark.skipif(not (TABLES / "manifest.json").exists(), reason="the hu-m1 card tables are not built")


def kuhn_settings(**changes: object) -> Settings:
    base = dict(
        depths=(1,),
        chunk_size=100,
        chunks_per_batch=4,
        discount_every=2_000,
        discount_until=40_000,
        prune_after=10**9,
        prune_threshold=-500,
        regret_floor=-600,
    )
    base.update(changes)
    return Settings(**base)  # type: ignore[arg-type]


def kuhn_trainer(run: Path, settings: Settings | None = None, workers: int = 1) -> Trainer:
    return Trainer(run, settings or kuhn_settings(), KuhnDealer(), game=kuhn_game(), workers=workers)


def arrays(trainer: Trainer) -> tuple[bytes, bytes]:
    return np.asarray(trainer.regrets).tobytes(), trainer.strategy.tobytes()


# The hu-m1 trees


@pytest.mark.parametrize(
    ("depth", "nodes", "widths"),
    [(100, 11_708, (129, 1_332, 6_256, 22_576)), (50, 5_472, (117, 812, 3_216, 9_704))],
)
def test_trees_match_the_design(depth: int, nodes: int, widths: tuple[int, ...]) -> None:
    tree = compile_tree(depth)
    assert len(tree) == nodes and tree.width == widths
    assert tree.nodes_on(0) == (44 if depth == 100 else 40)
    assert compile_tree(depth).sha256 == tree.sha256
    # Offsets tile each street's width, depth-first, with no gaps.
    for s in range(4):
        spans = sorted((tree.offset[v], len(tree.children[v])) for v in range(len(tree)) if tree.street[v] == s)
        at = 0
        for start, n in spans:
            assert start == at
            at += n
        assert at == widths[s]


def test_the_layout_has_room_for_every_info_set() -> None:
    game = Game((compile_tree(50), compile_tree(100)), (169, 1000, 1000, 1000))
    assert game.size == 43_937_574
    assert [game.info_sets(d) for d in range(2)] == [5_438_760, 11_671_436]
    assert game.depth_weights[1] == pytest.approx(11_671_436 / 17_110_196)
    tree = game.trees[1]
    last = max((v for v in range(len(tree)) if tree.street[v] == 3), key=lambda v: tree.offset[v])
    assert game.slot(1, last, 999) + len(tree.children[last]) == game.size
    with pytest.raises(ValueError):
        game.slot(0, 0, 169)


def test_the_worked_example_replays_on_the_engine() -> None:
    tree = compile_tree(100)
    node = tree.node("r0c/kb1c/k")
    assert info_set_key(tree, node, 412) == "hu-m1|100|T|412|r0c/kb1c/k"
    assert tree.player[node] == 0 and tree.street[node] == Street.TURN
    assert tree.tokens[node] == ("k", "b0", "b1", "b2", "a")
    # Replay the history through the engine: an open to 250, a 375 bet into 500.
    state = start_state(100)
    seen = []
    for token in "r0 c k b1 c k".split():
        level = sum(1 for a in state.actions if a.street is state.street and a.kind in (ActionKind.BET, ActionKind.RAISE))
        options = abstract_actions(
            legal_actions(state),
            street=state.street,
            level=level,
            pot=state.pot,
            current_bet=state.current_bet,
            street_bets=state.street_bets,
        )
        chosen = next(a for a in options if a.token == token)
        seen.append(chosen.action)
        state = apply(state, chosen.action)
    assert seen[0] == Action.raise_to(250) and seen[3] == Action.bet(375)
    assert state.street is Street.TURN and state.to_act == 0 and state.pot == 1_250


def test_terminals_hold_the_chips_at_stake() -> None:
    tree = compile_tree(100)
    root = tree.children[0]
    assert tree.tokens[0] == ("f", "c", "r0", "r1", "a")
    fold = ~root[0]
    assert tree.terminal_kind[fold] == FOLD and tree.terminal_value[fold] == -50
    # The button shoves and the big blind calls: 10,000 each at showdown.
    shove = root[4]
    call = ~tree.children[shove][1]
    assert tree.history[shove] == "a" and tree.tokens[shove] == ("f", "c")
    assert tree.terminal_kind[call] == SHOWDOWN and tree.terminal_value[call] == 10_000
    # The big blind folds to the shove: the button wins its 100.
    assert tree.terminal_value[~tree.children[shove][0]] == 100


def test_abstract_sizes_follow_the_legality_rules() -> None:
    # Flop, pot 1,000, 1,100 behind: a third is 333; three quarters would leave
    # 350 behind, under 20% of the 2,500 called pot, so all-in replaces it; and
    # five quarters is beyond the stack.
    legal = LegalActions(0, False, True, 0, ActionKind.BET, 100, 1_100)
    found = abstract_actions(legal, street=Street.FLOP, level=0, pot=1_000, current_bet=0, street_bets=(0, 0))
    assert [(a.token, a.action.amount) for a in found] == [("k", None), ("b0", 333), ("a", 1_100)]
    # A third of a 150 pot is below the 100 minimum bet, so it rises to the minimum.
    legal = LegalActions(1, False, True, 0, ActionKind.BET, 100, 9_000)
    found = abstract_actions(legal, street=Street.FLOP, level=0, pot=150, current_bet=0, street_bets=(0, 0))
    assert [(a.token, a.action.amount) for a in found] == [("k", None), ("b0", 100), ("b1", 113), ("b2", 188), ("a", 9_000)]
    # Facing a raise with only a minimum raise left: fold, call, all-in.
    legal = LegalActions(0, True, False, 400, ActionKind.RAISE, 1_000, 1_000)
    found = abstract_actions(legal, street=Street.PREFLOP, level=1, pot=900, current_bet=600, street_bets=(200, 600))
    assert [a.token for a in found] == ["f", "c", "a"]
    # Sizes that round to the same amount are kept once.
    legal = LegalActions(0, True, False, 100, ActionKind.RAISE, 500, 9_000)
    found = abstract_actions(legal, street=Street.PREFLOP, level=0, pot=300, current_bet=200, street_bets=(100, 200))
    assert [(a.token, a.action.amount) for a in found] == [("f", None), ("c", None), ("r0", 500), ("r1", 800), ("a", 9_000)]
    assert sizes(Street.PREFLOP, 3) == () and sizes(Street.TURN, 1) == (Fraction(1),)


def test_every_tree_action_is_legal_in_the_engine() -> None:
    tree = compile_tree(50)
    checked = 0
    rng = np.random.default_rng(0)
    for _ in range(300):
        state = start_state(50)
        while not state.is_over:
            level = sum(1 for a in state.actions if a.street is state.street and a.kind in (ActionKind.BET, ActionKind.RAISE))
            legal = legal_actions(state)
            options = abstract_actions(
                legal, street=state.street, level=level, pot=state.pot, current_bet=state.current_bet, street_bets=state.street_bets
            )
            assert all(legal.allows(a.action) for a in options)
            assert options[-1].token in ("a", "c", "k") and len({a.action for a in options}) == len(options)
            state = apply(state, options[int(rng.integers(len(options)))].action)
            checked += 1
    assert checked > 500 and len(tree) == 5_472


# MCCFR on Kuhn poker, whose answer is known


def test_mccfr_finds_kuhn_pokers_equilibrium(tmp_path: Path) -> None:
    with kuhn_trainer(tmp_path / "run") as trainer:
        trainer.train(300_000)
        game = trainer.game
        assert exploitability(game, trainer.strategy) / SCALE < 0.02
        assert expected_value(game.trees[0], strategy_profile(game, trainer.strategy)) == pytest.approx(VALUE, abs=0.005 * SCALE)
        profile = strategy_profile(game, trainer.strategy)
    # At equilibrium seat 1 always calls a bet with the king and never with the jack.
    assert profile[3, 2][1] > 0.97 and profile[3, 0][1] < 0.03


def test_pruning_still_converges(tmp_path: Path) -> None:
    with kuhn_trainer(tmp_path / "run", kuhn_settings(prune_after=50_000)) as trainer:
        trainer.train(300_000)
        assert exploitability(trainer.game, trainer.strategy) / SCALE < 0.02
        assert int(np.asarray(trainer.regrets).min()) >= -600  # the floor


def test_a_run_does_not_depend_on_the_number_of_workers(tmp_path: Path) -> None:
    settings = kuhn_settings(prune_after=8_000, discount_every=1_600, discount_until=8_000)
    with kuhn_trainer(tmp_path / "one", settings) as one:
        one.train(16_000)
    with kuhn_trainer(tmp_path / "two", settings, workers=2) as two:
        two.train(16_000)
    assert arrays(one) == arrays(two)
    a = read_manifest(latest_checkpoint(tmp_path / "one"))  # type: ignore[arg-type]
    b = read_manifest(latest_checkpoint(tmp_path / "two"))  # type: ignore[arg-type]
    assert a["files"] == b["files"] and a["stats"]["workers"] == 1 and b["stats"]["workers"] == 2


def test_resuming_reproduces_an_uninterrupted_run(tmp_path: Path) -> None:
    settings = kuhn_settings(prune_after=8_000, discount_every=1_600, discount_until=8_000)
    with kuhn_trainer(tmp_path / "straight", settings) as straight:
        straight.train(16_000)
    with kuhn_trainer(tmp_path / "split", settings) as first:
        first.train(5_900, checkpoint_every=2_400)  # stops at 6,000: whole batches of 400
    assert latest_checkpoint(tmp_path / "split").name == "000000006000"  # type: ignore[union-attr]
    with Trainer.resume(tmp_path / "split", KuhnDealer(), game=kuhn_game(), workers=2) as resumed:
        assert resumed.iteration == 6_000 and resumed.settings == settings
        resumed.train(16_000)
    assert arrays(resumed) == arrays(straight)
    assert read_manifest(latest_checkpoint(tmp_path / "split"))["files"] == read_manifest(latest_checkpoint(tmp_path / "straight"))["files"]  # type: ignore[arg-type]


def test_discounting_scales_regrets_and_sums(tmp_path: Path) -> None:
    with kuhn_trainer(tmp_path / "run", kuhn_settings(discount_every=100, discount_until=250)) as trainer:
        trainer.regrets[:3] = [10, -10, 7]
        trainer.strategy[:2] = [6.0, 3.0]
        trainer._discount(0, 400)  # discounts at 100 and 200: × 1/2, then × 2/3
        assert np.asarray(trainer.regrets[:3]).tolist() == [3, -3, 3]
        assert trainer.strategy[:2].tolist() == pytest.approx([2.0, 1.0])


def test_checkpoints_are_atomic_hashed_and_checked_on_resume(tmp_path: Path) -> None:
    run = tmp_path / "run"
    with kuhn_trainer(run) as trainer:
        trainer.train(4_000, checkpoint_every=800)
    names = sorted(p.name for p in (run / "checkpoints").iterdir())
    assert names == ["000000003200", "000000004000"]  # two kept
    path = latest_checkpoint(run)
    assert path is not None and path.name == "000000004000"
    manifest = read_manifest(path, verify=True)
    assert manifest["iteration"] == 4_000 and manifest["batch"] == 10
    assert manifest["cards"] == KuhnDealer().describe()
    assert manifest["game"]["trees"][0]["sha256"] == kuhn_game().trees[0].sha256
    assert set(manifest["engine"]) == {"package", "source_sha256"} and len(manifest["engine"]["source_sha256"]) == 64
    assert set(manifest["files"]) == {"regrets.npy", "strategy.npy"}

    # A half-written checkpoint is ignored; the latest stays in charge. Only
    # one trainer may use a run at a time.
    (run / "checkpoints" / "000000004400.partial").mkdir()
    with Trainer.resume(run, KuhnDealer(), game=kuhn_game()) as resumed:
        assert resumed.iteration == 4_000
        with pytest.raises(RunInUseError):
            Trainer.resume(run, KuhnDealer(), game=kuhn_game())

    # Other cards, or a damaged file, are refused.
    class OtherDealer(KuhnDealer):
        def describe(self) -> dict[str, object]:
            return {"kind": "kuhn", "sha256": {"kuhn": "1"}}

    with pytest.raises(CheckpointError, match="card table"):
        Trainer.resume(run, OtherDealer(), game=kuhn_game())
    data = bytearray((path / "strategy.npy").read_bytes())
    data[-1] ^= 1
    (path / "strategy.npy").write_bytes(bytes(data))
    with pytest.raises(CheckpointError, match="strategy.npy"):
        Trainer.resume(run, KuhnDealer(), game=kuhn_game())
    with pytest.raises(CheckpointError, match="no checkpoint"):
        Trainer.resume(tmp_path / "empty", KuhnDealer(), game=kuhn_game())


def test_bad_settings_are_refused() -> None:
    for bad in (
        Settings(chunk_size=0),
        Settings(prune_probability=1.5),
        Settings(prune_threshold=1),
        Settings(regret_floor=-(2**31)),
        Settings(prune_threshold=-10, regret_floor=-5),
    ):
        with pytest.raises(ValueError):
            bad.check()
    with pytest.raises(ValueError, match="unknown"):
        Settings.from_dict({"seed": 1, "speed": 2})


# The real card tables, when they are built


@needs_tables
def test_the_card_dealer_buckets_and_scores_real_hands() -> None:
    dealer = CardDealer(TABLES)
    assert dealer.buckets == (169, 1000, 1000, 1000)
    rng = np.random.default_rng(5)
    buckets, outcome = dealer.deal(rng, 300)
    again = np.random.default_rng(5)
    cards = again.random((300, 52)).argsort(axis=1)[:, :9]
    for i, row in enumerate(cards.tolist()):
        board = row[4:9]
        for seat in (0, 1):
            hole = row[2 * seat : 2 * seat + 2]
            assert buckets[i, seat].tolist() == [dealer.tables.bucket(hole, board[:k]) for k in (0, 3, 4, 5)]
        r0, r1 = evaluate((*row[0:2], *board)), evaluate((*row[2:4], *board))
        assert outcome[i] == (1 if r0 < r1 else -1 if r0 > r1 else 0)


@needs_tables
def test_the_cli_trains_resumes_and_reads_a_blueprint(tmp_path: Path) -> None:
    run = tmp_path / "run"
    runner = CliRunner()
    small = ["--chunk_size", "500", "--chunks_per_batch", "4", "--workers", "2"]
    result = runner.invoke(cli, ["blueprint", "train", str(run), "--tables", str(TABLES), "--iterations", "4000", *small])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output[result.output.index("{") :])["iteration"] == 4_000
    refused = runner.invoke(cli, ["blueprint", "train", str(run), "--tables", str(TABLES), "--iterations", "8000"])
    assert refused.exit_code != 0 and "--resume" in refused.output
    refused = runner.invoke(cli, ["blueprint", "train", str(run), "--iterations", "8000", "--resume", "--seed", "4"])
    assert refused.exit_code != 0 and "--seed" in refused.output
    resumed = runner.invoke(
        cli, ["blueprint", "train", str(run), "--tables", str(TABLES), "--iterations", "6000", "--resume", "--workers", "1"]
    )
    assert resumed.exit_code == 0, resumed.output
    info = json.loads(runner.invoke(cli, ["blueprint", "info", str(run), "--verify"]).output)
    assert info["iteration"] == 6_000 and info["settings"]["chunk_size"] == 500 and info["verified"]
    shown = runner.invoke(cli, ["blueprint", "strategy", str(run), "AsAh"])
    assert shown.exit_code == 0, shown.output
    strategy = json.loads(shown.output)
    assert strategy["key"] == "hu-m1|100|P|168|" and set(strategy["current"]) == {"f", "c", "r0", "r1", "a"}
    assert sum(strategy["average"].values()) == pytest.approx(1)
    flop = runner.invoke(cli, ["blueprint", "strategy", str(run), "AsAh", "Kd7c2s", "--history", "r0c/"])
    assert flop.exit_code == 0 and json.loads(flop.output)["key"].startswith("hu-m1|100|F|")
    wrong = runner.invoke(cli, ["blueprint", "strategy", str(run), "AsAh", "--history", "r0c/"])
    assert wrong.exit_code != 0
    bp = Blueprint(latest_checkpoint(run))  # type: ignore[arg-type]
    assert bp.iteration == 6_000

    # Evaluate it: the report is the same on one worker or two.
    reports = []
    for workers in ("1", "2"):
        out = tmp_path / f"evals{workers}"
        args = ["blueprint", "evaluate", str(run), "--name", "tiny", "--out", str(out), "--deals", "60"]
        args += ["--against", "heuristic@100", "--against", "random@40", "--workers", workers]
        evaluated = runner.invoke(cli, args)
        assert evaluated.exit_code == 0, evaluated.output
        reports.append(((out / "tiny.json").read_text(), (out / "tiny.md").read_text()))
    assert reports[0][0] == reports[1][0].replace("evals2", "evals1")
    report = json.loads(reports[0][0])
    assert [(r["opponent"], r["stack_bb"], r["hands"]) for r in report["results"]] == [("heuristic", 100, 120), ("random", 40, 120)]
    assert report["candidate"]["iteration"] == 6_000 and report["candidate"]["files"] == {
        k: v["sha256"] for k, v in read_manifest(latest_checkpoint(run))["files"].items()  # type: ignore[arg-type]
    }
    assert 0 < report["results"][0]["trained_share"] <= 1 and "--against heuristic@100" in reports[0][1]
    shutil.rmtree(run)


def test_the_cli_defaults_are_the_settings_defaults() -> None:
    from rivermind.bots.cli import SETTING_OPTIONS, train_command

    defaults = {p.name: p.default for p in train_command.params}
    assert {name: defaults[name] for name in SETTING_OPTIONS} == {name: getattr(Settings(), name) for name in SETTING_OPTIONS}
