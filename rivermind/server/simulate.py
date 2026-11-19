"""Run bot tables through the table server and report on them (P3.2).

``python -m rivermind.server.simulate --seats 2,6,9 --hands 200 --seed 0``
creates one table per seat count with a ``TableManager``, fills every seat
with the Phase 2 bots and lets the runners deal until each table has played
the given number of hands. Meanwhile a heartbeat task measures how late the
event loop wakes it, which shows whether anything blocks the loop. The
report checks that the chips at each table equal what was bought in.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
import time
from collections.abc import Sequence

from .runner import RunnerOptions, TableManager, TableRunner, default_bots
from .table import Event, TableConfig

KINDS = ("heuristic", "random", "calling_station")


async def _no_wait(_: float) -> None:
    await asyncio.sleep(0)


async def simulate(seat_counts: Sequence[int], hands: int, seed: int) -> dict[str, object]:
    rngs = iter(random.Random(seed * 100 + i) for i in range(len(seat_counts)))
    options = RunnerOptions(hand_pause=0.0, bot_delay=0.0, sleep=_no_wait, rng_factory=lambda: next(rngs))
    manager = TableManager(default_bots(), options)
    bought: dict[str, int] = {}
    counts: dict[str, dict[str, int]] = {}

    async def tally(runner: TableRunner, events: Sequence[Event]) -> None:
        table_counts = counts.setdefault(runner.table_id, {})
        for event in events:
            table_counts[event.kind] = table_counts.get(event.kind, 0) + 1
            if event.kind == "seated":
                bought[runner.table_id] = bought.get(runner.table_id, 0) + event.data["stack"]
            elif event.kind == "rebought":
                bought[runner.table_id] = bought.get(runner.table_id, 0) + event.data["amount"]

    lags: list[float] = []
    stop = asyncio.Event()

    async def heartbeat() -> None:
        interval = 0.005
        while not stop.is_set():
            before = time.perf_counter()
            await asyncio.sleep(interval)
            lags.append(time.perf_counter() - before - interval)

    beat = asyncio.create_task(heartbeat())
    started = time.perf_counter()
    runners = []
    for n in seat_counts:
        runner = manager.create(TableConfig(n, 50, 100), table_id=f"sim-{n}")
        runner.listeners.append(tally)
        for seat in range(n):
            await runner.seat_bot(seat, KINDS[seat % len(KINDS)])
        runners.append(runner)
    await asyncio.gather(
        *(r.wait_until(lambda t: t.hand_no >= hands and not t.hand_in_progress, timeout=3600) for r in runners)
    )
    elapsed = time.perf_counter() - started
    stop.set()
    await beat
    await manager.shutdown()
    tables = []
    for runner in runners:
        table = runner.table
        chips = sum(p.stack for _, p in table.players())
        tables.append(
            {
                "seats": table.config.seat_count,
                "hands": table.hand_no,
                "chips_at_table": chips,
                "chips_bought": bought[runner.table_id],
                "conserved": chips == bought[runner.table_id],
                "events": counts[runner.table_id],
            }
        )
    lags.sort()
    return {
        "seed": seed,
        "seconds": round(elapsed, 2),
        "hands_per_second": round(sum(t["hands"] for t in tables) / elapsed, 1),  # type: ignore[misc]
        "loop_lag_ms": {
            "p50": round(lags[len(lags) // 2] * 1000, 2),
            "p99": round(lags[int(len(lags) * 0.99)] * 1000, 2),
            "max": round(lags[-1] * 1000, 2),
        },
        "tables": tables,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seats", default="2,6,9", help="comma-separated seat counts, one table each")
    parser.add_argument("--hands", type=int, default=200, help="hands per table")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)
    seat_counts = [int(s) for s in args.seats.split(",")]
    report = asyncio.run(simulate(seat_counts, args.hands, args.seed))
    print(json.dumps(report, indent=2))
    return 0 if all(t["conserved"] for t in report["tables"]) else 1  # type: ignore[union-attr]


if __name__ == "__main__":
    sys.exit(main())
