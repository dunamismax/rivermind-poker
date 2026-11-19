"""RM-03: linear-CFR discounting happens at the intended iterations."""
import pytest

from poker_ai.ai import ai
from poker_ai.ai.agent import Agent
from poker_ai.ai.multiprocess.server import Server
from poker_ai.ai.multiprocess.worker import Worker
from poker_ai.ai.singleprocess.train import simple_search
from test.functional.training_helpers import (
    use_thread_workers, write_single_bucket_lut,
)

LCFR_THRESHOLD = 12
DISCOUNT_INTERVAL = 4
N_ITERATIONS = 14
# Eligible: multiples of the interval strictly before the threshold.
ELIGIBLE = [4, 8]


def _expected(value: float) -> float:
    for t in ELIGIBLE:
        value *= ai.discount_factor(t, DISCOUNT_INTERVAL)
    return value


@pytest.mark.parametrize("t, expected", [
    (1, False), (3, False), (4, True), (5, False), (8, True), (11, False),
    (12, False), (16, False),
])
def test_should_discount(t, expected):
    """Between intervals, at an interval, at and past the threshold."""
    assert ai.should_discount(t, LCFR_THRESHOLD, DISCOUNT_INTERVAL) is expected


def test_discount_factor():
    assert ai.discount_factor(4, 4) == 0.5
    assert ai.discount_factor(8, 4) == 2 / 3


@pytest.mark.parametrize("use_manager", [False, True], ids=["dict", "manager"])
def test_discount_reaches_stored_values(use_manager):
    """Manager proxies return copies, so values must be reassigned."""
    agent = Agent(use_manager=use_manager)
    agent.regret["a"] = {"fold": 2.0, "call": -4.0}
    agent.strategy["s"] = {"fold": 3.0}  # an info set with no regret entry
    assert ai.discount(agent, 4, DISCOUNT_INTERVAL) == 0.5
    assert dict(agent.regret["a"]) == {"fold": 1.0, "call": -2.0}
    assert dict(agent.strategy["s"]) == {"fold": 1.5}


def _seed_values(agent, t):
    """Stand-in for CFR: store fixed values once, then leave them alone."""
    if t == 1:
        agent.regret["r"] = {"fold": 1.0, "call": -3.0}
        agent.strategy["s"] = {"call": 5.0}


def _assert_discounted_once_per_interval(agent):
    assert dict(agent.regret["r"]) == {
        "fold": _expected(1.0), "call": _expected(-3.0)}
    assert dict(agent.strategy["s"]) == {"call": _expected(5.0)}


def test_single_process_discount_schedule(tmp_path, monkeypatch):
    write_single_bucket_lut(tmp_path)
    discounts = []
    original = ai.discount

    def record(agent, t, *args, **kwargs):
        discounts.append(t)
        return original(agent, t, *args, **kwargs)
    monkeypatch.setattr(ai, "discount", record)
    monkeypatch.setattr(ai, "cfr", lambda agent, state, i, t: _seed_values(agent, t))
    monkeypatch.setattr(ai, "update_strategy", lambda **kwargs: None)
    agent = simple_search(
        save_path=tmp_path, lut_path=str(tmp_path), pickle_dir=False,
        strategy_interval=1, n_iterations=N_ITERATIONS,
        lcfr_threshold=LCFR_THRESHOLD, discount_interval=DISCOUNT_INTERVAL,
        prune_threshold=N_ITERATIONS, c=-20000, n_players=2,
        dump_iteration=1, update_threshold=N_ITERATIONS,
    )
    assert discounts == ELIGIBLE
    _assert_discounted_once_per_interval(agent)


@pytest.mark.parametrize("sync_discount", [True, False], ids=["sync", "async"])
def test_multiprocess_discount_schedule(tmp_path, monkeypatch, sync_discount):
    """The server schedules discount jobs; the worker's handler applies them."""
    monkeypatch.delenv("TESTING_SUITE", raising=False)
    write_single_bucket_lut(tmp_path)
    discounts = []

    def make_handlers(server):
        worker = Worker(
            job_queue=server._job_queue, status_queue=server._status_queue,
            logging_queue=server._logging_queue, locks=server._locks,
            agent=server._agent, info_set_lut=server._info_set_lut,
            n_players=server._n_players, prune_threshold=server._prune_threshold,
            c=server._c, lcfr_threshold=server._lcfr_threshold,
            discount_interval=server._discount_interval,
            update_threshold=server._update_threshold,
            dump_iteration=server._dump_iteration, save_path=server._save_path,
        )

        def discount(t):
            discounts.append(t)
            worker._discount(t)
        return {
            "cfr": lambda t, i: _seed_values(server._agent, t),
            "discount": discount,
        }
    use_thread_workers(monkeypatch, make_handlers)
    server = Server(
        strategy_interval=1, n_iterations=N_ITERATIONS,
        lcfr_threshold=LCFR_THRESHOLD, discount_interval=DISCOUNT_INTERVAL,
        prune_threshold=N_ITERATIONS, c=-20000, n_players=2,
        dump_iteration=1, update_threshold=N_ITERATIONS, save_path=tmp_path,
        lut_path=str(tmp_path), sync_cfr=True, sync_discount=sync_discount,
        n_processes=2,
    )
    try:
        server.search()
    finally:
        server.terminate(safe=True)
    assert discounts == ELIGIBLE
    _assert_discounted_once_per_interval(server._agent)
