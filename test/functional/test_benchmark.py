"""RM-06: reproducible fixed-seed matches against two random bots."""
import json
import os
import random
import subprocess
import sys

import joblib
from click.testing import CliRunner

from poker_ai.benchmark import play_hand, run_match
from poker_ai.cli.runner import cli
from poker_ai.policies import RandomPolicy
from test.functional.training_helpers import write_single_bucket_lut


class _Recorder(RandomPolicy):
    def __init__(self, rng, seen):
        super().__init__(rng)
        self._seen = seen

    def choose(self, view):
        self._seen.append(view.hole_cards)
        return super().choose(view)


def test_deal_seed_fixes_cards_across_policies():
    """Rotations share cards even though the policies' choices differ."""
    first, second = [], []
    for seen, rng_seed in [(first, 1), (second, 2)]:
        policies = [_Recorder(random.Random(rng_seed + s), seen) for s in range(3)]
        play_hand(policies, {}, deal_seed=11)
    assert first[0] == second[0]


def test_random_control_conserves_chips_and_repeats():
    a = run_match(RandomPolicy, {}, n_deals=30, seed=3)
    b = run_match(RandomPolicy, {}, n_deals=30, seed=3)
    assert a == b
    assert a["hands"] == 90
    assert a["ci95"][0] <= a["net_chips_per_hand"] <= a["ci95"][1]
    assert run_match(RandomPolicy, {}, n_deals=30, seed=4) != a


def test_evaluate_cli_reports_artifacts_and_reproduces(tmp_path):
    write_single_bucket_lut(tmp_path)
    joblib.dump({
        "strategy": {}, "timestep": 7,
        "resume_state": {"n_players": 3, "rng_state": object()},
    }, tmp_path / "agent.joblib")
    args = ["evaluate", "--strategy_path", str(tmp_path / "agent.joblib"),
            "--lut_path", str(tmp_path), "--deals", "10", "--seed", "5"]
    reports = []
    for run in range(2):
        out = tmp_path / f"report{run}.json"
        result = CliRunner().invoke(cli, [*args, "--output", str(out)],
                                    catch_exceptions=False)
        assert result.exit_code == 0, result.output
        reports.append(json.loads(out.read_text()))
    for report in reports:
        report.pop("created")
    assert reports[0] == reports[1]
    report = reports[0]
    assert report["artifacts"]["checkpoint_timestep"] == 7
    assert report["artifacts"]["training_settings"] == {"n_players": 3}
    assert len(report["artifacts"]["card_table_sha256"]) == 64
    assert report["results"]["hands"] == 30
    # An empty checkpoint falls back to uniform play on every decision.
    assert report["results"]["checkpoint_info_set_coverage"] == 0
    assert set(report["results"]["net_chips_per_hand_by_seat"]) == {
        "small_blind", "big_blind", "button"}


# Prints the cards of a seeded deal. A suit relabelling would leave
# random-bot chip totals unchanged, so compare the cards themselves.
DEAL_SCRIPT = """
from poker_ai import utils
from poker_ai.games.short_deck.state import new_game
for seed in range(5):
    utils.random.seed(seed)
    state = new_game(3, {}, load_card_lut=False)
    print([c.to_dict() for p in state.players for c in p.cards])
"""


def test_match_is_identical_across_processes_and_hash_seeds():
    """Deals must not depend on string-hash randomisation (suit set order)."""
    outputs = set()
    for hash_seed in ["1", "2", "3"]:
        env = {**os.environ, "PYTHONHASHSEED": hash_seed}
        outputs.add(subprocess.run(
            [sys.executable, "-c", DEAL_SCRIPT], env=env, check=True,
            capture_output=True, text=True,
        ).stdout)
    assert len(outputs) == 1
