"""RM-04: consistent checkpoints while asynchronous workers update the agent."""
import os
import shutil
import threading
import time

import joblib
import pytest

from poker_ai.ai import ai
from poker_ai.ai.agent import Agent
from poker_ai.ai.multiprocess.server import Server
from poker_ai.ai.runner import load_resume_state
from test.functional.training_helpers import (
    use_thread_workers, write_single_bucket_lut,
)

N_PLAYERS = 2


def _counting_handlers(writing: threading.Event, overlaps: list):
    """CFR stand-in: each job adds one to a shared regret under the lock."""
    def make_handlers(server):
        def cfr(t, i):
            time.sleep(0.002)
            if writing.is_set():
                overlaps.append(t)
            with server._locks["regret"]:
                count = server._agent.regret.get("count", {"jobs": 0})
                server._agent.regret["count"] = {"jobs": count["jobs"] + 1}
            with server._locks["strategy"]:
                last = server._agent.strategy.get("last", {"t": 0})
                server._agent.strategy["last"] = {"t": max(last["t"], t)}
        return {"cfr": cfr, "update_strategy": lambda t, i: None}
    return make_handlers


def _server(save_path, lut_path, n_iterations, **kwargs):
    return Server(
        strategy_interval=1, n_iterations=n_iterations, lcfr_threshold=0,
        discount_interval=1, prune_threshold=n_iterations, c=-20000,
        n_players=N_PLAYERS, dump_iteration=1, update_threshold=0,
        save_path=save_path, lut_path=lut_path, n_processes=3, **kwargs,
    )


def _search(server):
    try:
        server.search()
    finally:
        server.terminate()


def test_async_checkpoints_describe_completed_iterations(tmp_path, monkeypatch):
    monkeypatch.delenv("TESTING_SUITE", raising=False)
    write_single_bucket_lut(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    writing, overlaps, published = threading.Event(), [], {}
    use_thread_workers(monkeypatch, _counting_handlers(writing, overlaps))
    original = ai.write_checkpoint

    def slow_write(regret, strategy, save_path, t, server_state):
        writing.set()
        time.sleep(0.05)  # give workers time to run later iterations
        state = original(regret, strategy, save_path, t, server_state)
        writing.clear()
        copy_dir = tmp_path / f"published_{t}"
        shutil.copytree(run_dir, copy_dir)
        published[t] = copy_dir
        return state
    monkeypatch.setattr(ai, "write_checkpoint", slow_write)

    _search(_server(run_dir, str(tmp_path), n_iterations=6))

    assert sorted(published) == [1, 2, 3, 4, 5, 6]
    assert overlaps, "no update ran while a checkpoint was being written"
    for t, copy_dir in published.items():
        agent = joblib.load(copy_dir / "agent.joblib")
        server_state = joblib.load(copy_dir / "server.gz")
        # Every job up to t and none after it.
        assert agent["timestep"] == t
        assert agent["regret"]["count"] == {"jobs": N_PLAYERS * t}
        assert agent["pre_flop_strategy"]["last"] == {"t": t}
        assert server_state == agent["resume_state"]
        assert server_state["start_timestep"] == t + 1
        reloaded = Agent(copy_dir / "agent.joblib", use_manager=False)
        assert reloaded.regret["count"] == {"jobs": N_PLAYERS * t}
        # Each dump accumulates one regret-matched row per info set.
        assert sum(agent["strategy"]["count"].values()) == pytest.approx(t)

    # Continue training from the last published checkpoint.
    single_process, kwargs = load_resume_state(run_dir / "server.gz")
    assert not single_process and kwargs["start_timestep"] == 7
    kwargs["n_iterations"] = 9
    _search(Server.from_dict(kwargs))
    agent = joblib.load(run_dir / "agent.joblib")
    assert agent["timestep"] == 9
    assert agent["regret"]["count"] == {"jobs": N_PLAYERS * 9}


@pytest.mark.parametrize("sync_serialise", [True, False], ids=["sync", "async"])
def test_repeated_dumps_are_written_in_order(tmp_path, monkeypatch, sync_serialise):
    monkeypatch.delenv("TESTING_SUITE", raising=False)
    write_single_bucket_lut(tmp_path)
    written = []
    use_thread_workers(monkeypatch, _counting_handlers(threading.Event(), []))
    original = ai.write_checkpoint

    def record(regret, strategy, save_path, t, server_state):
        written.append((t, regret["count"]["jobs"]))
        return original(regret, strategy, save_path, t, server_state)
    monkeypatch.setattr(ai, "write_checkpoint", record)
    _search(_server(tmp_path, str(tmp_path), n_iterations=5,
                    sync_serialise=sync_serialise))
    assert written == [(t, N_PLAYERS * t) for t in range(1, 6)]


def _checkpoint(save_path, t):
    regret = {"r": {"fold": float(t)}}
    strategy = {"s": {"call": t}}
    return ai.write_checkpoint(regret, strategy, save_path, t, {"n_iterations": 9})


def _fail_on_dump(monkeypatch, fail_on: int):
    """Interrupt the `fail_on`th joblib.dump after it writes a partial file."""
    original = joblib.dump
    calls = []

    def dump(value, filename, *args, **kwargs):
        calls.append(filename)
        if len(calls) == fail_on:
            with open(filename, "wb") as f:
                f.write(b"partial")
            raise KeyboardInterrupt
        return original(value, filename, *args, **kwargs)
    monkeypatch.setattr(joblib, "dump", dump)


def test_interrupted_agent_write_keeps_previous_checkpoint(tmp_path, monkeypatch):
    _checkpoint(tmp_path, 1)
    with monkeypatch.context() as patch:
        _fail_on_dump(patch, fail_on=1)
        with pytest.raises(KeyboardInterrupt):
            _checkpoint(tmp_path, 2)
    agent = joblib.load(tmp_path / "agent.joblib")
    assert agent["timestep"] == 1
    assert agent["regret"] == {"r": {"fold": 1.0}}
    assert joblib.load(tmp_path / "server.gz")["start_timestep"] == 2
    assert sorted(os.listdir(tmp_path)) == ["agent.joblib", "server.gz"]


def test_interrupted_server_write_resumes_from_agent(tmp_path, monkeypatch):
    _checkpoint(tmp_path, 1)
    with monkeypatch.context() as patch:
        _fail_on_dump(patch, fail_on=2)
        with pytest.raises(KeyboardInterrupt):
            _checkpoint(tmp_path, 2)
    assert joblib.load(tmp_path / "agent.joblib")["timestep"] == 2
    assert joblib.load(tmp_path / "server.gz")["start_timestep"] == 2
    assert sorted(os.listdir(tmp_path)) == ["agent.joblib", "server.gz"]
    # The newer agent's embedded state wins, so iteration 2 is not repeated.
    _, kwargs = load_resume_state(tmp_path / "server.gz")
    assert kwargs["start_timestep"] == 3


def test_checkpoint_files_get_the_default_file_mode(tmp_path):
    _checkpoint(tmp_path, 1)
    umask = os.umask(0)
    os.umask(umask)
    for name in ["agent.joblib", "server.gz"]:
        assert (tmp_path / name).stat().st_mode & 0o777 == 0o666 & ~umask
