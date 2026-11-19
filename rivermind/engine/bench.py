"""Measure random self-play speed on one core (P2.6).

Run ``python -m rivermind.engine.bench``. Every seat starts each hand with
100 big blinds at blinds of 50/100, the button moves each hand and actions
come from ``fuzz.random_action``, so hands reach every street and showdown.
The ``engine`` mode measures only ``start_hand``, ``legal_actions`` and
``apply``; the ``view`` mode also builds a ``SeatView`` for every decision
and asks ``RandomPolicy`` for the action, as a bot at a table would.
The target is 2,000 complete six-seat hands per second in engine mode.
"""

from __future__ import annotations

import argparse
import json
import platform
import random
import statistics
import sys
import time
from collections.abc import Sequence

from .fuzz import random_action
from .state import HandConfig, apply, legal_actions, start_hand

TARGET_SIX_SEAT_HANDS_PER_SECOND = 2_000


def _play(num_seats: int, hands: int, seed: int, mode: str) -> tuple[float, int, int]:
    rng = random.Random(seed)
    config = HandConfig(50, 100)
    stacks = [10_000] * num_seats
    actions = showdowns = 0
    if mode == "view":
        from rivermind.bots import RandomPolicy

        from .view import seat_view

        policy = RandomPolicy()
    started = time.perf_counter()
    for hand in range(hands):
        state = start_hand(config, stacks, hand % num_seats, rng=rng)
        while state.to_act is not None:
            if mode == "view":
                action = policy.act(seat_view(state, state.to_act), rng)
            else:
                action = random_action(state, legal_actions(state), rng)
            state = apply(state, action)
            actions += 1
        assert state.result is not None
        showdowns += state.result.showdown
    return time.perf_counter() - started, actions, showdowns


def run(seat_counts: Sequence[int], hands: int, repeats: int, seed: int, mode: str) -> dict[str, object]:
    results: dict[str, object] = {}
    for num_seats in seat_counts:
        rates = []
        for repeat in range(repeats):
            seconds, actions, showdowns = _play(num_seats, hands, seed + repeat, mode)
            rates.append((hands / seconds, actions / seconds, actions, showdowns))
        best = max(rates)
        results[str(num_seats)] = {
            "hands_per_second_median": round(statistics.median(r[0] for r in rates)),
            "hands_per_second_best": round(best[0]),
            "actions_per_second_median": round(statistics.median(r[1] for r in rates)),
            "actions_per_hand": round(best[2] / hands, 2),
            "showdown_share": round(best[3] / hands, 3),
        }
    six = results.get("6")
    return {
        "mode": mode,
        "hands_per_repeat": hands,
        "repeats": repeats,
        "seed": seed,
        "python": platform.python_version(),
        "machine": f"{platform.system()} {platform.machine()}",
        "seat_counts": results,
        "target_six_seat_hands_per_second": TARGET_SIX_SEAT_HANDS_PER_SECOND,
        "meets_target": None if six is None else six["hands_per_second_median"] >= TARGET_SIX_SEAT_HANDS_PER_SECOND,  # type: ignore[index]
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seats", default="2,6,9", help="comma-separated seat counts")
    parser.add_argument("--hands", type=int, default=20_000, help="hands per repeat")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--mode", choices=("engine", "view"), default="engine")
    args = parser.parse_args(argv)
    seat_counts = [int(x) for x in args.seats.split(",")]
    json.dump(run(seat_counts, args.hands, args.repeats, args.seed, args.mode), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
