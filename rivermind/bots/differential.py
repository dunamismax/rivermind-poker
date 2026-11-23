"""Reference outputs for the TypeScript bots' differential tests (P4B.6).

The Python bots are the reference. The commands write what the TypeScript
ports in ``web/src/lib/server/bots`` must reproduce:

``policies``
    Hands on the fuzz deals (``fuzz.random_config`` and ``random_stacks``)
    at 2 to 9 seats, every seat played by one of the random, calling-station,
    heuristic (RiverMind Easy) and min-bet bots. Each line is the hand's bots
    and the seed of the one ``random.Random`` they share, then the hand
    record. The checker plays the same deal with its bots and a generator
    seeded the same way, and its record must be byte-identical.
``blueprint``
    Heads-up hands of a serving bundle's blueprint against each of those
    bots and itself, at random stacks and blinds, until it has made
    ``--decisions`` decisions. Each line also lists the probabilities of
    every blueprint decision (``null`` where it had no data) and its
    statistics so far.
``medium``
    Heads-up hands of RiverMind Medium made from a serving bundle (P5.7)
    against each of the simple bots, the blueprint and itself, in the same
    form as ``blueprint``, with which bot Medium chose for each of its
    decisions (``strong``) and the blueprint's probabilities where it chose
    the blueprint. Made from a multiway bundle, the hands are at a table of
    its size with three or more dealt in, Medium in at least one seat and the
    simple bots, the blueprint or Medium in the others, as ``multiway`` deals
    them.
``multiway``
    Hands of a multiway bundle's blueprint at a table of its size with three
    or more dealt in, the blueprint in at least one seat and the simple bots
    or itself in the others, at random stacks and blinds, in the same form
    as ``blueprint``.
``buckets``
    Card-bucket digests: every hole-card pair on a seeded sample of boards
    for each street, from the original card tables when ``--tables`` is
    given and otherwise from the bundle.
``synthetic``
    Write a synthetic bundle (the real trees, random strategies and card
    tables) for checks that have no trained bundle, such as CI.

``pnpm bots:parity`` in ``web/`` runs them and checks the TypeScript side.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, TextIO

import numpy as np

from rivermind.engine.differential import SplitMix32, parse_seats
from rivermind.engine.fuzz import random_config, random_stacks
from rivermind.engine.history import dumps, hand_record
from rivermind.engine.state import HandConfig, HandState, apply, start_hand
from rivermind.engine.view import seat_view

from .cards.build import STREETS
from .cards.equity import INVALID
from .cards.iso import PERMS, pair_cards, permuted_pairs, set_rank
from .policies import (
    CallingStationPolicy,
    HeuristicPolicy,
    MinBetPolicy,
    Policy,
    RandomPolicy,
)

SIMPLE = ("random", "calling_station", "heuristic", "min_bettor")
MAX_ACTIONS = 4_000


def simple_bots() -> dict[str, Policy]:
    return {
        "random": RandomPolicy(),
        "calling_station": CallingStationPolicy(),
        "heuristic": HeuristicPolicy(),
        "min_bettor": MinBetPolicy(),
    }


def play(state: HandState, seats: Sequence[str], bots: Mapping[str, Policy], rng: random.Random, on_act: Any = None) -> HandState:
    """Play a hand to the end, each seat's bot drawing from the one ``rng``."""
    steps = 0
    while not state.is_over:
        seat = state.to_act
        assert seat is not None
        policy = bots[seats[seat]]
        action = policy.act(seat_view(state, seat), rng)
        if on_act is not None:
            on_act(policy)
        state = apply(state, action)
        steps += 1
        if steps > MAX_ACTIONS:
            raise RuntimeError("the hand did not end")
    return state


def write_policies(out: TextIO, hands: int, seat_counts: Sequence[int], seed: int) -> int:
    bots = simple_bots()
    written = 0
    for num_seats in seat_counts:
        deals = random.Random(seed * 1_000 + num_seats)
        for _ in range(hands):
            config = random_config(deals)
            stacks = random_stacks(num_seats, config, deals)
            dealt = [s for s, stack in enumerate(stacks) if stack]
            button = deals.choice(dealt)
            deck = list(range(52))
            deals.shuffle(deck)
            seats = [deals.choice(SIMPLE) for _ in range(num_seats)]
            bot_seed = deals.getrandbits(64)
            final = play(start_hand(config, stacks, button, deck=deck), seats, bots, random.Random(bot_seed))
            out.write(f"{dumps({'bots': seats, 'seed': str(bot_seed)})}\t{dumps(hand_record(final))}\n")
            written += 1
    return written


def write_blueprint(out: TextIO, bundle_path: Path, decisions: int, seed: int) -> int:
    from .blueprint.bundle import ServingBundle

    bundle = ServingBundle(bundle_path)
    blueprint = bundle.policy()
    bots: dict[str, Policy] = {**simple_bots(), "blueprint": blueprint}
    deals = random.Random(seed)
    made = 0
    hands = 0
    while made < decisions:
        opponent = deals.choice((*SIMPLE, "blueprint"))
        seats = ["blueprint", opponent] if deals.random() < 0.5 else [opponent, "blueprint"]
        config = HandConfig(50, 100) if deals.random() < 0.8 else HandConfig(*sorted((deals.randint(1, 200), deals.randint(1, 200))))
        big = config.big_blind
        stacks = [deals.randint(10 * big, 250 * big) for _ in range(2)]
        button = deals.randrange(2)
        deck = list(range(52))
        deals.shuffle(deck)
        bot_seed = deals.getrandbits(64)
        probabilities: list[list[float] | None] = []

        def record(policy: Policy, probabilities: list[list[float] | None] = probabilities) -> None:
            if policy is blueprint:
                probabilities.append(blueprint.last_probabilities)

        blueprint.new_hand()
        final = play(start_hand(config, stacks, button, deck=deck), seats, bots, random.Random(bot_seed), record)
        made += len(probabilities)
        hands += 1
        meta = {"bots": seats, "seed": str(bot_seed), "probabilities": probabilities, "stats": dict(sorted(blueprint.stats.items()))}
        out.write(f"{json.dumps(meta, separators=(',', ':'), sort_keys=True)}\t{dumps(hand_record(final))}\n")
    return hands


def write_medium(out: TextIO, bundle_path: Path, decisions: int, seed: int) -> int:
    """Heads-up hands of RiverMind Medium, until it has made ``decisions`` decisions."""
    from .blueprint.bundle import ServingBundle
    from .levels import medium

    bundle = ServingBundle(bundle_path)
    if bundle.game.seats != 2:
        return _write_medium_multiway(out, bundle, decisions, seed)
    mixed = medium(bundle.policy())
    blueprint = bundle.policy()
    bots: dict[str, Policy] = {**simple_bots(), "blueprint": blueprint, "medium": mixed}
    deals = random.Random(seed)
    made = 0
    hands = 0
    while made < decisions:
        opponent = deals.choice((*SIMPLE, "blueprint", "medium"))
        seats = ["medium", opponent] if deals.random() < 0.5 else [opponent, "medium"]
        config = HandConfig(50, 100) if deals.random() < 0.8 else HandConfig(*sorted((deals.randint(1, 200), deals.randint(1, 200))))
        big = config.big_blind
        stacks = [deals.randint(10 * big, 250 * big) for _ in range(2)]
        button = deals.randrange(2)
        deck = list(range(52))
        deals.shuffle(deck)
        bot_seed = deals.getrandbits(64)
        strong: list[bool | None] = []
        probabilities: list[list[float] | None] = []

        def record(policy: Policy, strong: list[bool | None] = strong, probabilities: list[list[float] | None] = probabilities) -> None:
            if policy is mixed:
                strong.append(mixed.last_strong)
                probabilities.append(mixed.strong.last_probabilities if mixed.last_strong else None)  # type: ignore[attr-defined]

        mixed.new_hand()
        blueprint.new_hand()
        final = play(start_hand(config, stacks, button, deck=deck), seats, bots, random.Random(bot_seed), record)
        made += len(strong)
        hands += 1
        meta = {"bots": seats, "seed": str(bot_seed), "strong": strong, "probabilities": probabilities, "stats": dict(sorted(mixed.stats.items()))}
        out.write(f"{json.dumps(meta, separators=(',', ':'), sort_keys=True)}\t{dumps(hand_record(final))}\n")
    return hands


def _multiway_deal(deals: random.Random, table: int, kinds: Sequence[str], main: str) -> tuple[HandConfig, list[int | None], list[str], int, list[int], int]:
    """A multiway deal: three or more dealt in at random stacks and blinds, ``main`` in at least one seat."""
    dealt = deals.randint(3, table)
    chosen = sorted(deals.sample(range(table), dealt))
    config = HandConfig(50, 100) if deals.random() < 0.8 else HandConfig(*sorted((deals.randint(1, 200), deals.randint(1, 200))))
    big = config.big_blind
    level = deals.random()
    stacks: list[int | None] = [None] * table
    for seat in chosen:
        # Mostly the depth classes' own stacks, where every action is on the graph; otherwise anything.
        stacks[seat] = 50 * big if level < 0.25 else 100 * big if level < 0.5 else deals.randint(5 * big, 250 * big)
    seats = [main] * table
    if deals.random() < 0.75:
        for seat in chosen:
            seats[seat] = deals.choice((*kinds, main, main))
        seats[deals.choice(chosen)] = main
    button = deals.choice(chosen)
    deck = list(range(52))
    deals.shuffle(deck)
    return config, stacks, seats, button, deck, deals.getrandbits(64)


def _write_medium_multiway(out: TextIO, bundle: Any, decisions: int, seed: int) -> int:
    """Hands of RiverMind Medium made from a multiway bundle at its table, until it has made ``decisions`` decisions."""
    from .levels import medium

    table = bundle.game.seats
    mixed = medium(bundle.policy())
    blueprint = bundle.policy()
    bots: dict[str, Policy] = {**simple_bots(), "blueprint": blueprint, "medium": mixed}
    deals = random.Random(seed)
    made = 0
    hands = 0
    while made < decisions:
        config, stacks, seats, button, deck, bot_seed = _multiway_deal(deals, table, (*SIMPLE, "blueprint"), "medium")
        strong: list[bool | None] = []
        probabilities: list[list[float] | None] = []

        def record(policy: Policy, strong: list[bool | None] = strong, probabilities: list[list[float] | None] = probabilities) -> None:
            if policy is mixed:
                strong.append(mixed.last_strong)
                probabilities.append(mixed.strong.last_probabilities if mixed.last_strong else None)  # type: ignore[attr-defined]

        mixed.new_hand()
        blueprint.new_hand()
        final = play(start_hand(config, stacks, button, deck=deck), seats, bots, random.Random(bot_seed), record)
        made += len(strong)
        hands += 1
        meta = {"bots": seats, "seed": str(bot_seed), "strong": strong, "probabilities": probabilities, "stats": dict(sorted(mixed.stats.items()))}
        out.write(f"{json.dumps(meta, separators=(',', ':'), sort_keys=True)}\t{dumps(hand_record(final))}\n")
    return hands


def write_multiway(out: TextIO, bundle_path: Path, decisions: int, seed: int) -> int:
    """Hands of a multiway bundle's blueprint at its table, until it has made ``decisions`` decisions."""
    from .blueprint.bundle import ServingBundle

    bundle = ServingBundle(bundle_path)
    table = bundle.game.seats
    if table == 2:
        raise ValueError("this bundle is heads-up; use the blueprint command")
    blueprint = bundle.policy()
    bots: dict[str, Policy] = {**simple_bots(), "blueprint": blueprint}
    deals = random.Random(seed)
    made = 0
    hands = 0
    while made < decisions:
        config, stacks, seats, button, deck, bot_seed = _multiway_deal(deals, table, SIMPLE, "blueprint")
        probabilities: list[list[float] | None] = []

        def record(policy: Policy, probabilities: list[list[float] | None] = probabilities) -> None:
            if policy is blueprint:
                probabilities.append(blueprint.last_probabilities)

        blueprint.new_hand()
        final = play(start_hand(config, stacks, button, deck=deck), seats, bots, random.Random(bot_seed), record)
        made += len(probabilities)
        hands += 1
        meta = {"bots": seats, "seed": str(bot_seed), "probabilities": probabilities, "stats": dict(sorted(blueprint.stats.items()))}
        out.write(f"{json.dumps(meta, separators=(',', ':'), sort_keys=True)}\t{dumps(hand_record(final))}\n")
    return hands


def boards(size: int, count: int, seed: int) -> Iterator[list[int]]:
    """``count`` boards of ``size`` distinct cards, drawn as ``engine.differential.sample_hands`` draws."""
    gen = SplitMix32(seed)
    for _ in range(count):
        board: list[int] = []
        while len(board) < size:
            c = gen.next() % 52
            if c not in board:
                board.append(c)
        yield board


def bucket_report(tables: Any, count: int, seed: int) -> dict[str, Any]:
    """For each street, a SHA-256 over the buckets (``uint16``, little-endian) of all 1,326 pairs on each sampled board.

    A pair that collides with the board counts as ``0xFFFF``.
    """
    pairs = pair_cards()
    mapped = permuted_pairs()
    report: dict[str, Any] = {}
    preflop = np.asarray(tables.preflop, dtype="<u2")
    report["preflop"] = {"boards": 1, "sha256": hashlib.sha256(preflop.tobytes()).hexdigest()}
    for street, size in zip(STREETS, (3, 4, 5)):
        digest = hashlib.sha256()
        table = tables.buckets[street]
        for board in boards(size, count, seed + size):
            rank = set_rank(board)
            cls = int(tables.board_class[street][rank])
            g = int(tables.board_perm[street][rank])
            values = np.asarray(table[cls][mapped[g]], dtype="<u2").copy()
            mask = np.zeros(52, dtype=bool)
            mask[board] = True
            values[mask[pairs[:, 0]] | mask[pairs[:, 1]]] = INVALID
            digest.update(values.tobytes())
        report[street] = {"boards": count, "sha256": digest.hexdigest()}
    assert len(PERMS) == 24
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    pol = commands.add_parser("policies", help="write bot hands on fuzz deals")
    pol.add_argument("--hands", type=int, default=250, help="hands per seat count")
    pol.add_argument("--seats", default="2-9")
    pol.add_argument("--seed", type=int, default=0)
    bp = commands.add_parser("blueprint", help="write heads-up hands of a bundle's blueprint")
    bp.add_argument("bundle")
    bp.add_argument("--decisions", type=int, default=2_000)
    bp.add_argument("--seed", type=int, default=0)
    md = commands.add_parser("medium", help="write hands of RiverMind Medium made from a bundle, heads-up or at a multiway bundle's table")
    md.add_argument("bundle")
    md.add_argument("--decisions", type=int, default=2_000)
    md.add_argument("--seed", type=int, default=0)
    mw = commands.add_parser("multiway", help="write hands of a multiway bundle's blueprint at its table")
    mw.add_argument("bundle")
    mw.add_argument("--decisions", type=int, default=2_000)
    mw.add_argument("--seed", type=int, default=0)
    bk = commands.add_parser("buckets", help="print card-bucket digests as JSON")
    bk.add_argument("bundle")
    bk.add_argument("--tables", default=None, help="the original card tables, to check the bundle's against")
    bk.add_argument("--boards", type=int, default=200, help="sampled boards per street")
    bk.add_argument("--seed", type=int, default=0)
    syn = commands.add_parser("synthetic", help="write a synthetic serving bundle")
    syn.add_argument("out")
    syn.add_argument("--seed", type=int, default=0)
    syn.add_argument("--abstraction", default="hu-m1")
    syn.add_argument("--depths", default="50,100", help="depth classes, such as 50 for a quicker six-seat bundle")
    args = parser.parse_args(argv)
    if args.command == "policies":
        write_policies(sys.stdout, args.hands, parse_seats(args.seats), args.seed)
    elif args.command == "blueprint":
        write_blueprint(sys.stdout, Path(args.bundle), args.decisions, args.seed)
    elif args.command == "medium":
        write_medium(sys.stdout, Path(args.bundle), args.decisions, args.seed)
    elif args.command == "multiway":
        write_multiway(sys.stdout, Path(args.bundle), args.decisions, args.seed)
    elif args.command == "buckets":
        if args.tables:
            from .cards import CardTables

            tables: Any = CardTables(args.tables)
        else:
            from .blueprint.bundle import ServingBundle

            tables = ServingBundle(args.bundle).tables
        json.dump(bucket_report(tables, args.boards, args.seed), sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    else:
        from .blueprint.bundle import synthetic_bundle

        synthetic_bundle(args.out, seed=args.seed, abstraction=args.abstraction, depths=tuple(int(d) for d in args.depths.split(",")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
