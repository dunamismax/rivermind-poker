"""RM-02: resume interrupted training runs through the CLI."""
import os

import joblib
import pytest
from click.testing import CliRunner

from poker_ai.ai import ai
from poker_ai.ai.agent import Agent
from poker_ai.ai.runner import load_resume_state
from poker_ai.ai.singleprocess.train import simple_search
from poker_ai.cli.runner import cli
from test.functional.training_helpers import write_single_bucket_lut

SETTINGS = [
    "--n_players", "2", "--strategy_interval", "1", "--dump_iteration", "2",
    "--update_threshold", "0",
]
# Keys of a single-process server.gz written before RM-02: the train start
# options plus the agent_path and start_timestep added by serialise.
LEGACY_SINGLE_PROCESS_KEYS = {
    "strategy_interval", "n_iterations", "lcfr_threshold", "discount_interval",
    "prune_threshold", "c", "n_players", "dump_iteration", "update_threshold",
    "lut_path", "pickle_dir", "single_process", "sync_update_strategy",
    "sync_cfr", "sync_discount", "sync_serialise", "nickname", "agent_path",
    "start_timestep",
}


def _start(nickname, *args):
    return CliRunner().invoke(cli, [
        "train", "start", *args, *SETTINGS, "--nickname", nickname,
    ], catch_exceptions=False)


def _resume(server_path, *args):
    return CliRunner().invoke(cli, [
        "train", "resume", "--server_config_path", str(server_path), *args,
    ], catch_exceptions=False)


def _run_dir(tmp_path, nickname):
    run_dir, = tmp_path.glob(f"{nickname}_*")
    return run_dir


def _interrupt_after_first_dump(monkeypatch):
    """Raise Ctrl-C right after the first checkpoint is published."""
    original = ai.write_checkpoint
    calls = []

    def write_then_interrupt(*args, **kwargs):
        state = original(*args, **kwargs)
        calls.append(state["start_timestep"] - 1)
        raise KeyboardInterrupt
    monkeypatch.setattr(ai, "write_checkpoint", write_then_interrupt)
    return calls


@pytest.fixture
def workdir(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TESTING_SUITE", "1")
    write_single_bucket_lut(tmp_path)
    return tmp_path


def test_single_process_resume_matches_uninterrupted_run(workdir, monkeypatch):
    """Interrupt after a dump, resume from another directory, reach the next."""
    assert _start("full", "--single_process", "--n_iterations", "4").exit_code == 0
    full = joblib.load(_run_dir(workdir, "full") / "agent.joblib")

    with monkeypatch.context() as patch:
        calls = _interrupt_after_first_dump(patch)
        result = _start("cut", "--single_process", "--n_iterations", "4")
    assert calls == [2]
    assert result.exit_code != 0
    run_dir = _run_dir(workdir, "cut")
    assert joblib.load(run_dir / "agent.joblib")["timestep"] == 2
    single_process, saved = load_resume_state(run_dir / "server.gz")
    assert single_process
    assert saved["start_timestep"] == 3
    assert saved["lut_path"] == str(workdir)
    assert saved["save_path"] == str(run_dir)

    # The saved lut_path is absolute, so resuming works from the run's dir.
    monkeypatch.chdir(run_dir)
    result = _resume("server.gz")
    assert result.exit_code == 0, result.output
    resumed = joblib.load(run_dir / "agent.joblib")
    assert resumed["timestep"] == 4
    assert joblib.load(run_dir / "server.gz")["start_timestep"] == 5
    for key in ["regret", "pre_flop_strategy", "strategy"]:
        assert resumed[key] == full[key], key
    settings = {k: v for k, v in resumed["resume_state"].items()
                if k not in {"rng_state", "agent_path", "save_path"}}
    assert settings == {k: v for k, v in full["resume_state"].items()
                        if k not in {"rng_state", "agent_path", "save_path"}}


def test_resume_restores_live_strategy_counts(workdir):
    """The trainer resumes update counts, not the averaged play policy."""
    assert _start("counts", "--single_process", "--n_iterations", "2").exit_code == 0
    run_dir = _run_dir(workdir, "counts")
    saved = joblib.load(run_dir / "agent.joblib")
    agent = Agent(run_dir / "agent.joblib", use_manager=False)
    assert agent.strategy == saved["pre_flop_strategy"]
    assert agent.regret == saved["regret"]
    assert agent.strategy != saved["strategy"]


def test_resume_legacy_single_process_checkpoint(workdir, monkeypatch):
    """A pre-RM-02 single-process server.gz and agent.joblib still resume."""
    assert _start("old", "--single_process", "--n_iterations", "2").exit_code == 0
    run_dir = _run_dir(workdir, "old")
    agent_path = run_dir / "agent.joblib"
    # Rewrite both files in the old layout: no embedded resume state, the
    # first dump's timestep, CLI options and a relative lut_path.
    agent = joblib.load(agent_path)
    legacy_counts = agent["pre_flop_strategy"]
    joblib.dump({k: agent[k] for k in
                 ["regret", "timestep", "strategy", "pre_flop_strategy"]},
                agent_path)
    legacy = dict(
        strategy_interval=1, n_iterations=4, lcfr_threshold=400,
        discount_interval=400, prune_threshold=400, c=-20000, n_players=2,
        dump_iteration=2, update_threshold=0, lut_path=".", pickle_dir=False,
        single_process=True, sync_update_strategy=False, sync_cfr=False,
        sync_discount=False, sync_serialise=False, nickname="old",
        agent_path=os.path.abspath(agent_path), start_timestep=3,
    )
    assert set(legacy) == LEGACY_SINGLE_PROCESS_KEYS
    joblib.dump(legacy, run_dir / "server.gz")

    monkeypatch.chdir(run_dir)
    single_process, kwargs = load_resume_state("server.gz", lut_path=str(workdir))
    assert single_process
    assert kwargs["save_path"] == str(run_dir)
    assert kwargs["lut_path"] == str(workdir)
    assert "rng_state" not in kwargs
    resumed_agent = simple_search(**kwargs)

    # Counts continue from the saved update counts rather than restarting
    # from the averaged policy (whose rows each sum to the number of dumps).
    total = 0
    for info_set, counts in legacy_counts.items():
        resumed_total = sum(resumed_agent.strategy[info_set].values())
        assert resumed_total >= sum(counts.values())
        total += resumed_total - sum(counts.values())
    assert total > 0
    resumed = joblib.load(agent_path)
    assert resumed["timestep"] == 4
    assert resumed["resume_state"]["start_timestep"] == 5
    assert joblib.load(run_dir / "server.gz")["single_process"] is True


@pytest.mark.parametrize("mode", [
    ["--sync_cfr", "--sync_update_strategy", "--sync_serialise"], [],
], ids=["synchronous", "asynchronous"])
def test_multiprocess_resume_continues(workdir, monkeypatch, mode):
    """A multiprocess run resumes with its mode and records the next dump."""
    result = _start("multi", "--multi_process", *mode, "--n_iterations", "2")
    assert result.exit_code == 0, result.output
    run_dir = _run_dir(workdir, "multi")
    first = joblib.load(run_dir / "agent.joblib")
    assert first["timestep"] == 2
    config = joblib.load(run_dir / "server.gz")
    assert config["start_timestep"] == 3
    assert "single_process" not in config
    config["n_iterations"] = 4
    joblib.dump(config, run_dir / "server.gz")

    monkeypatch.chdir(run_dir)
    result = _resume("server.gz")
    assert result.exit_code == 0, result.output
    resumed = joblib.load(run_dir / "agent.joblib")
    assert resumed["timestep"] == 4
    assert joblib.load(run_dir / "server.gz")["start_timestep"] == 5
    assert resumed["resume_state"]["sync_cfr"] == ("--sync_cfr" in mode)
    for info_set, counts in first["pre_flop_strategy"].items():
        assert sum(resumed["pre_flop_strategy"][info_set].values()) >= sum(
            counts.values())
