"""Helpers for driving the training server with in-process thread workers.

The real workers are separate processes, so test doubles cannot be patched
into them on platforms that spawn. These threads follow the worker protocol
(status updates, `task_done`, the terminate sentinel) and run the job
handlers a test supplies, so the server's scheduling can be checked with
deterministic updates.
"""
from __future__ import annotations

import threading
from collections import defaultdict
from typing import Callable, Dict

import joblib

from poker_ai.ai.multiprocess.server import Server

STAGES = ["pre_flop", "flop", "turn", "river"]


def write_single_bucket_lut(directory) -> None:
    """Write a card table that maps every hand to bucket 0 on each street."""
    joblib.dump(
        {stage: defaultdict(int) for stage in STAGES},
        str(directory / "card_info_lut.joblib"),
    )


class ThreadWorker(threading.Thread):
    """Consume server jobs in a thread, following `Worker.run`."""

    def __init__(self, server: Server, handlers: Dict[str, Callable], name: str):
        super().__init__(name=name, daemon=True)
        self._server = server
        self._handlers = handlers

    def run(self):
        queue = self._server._job_queue
        while True:
            self._server._status_queue.put((self.name, "idle"))
            name, kwargs = queue.get(block=True)
            if name == "terminate":
                break
            self._server._status_queue.put((self.name, name))
            self._handlers[name](**kwargs)
            queue.task_done()


def use_thread_workers(monkeypatch, make_handlers: Callable[[Server], Dict]):
    """Make every Server start thread workers built by `make_handlers`."""

    def start_workers(self: Server, n_processes: int):
        handlers = make_handlers(self)
        workers = {}
        for k in range(n_processes):
            worker = ThreadWorker(self, handlers, name=f"thread-worker-{k}")
            workers[worker.name] = worker
        for worker in workers.values():
            worker.start()
        return workers

    monkeypatch.setattr(Server, "_start_workers", start_workers)
