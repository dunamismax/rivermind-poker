from collections import defaultdict

import joblib
import pytest
from click.testing import CliRunner

from poker_ai.cli.runner import cli


@pytest.mark.parametrize("mode", [
    ["--single_process"],
    ["--multi_process", "--sync_cfr", "--sync_update_strategy", "--sync_serialise"],
    ["--multi_process"],
], ids=["single", "synchronous", "asynchronous"])
def test_training_checkpoint(tmp_path, monkeypatch, mode):
    """Exercise real CLI training with one test-only card bucket per street."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TESTING_SUITE", "1")
    stages = ["pre_flop", "flop", "turn", "river"]
    joblib.dump({stage: defaultdict(int) for stage in stages}, "card_info_lut.joblib")
    result = CliRunner().invoke(cli, [
        "train", "start", *mode, "--n_players", "2", "--n_iterations", "1",
        "--strategy_interval", "1", "--dump_iteration", "1",
        "--update_threshold", "0", "--nickname", "smoke",
    ], catch_exceptions=False)
    assert result.exit_code == 0, result.output
    checkpoint, = tmp_path.glob("smoke_*/agent.joblib")
    assert joblib.load(checkpoint)["timestep"] == 1
    assert joblib.load(checkpoint.with_name("server.gz"))["start_timestep"] == 2
    # Checkpoints are taken after the iteration's jobs finish in every mode.
    assert joblib.load(checkpoint)["strategy"]


def test_training_schedule_defaults():
    """Pluribus-style schedule in iterations: discount every 10 until 400."""
    from poker_ai.ai import ai
    from poker_ai.ai.runner import start
    defaults = {p.name: p.default for p in start.params}
    assert defaults["lcfr_threshold"] == 400
    assert defaults["discount_interval"] == 10
    assert defaults["prune_threshold"] == 200
    assert defaults["update_threshold"] == 400
    discounted = [t for t in range(1, 1001) if ai.should_discount(
        t, defaults["lcfr_threshold"], defaults["discount_interval"])]
    assert discounted == list(range(10, 400, 10))
