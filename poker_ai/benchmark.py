"""Reproducible three-seat matches: one candidate bot against two random bots.

Each deal is played three times with the same cards, rotating the candidate
through every seat (small blind, big blind, button). Cards come from the
global generators seeded per deal; every policy draws from its own
`random.Random` seeded per deal, rotation and seat, so a result depends only
on the inputs recorded in the report.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import random
import statistics
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import click
import joblib

from poker_ai import utils
from poker_ai.games.short_deck.state import InfoSetLookupTable, new_game
from poker_ai.policies import CheckpointPolicy, Policy, RandomPolicy, seat_view

N_SEATS = 3
SEAT_NAMES = ["small_blind", "big_blind", "button"]
BIG_BLIND = 100
RULES = {
    "game": "three-seat limit hold'em, 20-card deck",
    "ranks": "ten through ace",
    "seats": N_SEATS,
    "starting_chips": 10000,
    "blinds": [50, BIG_BLIND],
    "raises_per_round": 3,
    "candidate_seats": SEAT_NAMES,
    "opponents": "two uniform-random legal-action bots",
}
PolicyFactory = Callable[[random.Random], Policy]


def _seat_rng(seed: int, deal: int, rotation: int, seat: int) -> random.Random:
    return random.Random(f"{seed}:{deal}:{rotation}:{seat}")


def play_hand(
    policies: List[Policy], card_info_lut: InfoSetLookupTable, deal_seed: int
) -> Dict[int, int]:
    """Play one hand from a seeded deal and return each seat's net chips."""
    utils.random.seed(deal_seed)
    if card_info_lut:
        state = new_game(N_SEATS, card_info_lut)
    else:
        state = new_game(N_SEATS, {}, load_card_lut=False)
    while not state.is_terminal:
        view = seat_view(state)
        action = policies[view.seat].choose(view)
        if action not in view.legal_actions:
            raise ValueError(f"Seat {view.seat} chose illegal action {action}")
        state = state.apply_action(action)
    return dict(state.payout)


def run_match(
    candidate: PolicyFactory,
    card_info_lut: InfoSetLookupTable,
    n_deals: int,
    seed: int,
) -> Dict[str, Any]:
    """Play `n_deals` deals in every seat and summarise the candidate's chips."""
    per_deal: List[float] = []
    per_seat: List[List[int]] = [[] for _ in range(N_SEATS)]
    for deal in range(n_deals):
        deal_seed = seed * 1_000_003 + deal
        results = []
        for rotation in range(N_SEATS):
            policies: List[Policy] = [
                candidate(_seat_rng(seed, deal, rotation, seat))
                if seat == rotation
                else RandomPolicy(_seat_rng(seed, deal, rotation, seat))
                for seat in range(N_SEATS)
            ]
            payout = play_hand(policies, card_info_lut, deal_seed)
            if sum(payout.values()) != 0:
                raise AssertionError(f"Chips not conserved on deal {deal}")
            results.append(payout[rotation])
            per_seat[rotation].append(payout[rotation])
        per_deal.append(sum(results) / N_SEATS)
    mean = statistics.fmean(per_deal)
    # Deals are independent; the three rotations of a deal share cards, so
    # the standard error is taken over per-deal means.
    se = statistics.stdev(per_deal) / math.sqrt(n_deals) if n_deals > 1 else 0.0
    return {
        "deals": n_deals,
        "hands": n_deals * N_SEATS,
        "net_chips_per_hand": mean,
        "standard_error": se,
        "ci95": [mean - 1.96 * se, mean + 1.96 * se],
        "big_blinds_per_100_hands": mean / BIG_BLIND * 100,
        "net_chips_per_hand_by_seat": {
            SEAT_NAMES[s]: statistics.fmean(v) for s, v in enumerate(per_seat)
        },
    }


class _CoverageCounter:
    """Wrap a checkpoint policy to count decisions it has an info set for."""

    def __init__(self, strategy):
        self.strategy = strategy
        self.decisions = 0
        self.seen = 0

    def __call__(self, rng: random.Random) -> Policy:
        policy = CheckpointPolicy(self.strategy, rng)
        choose = policy.choose

        def counted(view):
            self.decisions += 1
            self.seen += policy.has_info_set(view)
            return choose(view)
        policy.choose = counted
        return policy


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def evaluate(
    agent: str,
    n_deals: int,
    seed: int,
    strategy_path: Optional[str] = None,
    lut_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Build a match report for `agent` ("offline" or the "random" control)."""
    report: Dict[str, Any] = {"rules": RULES, "seed": seed, "candidate": agent}
    card_info_lut: InfoSetLookupTable = {}
    if agent == "offline":
        if not strategy_path or lut_path is None:
            raise click.UsageError("--agent offline needs --strategy_path and --lut_path")
        checkpoint = joblib.load(strategy_path)
        table_file = Path(lut_path) / "card_info_lut.joblib"
        card_info_lut = joblib.load(table_file)
        resume_state = checkpoint.get("resume_state", {})
        report["artifacts"] = {
            "checkpoint": os.path.abspath(strategy_path),
            "checkpoint_sha256": sha256(Path(strategy_path)),
            "checkpoint_timestep": checkpoint.get("timestep"),
            "card_table": os.path.abspath(table_file),
            "card_table_sha256": sha256(table_file),
            "training_settings": {
                k: v for k, v in resume_state.items() if k != "rng_state"
            },
        }
        candidate = _CoverageCounter(checkpoint["strategy"])
    elif agent == "random":
        candidate = RandomPolicy
    else:
        raise click.UsageError(f"Unknown agent {agent}")
    report["results"] = run_match(candidate, card_info_lut, n_deals, seed)
    if isinstance(candidate, _CoverageCounter):
        report["results"]["checkpoint_decisions"] = candidate.decisions
        report["results"]["checkpoint_info_set_coverage"] = (
            candidate.seen / candidate.decisions if candidate.decisions else None
        )
    return report


@click.command()
@click.option("--agent", default="offline", type=click.Choice(["offline", "random"]),
              help="Candidate bot; random runs the random-versus-random control.")
@click.option("--strategy_path", default=None, help="Checkpoint (agent.joblib).")
@click.option("--lut_path", default=None, help="Directory with the matching card table.")
@click.option("--deals", "n_deals", default=1000, show_default=True,
              help="Deals to play; each is played once per seat.")
@click.option("--seed", default=0, show_default=True)
@click.option("--output", default=None, help="Write the JSON report here too.")
def evaluate_command(agent, strategy_path, lut_path, n_deals, seed, output):
    """Play a fixed-seed match against two random bots and report chips per hand."""
    report = evaluate(agent, n_deals, seed, strategy_path, lut_path)
    report["created"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    text = json.dumps(report, indent=2, cls=utils.io.NumpyJSONEncoder, default=str)
    if output:
        Path(output).write_text(text + "\n")
    click.echo(text)
