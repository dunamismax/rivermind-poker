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
    if mode != ["--multi_process"]:
        assert joblib.load(checkpoint)["strategy"]
