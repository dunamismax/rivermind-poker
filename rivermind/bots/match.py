"""Duplicate, seat-rotated matches on the engine (P5.4; full tables at P5.6).

Each **deal** is one shuffled deck played twice: once with the candidate on
the button and once with the opponent there, so both players hold each
pair of hole cards and the board is the same. Both hands start from the
same stacks. A deal's value is the candidate's mean winnings over its two
hands, and the 95% interval is computed over deals, which are independent,
with both seat rotations kept together.

At a table of more than two (``Matchup.seats``), each deal is played once
for every seat: the candidate sits in each seat in turn against a copy of
the opponent in every other seat, the button stays where it is, and the
deal's value is the candidate's mean winnings over those hands.

Everything random comes from the seed: deal *i* shuffles its deck with
``Random((seed, i))`` and each seat's policy draws from its own generator
seeded by the seed, the deal, the rotation and the seat. Deals are shared
out among worker processes in fixed blocks and summed in deal order, so a
match gives the same report whatever the number of workers.
"""

from __future__ import annotations

import hashlib
import math
import multiprocessing as mp
import random
from collections import Counter
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from rivermind.engine import HandConfig, apply, start_hand
from rivermind.engine.view import seat_view

from .policies import CallingStationPolicy, HeuristicPolicy, MinBetPolicy, Policy, RandomPolicy

SIMPLE = {
    "random": RandomPolicy,
    "calling_station": CallingStationPolicy,
    "heuristic": HeuristicPolicy,
    "min_bettor": MinBetPolicy,
}
"""Opponents by name. ``heuristic`` is RiverMind Easy on the site."""
BLOCK = 50
"""Deals per worker task."""


@lru_cache(maxsize=4)
def _loaded(checkpoint: str, tables: str | None) -> tuple[Any, Any]:
    """A blueprint and its card tables, opened once per process and shared by fresh policies."""
    from .blueprint import Blueprint
    from .cards import CardTables

    bp = Blueprint(checkpoint)
    return bp, CardTables(tables or bp.manifest["cards"]["path"])


@lru_cache(maxsize=4)
def _bundle(path: str) -> Any:
    """A serving bundle, opened once per process. ``describe_policy`` checks its files; the workers do not repeat that."""
    from .blueprint.bundle import ServingBundle

    return ServingBundle(path, verify=False)


def make_policy(spec: str, tables: str | None = None) -> Policy:
    """A policy from its name, ``blueprint:<checkpoint>`` for a trained blueprint or ``bundle:<directory>`` for a serving bundle.

    ``medium:`` before either is RiverMind Medium for it: that model mixed with
    RiverMind Easy, a hand at a time (``levels.py``, P5.7).

    A bundle plays its own ``uint8`` strategy on its own card-table arrays,
    which is what the site serves (P4B.6), so ``tables`` does not apply to it.
    """
    if spec in SIMPLE:
        return SIMPLE[spec]()
    if spec.startswith("blueprint:"):
        from .blueprint.policy import policy_for

        return policy_for(*_loaded(spec.split(":", 1)[1], tables))
    if spec.startswith("bundle:"):
        policy: Policy = _bundle(spec.split(":", 1)[1]).policy()
        return policy
    if spec.startswith("medium:"):
        from .levels import medium

        return medium(make_policy(spec.split(":", 1)[1], tables))
    raise ValueError(f"unknown policy {spec!r}; use one of {', '.join(SIMPLE)}, blueprint:<checkpoint>, bundle:<directory> or medium:<either>")


@dataclass(frozen=True)
class Matchup:
    candidate: str
    opponent: str
    stack_bb: int = 100
    deals: int = 1_000
    seed: int = 0
    small_blind: int = 50
    big_blind: int = 100
    tables: str | None = None
    seats: int = 2

    @property
    def stack(self) -> int:
        return self.stack_bb * self.big_blind


def position_names(seats: int) -> list[str]:
    """Each seat's position by its number, the button being seat 0 (``docs/bots.md``)."""
    if seats == 2:
        return ["button", "big_blind"]
    middle = seats - 3  # the seats between the big blind and the button
    late = ["lojack", "hijack", "cutoff"][-(3 if middle >= 4 else min(middle, 2)) :] if middle else []
    names = [f"utg+{i}" if i else "utg" for i in range(middle - len(late))] + late
    return ["button", "small_blind", "big_blind", *names]


@dataclass
class Result:
    matchup: Matchup
    deals: int = 0
    total: float = 0.0
    """Sum over deals of the candidate's mean winnings per hand, in chips."""
    total_squares: float = 0.0
    button: float = 0.0
    """The candidate's winnings on the button, summed over deals."""
    big_blind: float = 0.0
    showdowns: int = 0
    candidate_stats: Counter[str] = field(default_factory=Counter)
    positions: list[float] = field(default_factory=list)
    """At a table of more than two: the candidate's winnings in each seat (the button is seat 0), summed over deals."""

    def add(self, other: Result) -> None:
        self.deals += other.deals
        self.total += other.total
        self.total_squares += other.total_squares
        self.button += other.button
        self.big_blind += other.big_blind
        self.showdowns += other.showdowns
        self.candidate_stats.update(other.candidate_stats)
        if other.positions:
            if not self.positions:
                self.positions = [0.0] * len(other.positions)
            for i, x in enumerate(other.positions):
                self.positions[i] += x

    def summary(self) -> dict[str, Any]:
        n = self.deals
        bb = self.matchup.big_blind
        mean = self.total / n if n else 0.0
        variance = (self.total_squares - n * mean * mean) / (n - 1) if n > 1 else 0.0
        half = 1.96 * math.sqrt(max(variance, 0.0) / n) if n else 0.0
        seats = self.matchup.seats
        out: dict[str, Any] = {
            "deals": n,
            "hands": seats * n,
            "bb_per_100": round(100 * mean / bb, 2),
            "ci95_bb_per_100": [round(100 * (mean - half) / bb, 2), round(100 * (mean + half) / bb, 2)],
            "button_bb_per_100": round(100 * self.button / n / bb, 2) if n else 0.0,
            "big_blind_bb_per_100": round(100 * self.big_blind / n / bb, 2) if n else 0.0,
            "showdown_share": round(self.showdowns / (seats * n), 4) if n else 0.0,
        }
        if seats != 2:
            out["position_bb_per_100"] = {
                name: round(100 * x / n / bb, 2) if n else 0.0 for name, x in zip(position_names(seats), self.positions or [0.0] * seats)
            }
        stats = self.candidate_stats
        if stats.get("decisions"):
            out["candidate_decisions"] = dict(sorted(stats.items()))
            out["trained_share"] = round(stats["trained"] / stats["decisions"], 4)
        return out


def deck_for(seed: int, deal: int) -> list[int]:
    deck = list(range(52))
    random.Random(_seed_int("deck", seed, deal)).shuffle(deck)
    return deck


def _seed_int(*parts: object) -> int:
    return int.from_bytes(hashlib.sha256(repr(parts).encode()).digest()[:8], "big")


def play_hand(policies: Sequence[Policy], rngs: Sequence[random.Random], deck: Sequence[int], stack: int, config: HandConfig) -> tuple[int, int, bool]:
    """Play one hand with seat 0 on the button; return each seat's winnings and whether it reached showdown."""
    for policy in policies:
        if hasattr(policy, "new_hand"):
            policy.new_hand()
    state = start_hand(config, [stack, stack], 0, deck=deck)
    while not state.is_over:
        seat = state.to_act
        assert seat is not None
        state = apply(state, policies[seat].act(seat_view(state, seat), rngs[seat]))
    final = state.final_stacks
    assert state.result is not None
    return (final[0] or 0) - stack, (final[1] or 0) - stack, state.result.showdown


def play_table(policies: Sequence[Policy], rngs: Sequence[random.Random], deck: Sequence[int], stack: int, config: HandConfig) -> tuple[list[int], bool]:
    """Play one hand at a full table with seat 0 on the button; return each seat's winnings and whether it reached showdown."""
    for policy in policies:
        if hasattr(policy, "new_hand"):
            policy.new_hand()
    state = start_hand(config, [stack] * len(policies), 0, deck=deck)
    while not state.is_over:
        seat = state.to_act
        assert seat is not None
        state = apply(state, policies[seat].act(seat_view(state, seat), rngs[seat]))
    final = state.final_stacks
    assert state.result is not None
    return [(f or 0) - stack for f in final], state.result.showdown


def _play_block_table(matchup: Matchup, first: int, last: int) -> Result:
    """``play_block`` at a table of more than two: the candidate once in every seat, the opponent in the others."""
    seats = matchup.seats
    candidate = make_policy(matchup.candidate, matchup.tables)
    opponents = [make_policy(matchup.opponent, matchup.tables) for _ in range(seats - 1)]
    config = HandConfig(matchup.small_blind, matchup.big_blind)
    result = Result(matchup, positions=[0.0] * seats)
    for deal in range(first, last):
        deck = deck_for(matchup.seed, deal)
        won = []
        for rotation in range(seats):
            table: list[Policy] = list(opponents)
            table.insert(rotation, candidate)
            rngs = [random.Random(_seed_int("seat", matchup.seed, deal, rotation, s)) for s in range(seats)]
            winnings, showdown = play_table(table, rngs, deck, matchup.stack, config)
            won.append(winnings[rotation])
            result.showdowns += showdown
        value = sum(won) / seats
        result.deals += 1
        result.total += value
        result.total_squares += value * value
        result.button += won[0]
        result.big_blind += won[2]
        for i, w in enumerate(won):
            result.positions[i] += w
    stats = getattr(candidate, "stats", None)
    if stats is not None:
        result.candidate_stats.update(stats)
    return result


def play_block(matchup: Matchup, first: int, last: int) -> Result:
    """Deals ``first`` to ``last - 1`` of a matchup, with fresh policies."""
    if matchup.seats != 2:
        return _play_block_table(matchup, first, last)
    candidate = make_policy(matchup.candidate, matchup.tables)
    opponent = make_policy(matchup.opponent, matchup.tables)
    config = HandConfig(matchup.small_blind, matchup.big_blind)
    result = Result(matchup)
    for deal in range(first, last):
        deck = deck_for(matchup.seed, deal)
        won = []
        for rotation in (0, 1):
            seats = (candidate, opponent) if rotation == 0 else (opponent, candidate)
            rngs = [random.Random(_seed_int("seat", matchup.seed, deal, rotation, s)) for s in (0, 1)]
            w0, w1, showdown = play_hand(seats, rngs, deck, matchup.stack, config)
            won.append(w0 if rotation == 0 else w1)
            result.showdowns += showdown
        value = (won[0] + won[1]) / 2
        result.deals += 1
        result.total += value
        result.total_squares += value * value
        result.button += won[0]
        result.big_blind += won[1]
    stats = getattr(candidate, "stats", None)
    if stats is not None:
        result.candidate_stats.update(stats)
    return result


def _play_block_args(args: tuple[Matchup, int, int]) -> Result:
    return play_block(*args)


def run_matchup(matchup: Matchup, workers: int = 1) -> Result:
    blocks = [(matchup, lo, min(matchup.deals, lo + BLOCK)) for lo in range(0, matchup.deals, BLOCK)]
    if workers <= 1 or len(blocks) == 1:
        parts = [play_block(*b) for b in blocks]
    else:
        with mp.get_context("spawn").Pool(min(workers, len(blocks))) as pool:
            parts = pool.map(_play_block_args, blocks, chunksize=1)
    total = Result(matchup)
    for part in parts:  # in deal order
        total.add(part)
    return total


def describe_policy(spec: str) -> dict[str, Any]:
    """What a report records about a policy: its source's hash, or a checkpoint's identity."""
    if spec.startswith("medium:"):
        from .levels import MEDIUM_SHARE

        levels = Path(__file__).with_name("levels.py").read_bytes()
        return {
            "spec": "medium",
            "share": MEDIUM_SHARE,
            "strong": describe_policy(spec.split(":", 1)[1]),
            "weak": describe_policy("heuristic"),
            "source": "rivermind/bots/levels.py",
            "source_sha256": hashlib.sha256(levels).hexdigest(),
        }
    if spec.startswith("blueprint:"):
        from .blueprint import read_manifest

        path = Path(spec.split(":", 1)[1])
        m = read_manifest(path)
        return {
            "spec": "blueprint",
            "checkpoint": str(path),
            "iteration": m["iteration"],
            "files": {k: v["sha256"] for k, v in m["files"].items()},
            "trees": [t["sha256"] for t in m["game"]["trees"]],
            "cards": m["cards"]["sha256"],
            "trained_by": m.get("software", {}).get("commit"),
        }
    if spec.startswith("bundle:"):
        from .blueprint.bundle import ServingBundle

        path = Path(spec.split(":", 1)[1])
        b = ServingBundle(path, verify=True).manifest
        return {
            "spec": "bundle",
            "bundle": str(path),
            "iteration": b["checkpoint"].get("iteration"),
            "levels": b["strategy"]["levels"],
            "files": {k: v["sha256"] for k, v in b["files"].items()},
            "trees": [t["sha256"] for t in b["game"]["trees"]],
            "cards": b["cards"]["sha256"],
            "table_set": b["cards"]["table_set"],
            "exported_from": {k: b["checkpoint"].get(k) for k in ("manifest_sha256", "strategy_sha256")},
            "exported_by": b["software"].get("git_commit"),
        }
    source = Path(__file__).with_name("policies.py").read_bytes()
    return {"spec": spec, "source": "rivermind/bots/policies.py", "source_sha256": hashlib.sha256(source).hexdigest()}


def matchup_record(matchup: Matchup) -> dict[str, Any]:
    out = asdict(matchup)
    out.pop("tables")
    if matchup.seats == 2:
        out.pop("seats")
    return out


def policy_seats(spec: str) -> int:
    """The table size a policy is for: a blueprint's or a bundle's abstraction says; the simple bots play any, so 2."""
    if spec.startswith("medium:"):
        return policy_seats(spec.split(":", 1)[1])
    if not spec.startswith(("blueprint:", "bundle:")):
        return 2
    import json

    from .blueprint.abstraction import abstraction_named

    manifest = json.loads((Path(spec.split(":", 1)[1]) / "manifest.json").read_text())
    return abstraction_named(manifest.get("abstraction", "hu-m1")).seats


DEFAULT_PLAN: tuple[tuple[str, int], ...] = (
    ("heuristic", 100),
    ("calling_station", 100),
    ("random", 100),
    ("min_bettor", 100),
    ("heuristic", 40),
    ("heuristic", 150),
    ("calling_station", 40),
    ("calling_station", 150),
)
"""The P5.4 plan: every opponent at 100 big blinds, and the promotion gate's two at 40 and 150."""

FORMAT = 1
KIND = "rivermind-evaluation"


def evaluate(
    candidate: str,
    plan: Sequence[tuple[str, int]],
    *,
    deals: int,
    seed: int,
    workers: int = 1,
    tables: str | None = None,
    progress: Any = None,
    seats: int | None = None,
) -> dict[str, Any]:
    """Run every matchup of a plan and return the report (without timings, so a rerun matches it exactly).

    ``seats`` plays a multiway candidate at a smaller table than its own, of
    three seats or more: the six-seat game with its first seats folded (P5.7).
    Such a report has no format, so it is never put to the gate.
    """
    from .blueprint.train import engine_identity, software

    own = policy_seats(candidate)
    if seats is None:
        seats = own
    elif seats != own and not (own > 2 and 3 <= seats <= own):
        raise ValueError(f"{candidate} plays tables of {own}" + (f", or of 3 to {own}" if own > 2 else "") + f", not {seats}")
    for opponent, _ in plan:
        if opponent.startswith(("blueprint:", "bundle:")) and policy_seats(opponent) != own:
            raise ValueError(f"{opponent} does not play at a table of {own}")
    results = []
    for opponent, stack_bb in plan:
        matchup = Matchup(candidate, opponent, stack_bb=stack_bb, deals=deals, seed=seed, tables=tables, seats=seats)
        summary = run_matchup(matchup, workers).summary()
        results.append({"opponent": opponent, "stack_bb": stack_bb, **summary})
        if progress is not None:
            progress(results[-1])
    code = software()
    game = {
        "rules": "no-limit Texas hold'em, 52-card deck, heads-up, no ante (docs/rules.md)",
        "seats": 2,
        "blinds": [50, 100],
        "format": "duplicate: each deal played twice with the seats swapped, fresh stacks each hand",
        "interval": "95%, normal approximation over deals, both rotations of a deal together",
    }
    if seats != 2:
        game = {
            "rules": f"no-limit Texas hold'em, 52-card deck, {seats} seats, no ante (docs/rules.md)",
            "seats": seats,
            "blinds": [50, 100],
            "format": f"duplicate: each deal played {seats} times, the candidate once in every seat against {seats - 1} copies of the opponent, fresh stacks each hand",
            "interval": f"95%, normal approximation over deals, all {seats} rotations of a deal together",
        }
    return {
        "format": FORMAT,
        "kind": KIND,
        "game": game,
        "seed": seed,
        "deals_per_matchup": deals,
        "candidate": describe_policy(candidate),
        "opponents": {o: describe_policy(o) for o in sorted({o for o, _ in plan})},
        "engine": engine_identity(),
        "software": {k: code[k] for k in ("python", "numpy", "commit", "dirty")},
        "results": results,
    }


def render_markdown(report: dict[str, Any], *, name: str, command: str) -> str:
    c = report["candidate"]
    if c["spec"] == "medium":
        strong = c["strong"]
        model = f"the serving bundle `{strong['bundle']}`" if strong["spec"] == "bundle" else f"`{strong.get('checkpoint', strong['spec'])}`"
        candidate = (
            f"Candidate: RiverMind Medium, which plays each hand as {model}"
            + (f" ({strong['iteration']:,} iterations, `strategy.u8` `{strong['files']['strategy.u8'][:8]}…`)" if strong["spec"] == "bundle" else "")
            + f" with probability {c['share']:g} and as RiverMind Easy (the heuristic) otherwise, drawn once a hand (`rivermind/bots/levels.py`)."
            " “Trained data” counts the model’s decisions only."
        )
    elif c["spec"] == "bundle":
        iterations = f", {c['iteration']:,} iterations" if c.get("iteration") else ""
        candidate = (
            f"Candidate: the serving bundle `{c['bundle']}`{iterations}: the strategy the site serves,"
            f" rounded to multiples of 1/{c['levels']} (`strategy.u8` `{c['files']['strategy.u8'][:8]}…`),"
            f" on the bundle’s own card tables (table set `{c['table_set'][:8]}…`)."
        )
    else:
        candidate = f"Candidate: `{c.get('checkpoint', c['spec'])}`" + (
            f", {c['iteration']:,} iterations, trained at `{(c.get('trained_by') or 'unknown')[:7]}`." if "iteration" in c else "."
        )
    seats = report["game"]["seats"]
    lines = [
        f"# Evaluation: {name}",
        "",
        candidate,
        f"Game: {report['game']['rules']}; blinds 50/100; {report['game']['format']}.",
        f"Seed {report['seed']}, {report['deals_per_matchup']:,} deals ({seats * report['deals_per_matchup']:,} hands) per matchup;"
        f" evaluated at `{(report['software']['commit'] or 'unknown')[:7]}`{' with local changes' if report['software']['dirty'] else ''}.",
        "",
        "| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in report["results"]:
        lo, hi = r["ci95_bb_per_100"]
        share = f"{100 * r['trained_share']:.1f}%" if "trained_share" in r else "—"
        lines.append(
            f"| {r['opponent']} | {r['stack_bb']} | {r['bb_per_100']:+.2f} | {lo:+.2f} to {hi:+.2f} | {r['button_bb_per_100']:+.2f} | {r['big_blind_bb_per_100']:+.2f} | {share} |"
        )
    lines += [
        "",
        "“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.",
        "",
    ]
    if seats != 2:
        names = position_names(seats)
        lines += [
            "The candidate’s result in each seat, in big blinds per 100 hands:",
            "",
            "| Opponent | Stacks (bb) | " + " | ".join(n.replace("_", " ") for n in names) + " |",
            "| --- | --- | " + " | ".join("---" for _ in names) + " |",
        ]
        for r in report["results"]:
            by_seat = r["position_bb_per_100"]
            lines.append(f"| {r['opponent']} | {r['stack_bb']} | " + " | ".join(f"{by_seat[n]:+.2f}" for n in names) + " |")
        lines.append("")
    lines += [
        "Reproduce with:",
        "",
        "```sh",
        command,
        "```",
        "",
    ]
    return "\n".join(lines)


GATE_OPPONENTS = ("heuristic", "calling_station")
GATE_STACK_BB = 100


def gate(report: dict[str, Any], incumbent: str | None = None, stack_bb: int = GATE_STACK_BB) -> dict[str, Any]:
    """The P5.5 promotion gate on a report: the 95% interval's lower bound above zero against each gate opponent.

    A replacement must also clear it against the incumbent (``blueprint:<checkpoint>``
    or ``bundle:<directory>``), which the report must have played. Each check's
    ``outcome`` is ``passed``, ``failed`` when the whole interval is below zero,
    ``inconclusive`` when it spans zero, or ``missing``; the report's is the
    worst of them.
    """
    wanted = list(GATE_OPPONENTS) + ([incumbent] if incumbent else [])
    checks = []
    for opponent in wanted:
        found = [r for r in report["results"] if r["opponent"] == opponent and r["stack_bb"] == stack_bb]
        if not found:
            checks.append({"opponent": opponent, "stack_bb": stack_bb, "passed": False, "outcome": "missing", "reason": "not in the report"})
            continue
        r = found[0]
        lower, upper = r["ci95_bb_per_100"]
        checks.append(
            {
                "opponent": opponent,
                "stack_bb": stack_bb,
                "bb_per_100": r["bb_per_100"],
                "ci95_bb_per_100": r["ci95_bb_per_100"],
                "passed": lower > 0,
                "outcome": "passed" if lower > 0 else "failed" if upper < 0 else "inconclusive",
            }
        )
    outcomes = {c["outcome"] for c in checks}
    outcome = next(o for o in ("missing", "failed", "inconclusive", "passed") if o in outcomes)
    return {"passed": all(c["passed"] for c in checks), "outcome": outcome, "checks": checks}
