"""Fuzzed tables for the TypeScript table to match (P4B.5b).

``rivermind/server/table.py`` and ``snapshot.py`` are the reference for
``web/src/lib/server/table`` until the cutover (P4B.7). This module drives a
``Table`` through seeded random requests: seating, bots, holds, the waitlist,
rebuys, sitting out, disconnects, hands dealt from a seeded generator,
actions (legal, illegal, stale and out of turn), timeouts, clock changes and
snapshot round trips. After every request it takes a digest of the answer,
the events, the departures, the finished hands, what the table reports about
itself and its whole snapshot.

``pnpm table:parity`` (``web/scripts/table-parity.ts``) runs this module,
replays every request against the TypeScript table and compares the digests.

    uv run --locked python -m test.server.table_differential --sequences 200 --ops 250
    uv run --locked python -m test.server.table_differential --fixture

``--fixture`` rewrites ``web/src/lib/server/table/parity.json``, a small set
that Vitest replays without Python; ``test_table_differential.py`` fails while
it is stale. ``--full`` adds each request's whole document, to find a
difference the digests report.

Floats that hold whole numbers are written as whole numbers, as JavaScript
writes them, and every time is a multiple of an eighth of a second, so both
languages compute and print the same values.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from pathlib import Path
from typing import Any

from rivermind.engine import Action, ActionKind, legal_actions
from rivermind.engine.history import hand_record
from rivermind.server.snapshot import table_from_dict, table_to_dict
from rivermind.server.table import Table, TableConfig, TableError

FIXTURE = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "server" / "table" / "parity.json"
FIXTURE_SEQUENCES = 8
FIXTURE_OPS = 150

Op = list[Any]


def normalize(value: Any) -> Any:
    """Whole-number floats as ints, as JavaScript writes them."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize(item) for item in value]
    return value


def canonical(document: Any) -> str:
    return json.dumps(normalize(document), separators=(",", ":"), sort_keys=True)


def digest(document: Any) -> str:
    return hashlib.sha256(canonical(document).encode()).hexdigest()[:16]


class Driver:
    """A table, its clock and its dealing generator, changed only through ``apply``."""

    def __init__(self, config: dict[str, Any], start: float, deal_seed: int) -> None:
        self.now = start
        self.table = Table(TableConfig(**config), self.clock)
        self.deal = random.Random(deal_seed)

    def clock(self) -> float:
        return self.now

    def apply(self, op: Op) -> Any:
        """Apply one request and return its answer. Raises ``TableError`` on a refusal."""
        table = self.table
        name, *args = op
        if name == "advance":
            self.now += args[0]
            return None
        if name == "restore":
            self.table = table_from_dict(json.loads(json.dumps(table_to_dict(table))), self.clock)
            return None
        if name == "sit":
            seat, player_id, label, buy_in, bot = args
            return table.sit(seat, player_id, label, buy_in, bot=bot)
        if name == "leave":
            departure = table.leave(args[0])
            return None if departure is None else departure_doc(departure)
        if name == "sit_out":
            return table.sit_out(args[0])
        if name == "sit_in":
            return table.sit_in(args[0])
        if name == "set_connected":
            return table.set_connected(args[0], args[1])
        if name == "rebuy":
            return table.rebuy(args[0], args[1])
        if name == "reserve":
            return table.reserve(args[0], args[1], args[2])
        if name == "cancel_reservation":
            return table.cancel_reservation(args[0])
        if name == "join_waitlist":
            return table.join_waitlist(args[0], args[1])
        if name == "leave_waitlist":
            return table.leave_waitlist(args[0])
        if name == "settle":
            return table.settle_seats()
        if name == "start":
            table.start_hand(self.deal)
            return None
        if name == "act":
            player_id, kind, amount, seq = args
            return table.act(player_id, Action(ActionKind(kind), amount), seq)
        if name == "act_seat":
            seat, kind, amount = args
            return table.act_seat(seat, Action(ActionKind(kind), amount))
        if name == "time_out":
            action = table.time_out()
            return {"kind": action.kind.value, "amount": action.amount}
        if name == "check_clock":
            return table.check_clock()
        raise ValueError(f"unknown request {name!r}")

    def document(self, op: Op) -> dict[str, Any]:
        """Everything a request did, as the TypeScript table must reproduce it."""
        try:
            result: Any = {"ok": self.apply(op)}
        except TableError as error:
            result = {"error": error.code.value}
        table = self.table
        events = [{"seq": e.seq, "kind": e.kind, "data": e.data} for e in table.drain_events()]
        finished = [
            {
                "hand_no": f.hand_no,
                "seats": [None if s is None else {"player_id": s.player_id, "name": s.name, "bot": s.bot} for s in f.seats],
                "record": hand_record(f.state),
            }
            for f in table.drain_finished()
        ]
        departures = [departure_doc(d) for d in table.drain_departures()]
        return {
            "result": result,
            "events": events,
            "finished": finished,
            "departures": departures,
            "reads": {
                "can_start": table.can_start(),
                "hand_in_progress": table.hand_in_progress,
                "to_act": table.to_act,
                "dealt_in_next": table.dealt_in_next(),
                "free_seats": table.free_seats(),
                "bot_seats": table.bot_seats(),
                "people": table.people(),
                "reservation_deadline": table.reservation_deadline(),
                "stacks": [[seat, table.stack_of(seat)] for seat, _ in table.players()],
                "in_hand": [seat for seat, _ in table.players() if table.in_hand(seat)],
            },
            "snapshot": table_to_dict(table),
        }


def departure_doc(departure: Any) -> dict[str, Any]:
    return {
        "player_id": departure.player_id,
        "seat": departure.seat,
        "chips": departure.chips,
        "left": departure.left,
        "bot": departure.bot,
    }


def random_config(rng: random.Random) -> dict[str, Any]:
    big = rng.choice([2, 100, 100, 200, 1000])
    config: dict[str, Any] = {
        "seat_count": rng.randint(2, 9),
        "small_blind": rng.choice([big // 2, big // 2, big]),
        "big_blind": big,
        "ante": rng.choice([0, 0, 0, max(1, big // 10)]),
        "action_seconds": rng.choice([20.0, 20.0, 7.5, 0.125]),
        "time_bank_seconds": rng.choice([30.0, 30.0, 0.0, 3.25]),
        "bank_refill_seconds": rng.choice([2.0, 2.0, 0.0, 0.5]),
    }
    low, high = rng.choice([(0, 0), (0, 0), (20 * big, 50 * big), (big, 100 * big)])
    config["min_buy_in"], config["max_buy_in"] = low, high
    return config


def eighths(rng: random.Random, most: float) -> float:
    """A time from 0 to ``most`` seconds, in eighths, which binary floats hold exactly."""
    return rng.randint(0, int(most * 8)) / 8


class Fuzzer:
    """Chooses each request from what the table looks like, so play gets deep into hands."""

    def __init__(self, seed: int) -> None:
        self.rng = rng = random.Random(seed)
        self.config = random_config(rng)
        self.start = 1_000_000.0 + eighths(rng, 2)
        self.deal_seed = rng.randrange(2**48)
        self.driver = Driver(self.config, self.start, self.deal_seed)
        seats = self.config["seat_count"]
        self.people = [f"p{i}" for i in range(seats + 3)]
        self.bots = 0

    @property
    def table(self) -> Table:
        return self.driver.table

    def buy_in(self) -> int:
        table, rng = self.table, self.rng
        low, high = table.config.min_buy_in, table.config.max_buy_in
        return rng.choice([low, high, rng.randint(low, high), rng.randint(low, high), low - 1, high + 1, 0, -5])

    def someone(self, seated: bool | None = None) -> str:
        """A person: seated, not seated, or either."""
        table, rng = self.table, self.rng
        pool = [p for p in self.people if seated is None or (table.seat_of(p) is not None) == seated]
        return rng.choice(pool or self.people)

    def anyone_seated(self) -> str:
        players = [p.player_id for _, p in self.table.players()]
        return self.rng.choice(players) if players else self.someone()

    def seat(self) -> int:
        count = self.config["seat_count"]
        return self.rng.choice([*range(count), *range(count), -1, count])

    def action_op(self) -> Op:
        """An action for the seat to act: usually legal, sometimes not."""
        table, rng = self.table, self.rng
        hand = table.hand
        assert hand is not None and hand.to_act is not None
        seat = hand.to_act
        legal = legal_actions(hand)
        player = table.seats[seat]
        assert player is not None
        options: list[tuple[str, int | None]] = []
        if legal.can_check:
            options += [("check", None)] * 4
        if legal.call:
            options += [("call", None)] * 4
        if legal.can_fold:
            options += [("fold", None)] * (1 if legal.can_check else 2)
        if legal.raise_kind is not None:
            kind = legal.raise_kind.value
            options += [(kind, legal.min_to), (kind, legal.max_to), (kind, rng.randint(legal.min_to, legal.max_to))]
        kind, amount = rng.choice(options)
        roll = rng.random()
        if roll < 0.05:
            # Illegal: a size outside the range, an amount where none belongs, or the wrong verb.
            kind, amount = rng.choice(
                [("raise", legal.max_to + 1), ("bet", legal.min_to - 1), ("check", 5), ("call", None), ("check", None), ("bet", 0)]
            )
        if player.is_bot or rng.random() < 0.15:
            return ["act_seat", seat if roll >= 0.08 or roll < 0.05 else self.seat(), kind, amount]
        turn = table.turn
        seq: int | None = rng.choice([table.seq, table.seq, None, turn.seq if turn else None])
        if 0.08 <= roll < 0.11 and turn is not None:
            seq = turn.seq - 1  # stale
        who = player.player_id if roll >= 0.14 or roll < 0.11 else self.anyone_seated()
        return ["act", who, kind, amount, seq]

    def next_op(self) -> Op:
        table, rng = self.table, self.rng
        roll = rng.random()
        if table.hand_in_progress:
            if roll < 0.55:
                return self.action_op()
            if roll < 0.60:
                return ["time_out"]
            if roll < 0.66:
                return ["check_clock"]
            if roll < 0.72:
                return ["advance", eighths(rng, rng.choice([1, 5, 25, 60]))]
        elif table.can_start() and roll < 0.5:
            return ["start"]
        elif len(list(table.players())) < 2 and roll < 0.5:
            roll = 0.0  # fill the table first
        choice = rng.random() if roll >= 0.02 else 0.0
        if choice < 0.16:
            who = self.someone(seated=False) if rng.random() < 0.9 else self.someone()
            return ["sit", self.seat(), who, f"Player {who[1:]}", self.buy_in(), None]
        if choice < 0.24:
            self.bots += 1
            seat = self.seat()
            return ["sit", seat, f"bot:heuristic:{self.bots}", f"RiverMind Easy {seat + 1}", self.buy_in(), "heuristic"]
        if choice < 0.31:
            return ["leave", self.anyone_seated() if rng.random() < 0.9 else self.someone()]
        if choice < 0.37:
            return ["sit_out", self.someone(seated=True)]
        if choice < 0.43:
            return ["sit_in", self.someone(seated=True)]
        if choice < 0.51:
            return ["set_connected", self.someone(seated=True), rng.random() < 0.5]
        if choice < 0.58:
            return ["rebuy", self.anyone_seated(), self.buy_in() if rng.random() < 0.5 else rng.randint(1, table.config.max_buy_in)]
        if choice < 0.68:
            who = self.someone(seated=False) if rng.random() < 0.9 else self.someone()
            return ["reserve", who, f"Player {who[1:]}", None if rng.random() < 0.6 else self.seat()]
        if choice < 0.72:
            return ["cancel_reservation", self.someone()]
        if choice < 0.79:
            who = self.someone(seated=False) if rng.random() < 0.9 else self.someone()
            return ["join_waitlist", who, f"Player {who[1:]}"]
        if choice < 0.82:
            return ["leave_waitlist", self.someone()]
        if choice < 0.88:
            return ["settle"]
        if choice < 0.93:
            return ["advance", eighths(rng, rng.choice([1, 30, 61, 90]))]
        if choice < 0.96:
            return ["restore"]
        if choice < 0.98:
            return ["start"]
        if choice < 0.99:
            return ["time_out"]
        return ["act", self.anyone_seated(), "check", None, None]

    def run(self, ops: int, full: bool) -> dict[str, Any]:
        requests: list[Op] = []
        digests: list[str] = []
        documents: list[Any] = []
        for _ in range(ops):
            op = self.next_op()
            document = self.driver.document(op)
            requests.append(op)
            digests.append(digest(document))
            if full:
                documents.append(normalize(document))
        sequence: dict[str, Any] = {
            "config": normalize(self.config),
            "start": normalize(self.start),
            "deal_seed": self.deal_seed,
            "ops": normalize(requests),
            "digests": digests,
        }
        if full:
            sequence["documents"] = documents
        return sequence


def sequences(count: int, ops: int, seed: int, full: bool = False) -> list[dict[str, Any]]:
    return [{"seed": seed + n, **Fuzzer(seed + n).run(ops, full)} for n in range(count)]


def saved_table(format: int) -> dict[str, Any]:
    """A table as serve-nl saved it mid-hand, and how the hand ends when everyone checks or calls.

    Six seats at 50/100: two people (one of them disconnected, one waiting to
    rebuy and to sit out) and two bots, on the flop. Format 2 also has a seat
    held for a person while its bot finishes the hand, another held outright
    and a player waiting in line; format 1, saved before held seats existed
    (P4.3), has neither list.
    """
    now = 1_000_000.5
    table = Table(TableConfig(6, 50, 100), lambda: now)
    table.sit(0, "p_alice", "Guest 1000", 8_000)
    table.sit(1, "p_bob", "Guest 2000", 4_000)
    table.sit(3, "bot:heuristic:1", "RiverMind Easy 4", 10_000, bot="heuristic")
    table.sit(4, "bot:random:2", "Random bot 5", 6_000, bot="random")
    table.button = 4
    table.start_hand(random.Random(11))
    table.set_connected("p_bob", False)
    table.rebuy("p_alice", 500)
    table.sit_out("p_alice")
    while table.hand is not None and not table.hand.board:
        legal = legal_actions(table.hand)
        table.act_seat(legal.seat, Action.check() if legal.can_check else Action.call())
    if format >= 2:
        table.reserve("p_carol", "Guest 3000", 3)  # the bot plays the hand out first
        table.reserve("p_dave", "Guest 4000", 5)
    table.drain_events(), table.drain_finished(), table.drain_departures()
    snapshot = json.loads(json.dumps(table_to_dict(table)))
    if format == 1:
        snapshot["format"] = 1
        del snapshot["reservations"], snapshot["waitlist"]
    restored = table_from_dict(json.loads(json.dumps(snapshot)), lambda: now)
    actions: list[list[Any]] = []
    while restored.hand_in_progress:
        assert restored.hand is not None
        legal = legal_actions(restored.hand)
        kind = "check" if legal.can_check else "call"
        actions.append([legal.seat, kind])
        restored.act_seat(legal.seat, Action(ActionKind(kind)))
    final = restored.hand
    assert final is not None and final.result is not None
    events = [{"seq": e.seq, "kind": e.kind, "data": e.data} for e in restored.drain_events()]
    (finished,) = restored.drain_finished()
    departures = [departure_doc(d) for d in restored.drain_departures()]
    return normalize(
        {
            "format": format,
            "now": now,
            "snapshot": snapshot,
            "actions": actions,
            "events": events,
            "record": hand_record(finished.state),
            "pots": [{"amount": p.amount, "winners": list(p.winners), "shares": list(p.shares)} for p in final.result.pots],
            "stacks": [None if player is None else player.stack for player in restored.seats],
            "departures": departures,
            "after": table_to_dict(restored),
        }
    )


def fixture_text() -> str:
    document = {
        "note": "Generated by test/server/table_differential.py from serve-nl's table. Do not edit.",
        "sequences": sequences(FIXTURE_SEQUENCES, FIXTURE_OPS, 0),
        "saved": [saved_table(1), saved_table(2)],
    }
    return json.dumps(document, separators=(",", ":")) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sequences", type=int, default=100)
    parser.add_argument("--ops", type=int, default=250)
    parser.add_argument("--seed", type=int, default=1000)
    parser.add_argument("--full", action="store_true", help="include every request's whole document")
    parser.add_argument("--fixture", action="store_true", help=f"rewrite {FIXTURE.name} for Vitest")
    args = parser.parse_args()
    if args.fixture:
        FIXTURE.write_text(fixture_text(), encoding="utf-8")
        print(f"wrote {FIXTURE_SEQUENCES} sequences of {FIXTURE_OPS} requests to {FIXTURE}")
        return 0
    for n in range(args.sequences):
        sequence = {"seed": args.seed + n, **Fuzzer(args.seed + n).run(args.ops, args.full)}
        sys.stdout.write(json.dumps(sequence, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
