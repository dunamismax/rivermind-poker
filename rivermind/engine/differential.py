"""Reference outputs for the TypeScript engine's differential tests (P4B.4).

The Python engine is the reference. Two commands write what the TypeScript
port in ``web/src/lib/server/engine`` must reproduce:

``hands``
    One line per seeded random hand, as fuzzed by ``fuzz.play_random_hand``:
    the hand record (``history.hand_record``), the final state document and a
    SHA-256 digest, separated by tabs. The digest covers, in order, the
    ``dumps`` text of every state from the first to the last, the legal actions
    at every decision, and the text history of the finished hand for the
    server and for every seat dealt in. The checker replays the record and
    must produce the same bytes.

``evaluator``
    A digest of the evaluator's ranks for every five-card hand
    (``--all-five``) or for a seeded sample of five-, six- or seven-card
    hands drawn with SplitMix32, which the checker implements identically.

Run ``python -m rivermind.engine.differential hands --hands 12500 --seats 2-9``
and pipe it into ``node web/scripts/engine-parity.ts``; ``pnpm engine:parity``
in ``web/`` does both.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from collections.abc import Iterator, Sequence
from itertools import combinations
from typing import TextIO

from .evaluator import evaluate, rank_class
from .fuzz import play_random_hand
from .history import dumps, format_text, hand_record, history_of, state_to_dict
from .state import HandState, LegalActions, apply, legal_actions, start_hand


def legal_doc(legal: LegalActions) -> list[object]:
    """The legal actions as a list, the form both digests use."""
    kind = None if legal.raise_kind is None else legal.raise_kind.value
    return [legal.seat, legal.can_fold, legal.can_check, legal.call, kind, legal.min_to, legal.max_to]


def states(final: HandState) -> Iterator[HandState]:
    """Every state of a finished hand, replayed from its history."""
    history = history_of(final)
    state = start_hand(history.config, history.starting_stacks, history.button, deck=history.deck)
    yield state
    for action in history.actions:
        state = apply(state, action)
        yield state


def hand_digest(final: HandState) -> str:
    """The digest described in the module docstring."""
    digest = hashlib.sha256()
    for state in states(final):
        digest.update(dumps(state_to_dict(state)).encode())
        digest.update(b"\n")
        if state.to_act is not None:
            digest.update(dumps(legal_doc(legal_actions(state))).encode())  # type: ignore[arg-type]
            digest.update(b"\n")
    digest.update(format_text(final).encode())
    for seat in final.seat_order:
        digest.update(format_text(final, viewer=seat).encode())
    return digest.hexdigest()


def parse_seats(text: str) -> list[int]:
    if "-" in text:
        lo, hi = (int(x) for x in text.split("-"))
        return list(range(lo, hi + 1))
    return [int(x) for x in text.split(",")]


def write_hands(out: TextIO, hands: int, seat_counts: Sequence[int], seed: int) -> int:
    """Write ``hands`` fuzzed hands per seat count; returns the number written."""
    written = 0
    for num_seats in seat_counts:
        rng = random.Random(f"differential:{seed}:{num_seats}")
        for _ in range(hands):
            final = play_random_hand(num_seats, rng, check_illegal=False)
            out.write(f"{dumps(hand_record(final))}\t{dumps(state_to_dict(final))}\t{hand_digest(final)}\n")
            written += 1
    return written


class SplitMix32:
    """SplitMix32, the sampler both evaluator digests use (not for dealing)."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF

    def next(self) -> int:
        self.state = (self.state + 0x9E3779B9) & 0xFFFFFFFF
        z = self.state
        z = ((z ^ (z >> 16)) * 0x21F0AAAD) & 0xFFFFFFFF
        z = ((z ^ (z >> 15)) * 0x735A2D97) & 0xFFFFFFFF
        return z ^ (z >> 15)


def sample_hands(size: int, count: int, seed: int) -> Iterator[list[int]]:
    """``count`` hands of ``size`` distinct cards: each card is ``next() % 52``, repeats redrawn."""
    gen = SplitMix32(seed)
    for _ in range(count):
        hand: list[int] = []
        while len(hand) < size:
            c = gen.next() % 52
            if c not in hand:
                hand.append(c)
        yield hand


def evaluator_report(hands: Iterator[Sequence[int]], description: dict[str, object]) -> dict[str, object]:
    """Digest the ranks (two bytes each, little-endian) and count the hand classes."""
    digest = hashlib.sha256()
    classes = [0] * 9
    count = 0
    for hand in hands:
        value = evaluate(hand)
        digest.update(value.to_bytes(2, "little"))
        classes[rank_class(value) - 1] += 1
        count += 1
    return {**description, "hands": count, "classes": classes, "sha256": digest.hexdigest()}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    hands = commands.add_parser("hands", help="write fuzzed hands with their digests")
    hands.add_argument("--hands", type=int, default=625, help="hands per seat count")
    hands.add_argument("--seats", default="2-9", help="seat counts, such as 2-9 or 2,6,9")
    hands.add_argument("--seed", type=int, default=0)
    ev = commands.add_parser("evaluator", help="print an evaluator digest as JSON")
    ev.add_argument("--size", type=int, choices=(5, 6, 7), default=7)
    ev.add_argument("--hands", type=int, default=100_000, help="sampled hands")
    ev.add_argument("--seed", type=int, default=0)
    ev.add_argument("--all-five", action="store_true", help="every five-card hand instead of a sample")
    args = parser.parse_args(argv)
    if args.command == "hands":
        write_hands(sys.stdout, args.hands, parse_seats(args.seats), args.seed)
        return 0
    if args.all_five:
        report = evaluator_report(combinations(range(52), 5), {"all_five": True})
    else:
        report = evaluator_report(
            sample_hands(args.size, args.hands, args.seed), {"size": args.size, "seed": args.seed}
        )
    json.dump(report, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
