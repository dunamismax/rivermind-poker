"""Record the HTTP API's answers for the TypeScript server to match (P4B.5a).

Run ``uv run --locked python -m test.server.export_http_contract`` from the
repository root to rewrite ``web/src/lib/server/api/contract.json``;
``test_http_contract.py`` fails when the committed file is stale.

Each case is a request to ``serve-nl``'s app (``create_app``, with stores in
memory and no rate limits) and its answer: the status, the headers a client
reads and the body text, byte for byte (for a case that makes a new player,
with the random id, handle and cookie replaced by ``*``). The wall clock is fixed, so cookies,
ledger times and every other answer are the same on every run. Players come
from legacy tokens, whose ids and handles are fixed, and finished hands are
added to the memory archive from the engine's rule fixtures, with their
records in the file so the TypeScript test can add the same hands.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest import mock

from fastapi.testclient import TestClient

from rivermind.engine.history import hand_record, replay_record
from rivermind.server import auth
from rivermind.server.app import create_app
from rivermind.server.safety import UNLIMITED, address_tag, client_address, handle_allowed
from rivermind.server.table import Finished, HandSeat
from test.engine.fixtures import FIXTURES
from test.engine.helpers import deal, play

OUTPUT = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "server" / "api" / "contract.json"
SECRET = b"contract-secret-contract-secret!"
NOW = 1_795_000_000.25
"""The fixed wall clock, with a fraction so float times are written the same in both languages."""
ALICE = "p_contractAlice01"
BOB = "p_contractBob0001"
ORIGIN = "http://testserver"
HEADERS = ("content-type", "set-cookie", "retry-after", "allow")

Case = dict[str, Any]


def cookie(player_id: str, issued: float = NOW) -> str:
    return f"{auth.COOKIE_NAME}={auth.issue_session(SECRET, player_id, issued)}"


def hands() -> list[dict[str, Any]]:
    """Finished hands for the archive: two rule fixtures, with Alice and Bob in two of the seats."""
    found = []
    for number, name in enumerate(("side pots, B best", "fold to the big blind"), start=1):
        fixture = next(f for f in FIXTURES if f.name == name)
        state = play(deal(fixture.stacks, fixture.button, fixture.holes, fixture.board, fixture.config), fixture.script)
        people = [(ALICE, "Guest Alice"), (BOB, "Guest Bob")]
        seats: list[dict[str, Any] | None] = []
        for seat, stack in enumerate(fixture.stacks):
            if stack is None:
                seats.append(None)
            elif people:
                player_id, label = people.pop(0)
                seats.append({"player_id": player_id, "name": label, "bot": None})
            else:
                seats.append({"player_id": f"bot-{seat}", "name": f"RiverMind Easy {seat + 1}", "bot": "heuristic"})
        found.append(
            {
                "table_id": f"t-contract-{number}",
                "table_name": f"Contract table {number}",
                "hand_no": number,
                "practice": number == 2,
                "record": hand_record(state),
                "seats": seats,
            }
        )
    return found


def cases() -> list[Case]:
    alice = {"cookie": cookie(ALICE)}
    stale = {"cookie": cookie(ALICE, NOW - auth.RENEW_AFTER_SECONDS - 5)}
    json_body = {"content-type": "application/json"}
    legacy = auth.issue(SECRET, ALICE)
    return [
        {"name": "config", "method": "GET", "path": "/api/config"},
        {"name": "unknown route", "method": "GET", "path": "/api/nope"},
        {"name": "wrong method", "method": "POST", "path": "/api/config", "headers": {"origin": ORIGIN}},
        {"name": "wallet without a session", "method": "GET", "path": "/api/wallet"},
        {"name": "wallet with a forged session", "method": "GET", "path": "/api/wallet", "headers": {"cookie": cookie(ALICE)[:-2] + "00"}},
        {"name": "wallet with an expired session", "method": "GET", "path": "/api/wallet",
         "headers": {"cookie": cookie(ALICE, NOW - auth.SESSION_SECONDS - 1)}},
        {"name": "session from another site", "method": "POST", "path": "/api/session", "headers": {"origin": "https://evil.example"}},
        {"name": "session, body not JSON", "method": "POST", "path": "/api/session", "headers": json_body, "body": "nope"},
        {"name": "session, body cut short", "method": "POST", "path": "/api/session", "headers": json_body, "body": '{"legacy_token":'},
        {"name": "session, body an array", "method": "POST", "path": "/api/session", "headers": json_body, "body": "[]"},
        {"name": "session, extra field", "method": "POST", "path": "/api/session", "headers": json_body, "body": '{"extra": 1}'},
        {"name": "session, token not a string", "method": "POST", "path": "/api/session", "headers": json_body,
         "body": '{"legacy_token": 5}'},
        {"name": "session, token too long", "method": "POST", "path": "/api/session", "headers": json_body,
         "body": json.dumps({"legacy_token": "x" * 201})},
        {"name": "session, forged legacy token makes a new player", "method": "POST", "path": "/api/session",
         "headers": json_body, "body": json.dumps({"legacy_token": legacy[:-1] + "0"}), "random": True},
        {"name": "session claims a legacy player", "method": "POST", "path": "/api/session", "headers": json_body,
         "body": json.dumps({"legacy_token": legacy})},
        {"name": "session again with the cookie", "method": "POST", "path": "/api/session", "headers": alice},
        {"name": "session renews an old cookie", "method": "POST", "path": "/api/session", "headers": stale},
        {"name": "session with a null body", "method": "POST", "path": "/api/session", "headers": {**alice, **json_body}, "body": "null"},
        {"name": "session from loopback over http", "method": "POST", "path": "/api/session",
         "url": "http://127.0.0.1:4320", "headers": {"host": "127.0.0.1:4320", "origin": "http://localhost:5173"}, "random": True},
        {"name": "wallet", "method": "GET", "path": "/api/wallet", "headers": alice},
        {"name": "hands", "method": "GET", "path": "/api/hands", "headers": alice},
        {"name": "hands, one a page", "method": "GET", "path": "/api/hands?limit=1", "headers": alice},
        {"name": "hands before the second", "method": "GET", "path": "/api/hands?limit=1&before=2", "headers": alice},
        {"name": "hands, limit clamped", "method": "GET", "path": "/api/hands?limit=0", "headers": alice},
        {"name": "hands, limit not a number", "method": "GET", "path": "/api/hands?limit=abc", "headers": alice},
        {"name": "hands without a session", "method": "GET", "path": "/api/hands"},
        {"name": "a hand", "method": "GET", "path": "/api/hands/1", "headers": alice},
        {"name": "a practice hand that folded out", "method": "GET", "path": "/api/hands/2", "headers": alice},
        {"name": "a hand of someone else's", "method": "GET", "path": "/api/hands/1", "headers": {"cookie": cookie(BOB)}},
        {"name": "no such hand", "method": "GET", "path": "/api/hands/99", "headers": alice},
        {"name": "a hand id not a number", "method": "GET", "path": "/api/hands/abc", "headers": alice},
        {"name": "relations", "method": "GET", "path": "/api/relations", "headers": alice},
        {"name": "remove a relation that is not there", "method": "DELETE", "path": "/api/relations/0123456789abcdef", "headers": alice},
    ]


HANDLES = [
    "Quiet Heron 42", "Guest 4821", "Proud Peacock 7", "Sh1t Fox", "f u c k", "f.u.c.k Owl", "Shitty", "Big Bitch 9",
    "$lut", "Fûck", "Nazi Wolf", "", "   ", "x" * 33, "x" * 32, "C0CK", "Dick Seal 1", "Lunar Seal", "Grape Drape",
    "Scunthorpe", "a.s.s", "ＦＵＣＫ", "Ñandú 3", "Cocktail Hour", "P3n1s", "s h i t t y", "🦊 Fox", "Café Owl",
]  # fmt: skip
ORIGINS = [
    (None, "rivermindpoker.com"), ("https://rivermindpoker.com", "rivermindpoker.com"),
    ("https://RiverMindPoker.com", "rivermindpoker.com"), ("http://localhost:5173", "127.0.0.1:8000"),
    ("http://[::1]:5173", "localhost:8000"), ("https://rivermindpoker.com", "rivermindpoker.com:443"),
    ("https://evil.example", "rivermindpoker.com"), ("http://localhost:5173", "rivermindpoker.com"),
    ("https://evil.example", "127.0.0.1:8000"), ("null", "rivermindpoker.com"), ("https://rivermindpoker.com", None),
    ("http://app.localhost:5173", "127.0.0.1:4320"), ("http://127.0.0.2", "[::1]:8000"), ("https://rivermindpoker.com/", "rivermindpoker.com"),
    ("http://user@localhost:5173", "localhost"), ("ftp:/nothing", "localhost"),
]  # fmt: skip
PEERS = [
    ("127.0.0.1", "203.0.113.9"), ("::1", "198.51.100.1, 203.0.113.9"), ("198.51.100.7", "203.0.113.9"),
    ("testclient", "203.0.113.9"), (None, None), ("127.0.0.1", None), ("127.0.0.1", "203.0.113.9, "), ("127.8.9.10", "a,b"),
]  # fmt: skip


def values() -> dict[str, Any]:
    """Pure functions of both servers, computed by Python for the TypeScript tests."""
    ids = [ALICE, BOB, "p_AbCdEfGhIjKlMnOp", "p_-_-_-_-_-_-_-_-"]
    genuine = auth.issue_session(SECRET, ALICE, NOW)
    version, pid, issued, signature = genuine.split(".")
    sessions = {
        "genuine": genuine,
        "forged signature": f"{version}.{pid}.{issued}.{signature[:-1]}{'0' if signature[-1] != '0' else '1'}",
        "another player's id": f"{version}.p_someoneelse.{issued}.{signature}",
        "moved issue time": f"{version}.{pid}.{int(issued) + 1}.{signature}",
        "another server's secret": auth.issue_session(b"another-secret-another-secret-an", ALICE, NOW),
        "expired": auth.issue_session(SECRET, ALICE, NOW - auth.SESSION_SECONDS - 60),
        "nearly expired": auth.issue_session(SECRET, ALICE, NOW - auth.SESSION_SECONDS + 1),
        "issued in the future": auth.issue_session(SECRET, ALICE, NOW + 3600),
        "issued a little ahead": auth.issue_session(SECRET, ALICE, NOW + 200),
        "a Phase 3 token": auth.issue(SECRET, ALICE),
        "garbage": "s1.p_x.1.zz",
        "empty": "",
        "too long": "s1." + "p_" + "x" * 200 + ".1.zz",
    }
    tokens = {
        "genuine": auth.issue(SECRET, ALICE),
        "forged": auth.issue(SECRET, ALICE)[:-1] + "x",
        "no prefix": auth.issue(SECRET, "q_contract"),
        "a session": genuine,
        "no dot": "p_nodot",
    }
    return {
        "sessions": {name: {"value": v, "read": auth.read_session(SECRET, v, NOW)} for name, v in sessions.items()},
        "tokens": {name: {"value": v, "verified": auth.verify(SECRET, v)} for name, v in tokens.items()},
        "refs": {i: auth.public_ref(i) for i in ids},
        "guest_names": {i: auth.guest_name(i) for i in ids},
        "address_tags": {a: address_tag(SECRET, a) for a in ("203.0.113.9", "::1", "unknown")},
        "handles": {h: handle_allowed(h) for h in HANDLES},
        "origins": [[o, h, auth.origin_allowed(o, h)] for o, h in ORIGINS],
        "addresses": [[peer, forwarded, client_address(peer, forwarded)] for peer, forwarded in PEERS],
    }


@contextmanager
def fixed_clock() -> Iterator[None]:
    with mock.patch.object(time, "time", lambda: NOW):
        yield


def record(case: Case, client: TestClient) -> Case:
    headers = dict(case.get("headers", {}))
    url = case.get("url", ORIGIN) + case["path"]
    response = client.request(case["method"], url, headers=headers, content=case.get("body"))
    kept = {name: response.headers[name] for name in HEADERS if name in response.headers}
    text = response.text
    if case.get("random"):
        # A new player's id, handle and cookie are random: keep their places, not their values.
        text = json.dumps({**json.loads(text), "player_id": "*", "name": "*"}, separators=(",", ":"))
        if "set-cookie" in kept:
            kept["set-cookie"] = re.sub(r"^(rm_session=)[^;]*", r"\1*", kept["set-cookie"])
    return {
        **{k: v for k, v in case.items() if k != "random"},
        "random": case.get("random", False),
        "response": {"status": response.status_code, "headers": kept, "body": text},
    }


def export() -> str:
    """The JSON text of every case and its answer."""
    archive = hands()
    with fixed_clock():
        app = create_app(secret=SECRET, limits=UNLIMITED)
        with TestClient(app) as client:
            server = app.state.server
            # Bob is a stored player too, so his cookie is genuine.
            server.players.claim(BOB)
            for hand in archive:
                seats = tuple(None if s is None else HandSeat(s["player_id"], s["name"], s["bot"]) for s in hand["seats"])
                finished = Finished(hand["hand_no"], replay_record(hand["record"]), seats)
                server.memory_hands.add(hand["table_id"], hand["table_name"], finished, practice=hand["practice"])
            recorded = [record(case, client) for case in cases()]
    document = {
        "note": "Generated by test/server/export_http_contract.py from serve-nl's app. Do not edit.",
        "secret": SECRET.decode(),
        "now": NOW,
        "players": [BOB],
        "values": values(),
        "hands": archive,
        "cases": recorded,
    }
    return json.dumps(document, indent="\t", ensure_ascii=False) + "\n"


def main() -> int:
    text = export()
    OUTPUT.write_text(text, encoding="utf-8")
    print(f"wrote {len(json.loads(text)['cases'])} cases to {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
