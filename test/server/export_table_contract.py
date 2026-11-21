"""Record a whole session of the table server for the TypeScript server to match (P4B.5b).

Run ``uv run --locked python -m test.server.export_table_contract`` from the
repository root to rewrite ``web/src/lib/server/api/table-contract.json``;
``test_table_contract.py`` fails when the committed file is stale.

The session is a script of steps played against ``serve-nl``'s app
(``create_app``) on one event loop: HTTP requests, sockets that open, send and
close, the table clock moving, and people playing their turns. After each
step the server is left to settle, and the step records what it answered: an
HTTP response's status, headers and body text, and a digest of every message
each open socket received. The TypeScript test replays the same steps against
its own server and must get the same answers.

Nothing in the session is left to chance. The wall clock and the table clock
are fixed (``advance`` steps move the table clock), decks and bots come from
seeded generators, table ids and invite codes are numbered, and players are
claimed by fixed ids. People act only once the server has settled, so events
reach each socket in the same batches in both servers.

Socket messages are compared by digest of their canonical JSON, with
whole-number floats written as whole numbers (``20.0`` as ``20``), as
JavaScript writes them. ``--full PATH`` also writes every message to PATH,
to find a difference the digests report.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import itertools
import json
import random
import secrets
import time
from pathlib import Path
from typing import Any
from unittest import mock

from rivermind.server import auth
from rivermind.server.app import create_app
from rivermind.server.clock import ManualClock
from rivermind.server.runner import RunnerOptions, TableRunner
from rivermind.server.safety import UNLIMITED

OUTPUT = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "server" / "api" / "table-contract.json"
SECRET = b"contract-secret-contract-secret!"
NOW = 1_795_000_000.25
"""The fixed wall clock and the table clock's start, with a fraction so times print the same in both languages."""
SEED = 7000
"""The first table's dealing seed; each later table takes the next."""
HOST = "testserver"
ORIGIN = f"http://{HOST}"
HEADERS = ("content-type", "set-cookie", "retry-after", "allow")
PLAYERS = {
    "alice": ("p_contractAlice01", "203.0.113.1"),
    "bob": ("p_contractBob0001", "203.0.113.2"),
    "carol": ("p_contractCarol01", "203.0.113.2"),  # the same address as Bob: a signal when they share a table
    "dave": ("p_contractDave001", "203.0.113.4"),
}

Step = dict[str, Any]


def table_id(n: int) -> str:
    return f"t-contract-{n:02d}"


def invite_code(n: int) -> str:
    return f"invite-contract-{n:02d}"


T1, T2, T3, T4, T5, T6 = (table_id(n) for n in range(1, 7))
I1 = invite_code(1)


def normalize(value: Any) -> Any:
    """Whole-number floats as ints, as JavaScript writes them."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


def comparable(message: Any) -> Any:
    """A socket message without what the two servers word differently.

    An illegal action's message quotes the engine's own description of the
    action and the legal ones, which is Python's ``repr`` here and plain words
    in TypeScript; clients branch on the code.
    """
    if isinstance(message, dict) and message.get("type") == "error" and message.get("code") == "illegal_action":
        return {**message, "message": "*"}
    return message


def digest(message: Any) -> str:
    text = json.dumps(normalize(comparable(message)), separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def cookie(player_id: str) -> str:
    return f"{auth.COOKIE_NAME}={auth.issue_session(SECRET, player_id, NOW)}"


# The script


def http(who: str | None, method: str, path: str, body: Any = None, **headers: str) -> Step:
    step: Step = {"do": "http", "as": who, "method": method, "path": path}
    if body is not None:
        step["body"] = body if isinstance(body, str) else json.dumps(body)
    if headers:
        step["headers"] = headers
    return step


def send(socket: str, type: str, **fields: Any) -> Step:
    return {"do": "send", "socket": socket, "text": json.dumps({"type": type, **fields})}


def steps() -> list[Step]:
    script: list[Step] = []
    add = script.append
    for name in PLAYERS:
        add(http(name, "POST", "/api/session"))  # the first visit pays the grant
    add(http("alice", "GET", "/api/tables"))
    add(http(None, "GET", "/api/tables"))
    add(http(None, "POST", "/api/tables", {"seats": 3}))
    for bad in ({"seats": 10}, {"seats": "6"}, {"bots": "nobody"}, {"big_blind": 7}, {"buy_in": 1}, {"x": 1}, {"private": "maybe"}):
        add(http("alice", "POST", "/api/tables", bad))
    add(http("alice", "POST", "/api/tables", "nope"))
    add(http("alice", "POST", "/api/tables"))
    add(http("alice", "PATCH", "/api/tables", origin=ORIGIN))
    add(http("alice", "PUT", f"/api/tables/{T1}/seat", origin=ORIGIN))
    add(http("alice", "POST", "/api/tables", {"seats": 3}, origin="https://evil.example"))

    # A table for people only: Alice alone, then Bob holds a seat and sits over his socket.
    add(http("alice", "POST", "/api/tables", {"seats": 3, "bots": None, "buy_in": 6000}, origin=ORIGIN))
    add(http("bob", "GET", "/api/tables"))
    for query in ("seats=3", "seats=4", "big_blind=100", "big_blind=200", "open=true", "open=0", "open=maybe", "seats=x"):
        add(http("bob", "GET", f"/api/tables?{query}"))
    add({"do": "open", "socket": "a", "as": "alice"})
    add(send("a", "join_table", table_id=T1))
    add(http("bob", "POST", f"/api/tables/{T1}/seat", {"hold_only": True}))
    add(http("bob", "GET", "/api/tables"))
    add(http("carol", "POST", f"/api/tables/{T1}/seat", {"seat": 1}))  # held for Bob
    add({"do": "open", "socket": "b", "as": "bob"})
    add(send("b", "act", table_id=T1, seq=1, action="call"))  # not subscribed yet
    add(send("b", "join_table", table_id=T1))
    add(send("b", "sit", table_id=T1, seat=1, buy_in=100_000))  # more than the wallet holds
    add(send("b", "sit", table_id=T1, seat=1, buy_in=20_000))  # more than the table allows: refunded
    add(send("b", "sit", table_id=T1, seat=2, buy_in=5_000))  # not the seat held for him? it is free: he moves
    add({"do": "auto", "table": T1, "turns": 3})
    add(send("a", "act", table_id=T1, seq=1, action="fold"))  # stale or out of turn
    add(send("b", "act", table_id=T1, seq=1, action="fold"))
    add(send("a", "act", table_id=T1, seq=9999, action="raise"))  # a raise needs an amount
    add(send("a", "act", table_id=T1, seq=9999, action="check", amount=5))
    add(send("b", "act", table_id=T1, seq=9999, action="raise", amount=1))
    add(send("a", "dance"))
    add({"do": "send", "socket": "a", "text": "not json"})
    add({"do": "send", "socket": "a", "text": json.dumps({"type": "sit", "table_id": T1, "seat": "1", "buy_in": 5000})})
    add(send("a", "refresh", table_id=T1))
    add(send("a", "join_table", table_id="nope"))
    add({"do": "auto", "table": T1, "turns": 6})

    # Carol takes the last seat; Dave waits in line, and gets her seat when she leaves.
    add(http("carol", "POST", f"/api/tables/{T1}/seat", {"buy_in": 4_000}))
    add({"do": "open", "socket": "c", "as": "carol"})
    add(send("c", "join_table", table_id=T1))
    add(http("dave", "POST", f"/api/tables/{T1}/seat", {}))
    add(http("dave", "DELETE", f"/api/tables/{T1}/waitlist"))  # not waiting: nothing to do
    add(http("dave", "POST", f"/api/tables/{T1}/waitlist", {}))
    add(http("dave", "POST", f"/api/tables/{T1}/waitlist", {}))  # the same place
    add(http("dave", "GET", "/api/tables"))
    add(http("dave", "GET", "/api/tables?open=1"))
    add(http("dave", "DELETE", f"/api/tables/{T1}/waitlist"))
    add(http("dave", "POST", f"/api/tables/{T1}/waitlist", {}))
    add({"do": "auto", "table": T1, "turns": 8})
    add(send("c", "react", table_id=T1, reaction="nice_hand"))
    add(http("bob", "PUT", "/api/relations", {"table_id": T1, "seat": 0, "kind": "mute"}))
    add(send("a", "react", table_id=T1, reaction="hello"))  # Bob muted Alice: he does not hear it
    add(send("a", "react", table_id=T1, reaction="shout"))
    add(http("bob", "PUT", "/api/relations", {"table_id": T1, "seat": 0, "kind": "block"}))
    add(http("bob", "GET", "/api/relations"))
    add(http("bob", "GET", "/api/tables"))
    add(http("alice", "GET", "/api/tables"))  # blocked both ways
    add(http("bob", "PUT", "/api/relations", {"table_id": T1, "seat": 1, "kind": "mute"}))  # his own seat? no: seat 2 is his
    add(http("bob", "PUT", "/api/relations", {"table_id": T1, "seat": 2, "kind": "mute"}))
    add(http("bob", "PUT", "/api/relations", {"table_id": "nope", "seat": 0, "kind": "mute"}))
    add(http("bob", "PUT", "/api/relations", {"table_id": T1, "seat": 9, "kind": "mute"}))
    add(http("bob", "POST", "/api/reports", {"table_id": T1, "seat": 0, "reason": "abuse"}))
    add(http("bob", "POST", "/api/reports", {"table_id": T1, "seat": 0, "reason": "abuse"}))  # counts once a day
    add(http("bob", "POST", "/api/reports", {"table_id": T1, "seat": 0, "reason": "rude"}))
    add(http("bob", "POST", "/api/reports", {"table_id": T1, "seat": 2, "reason": "other"}))
    add(http(None, "POST", "/api/reports", {"table_id": T1, "seat": 0, "reason": "abuse"}))
    add(send("c", "sit_out", table_id=T1))
    add(send("c", "rebuy", table_id=T1, amount=1_000))
    add({"do": "auto", "table": T1, "turns": 5})
    add(send("c", "sit_in", table_id=T1))
    add(send("c", "leave_table", table_id=T1))
    add({"do": "auto", "table": T1, "turns": 6})
    add(http("dave", "GET", "/api/tables"))  # a seat is held for Dave now
    add({"do": "open", "socket": "d", "as": "dave"})
    add(send("d", "join_table", table_id=T1))
    add(http("dave", "POST", f"/api/tables/{T1}/seat", {"buy_in": 4_500}))
    add({"do": "auto", "table": T1, "turns": 9})

    # The clock: Alice lets her time run out, then her socket drops.
    add({"do": "advance", "seconds": 19.5})
    add({"do": "advance", "seconds": 1})
    add({"do": "advance", "seconds": 40})
    add({"do": "auto", "table": T1, "turns": 4})
    add({"do": "close", "socket": "a"})
    add({"do": "advance", "seconds": 25})
    add({"do": "auto", "table": T1, "turns": 6})
    add({"do": "advance", "seconds": 25})
    add({"do": "auto", "table": T1, "turns": 6})
    add({"do": "advance", "seconds": 25})
    add({"do": "auto", "table": T1, "turns": 6})
    add({"do": "open", "socket": "a", "as": "alice"})
    add(send("a", "join_table", table_id=T1))
    add(send("a", "sit_in", table_id=T1))
    add({"do": "auto", "table": T1, "turns": 12})

    # Practice: Alice's own table against RiverMind Easy, which nobody else can see or join.
    add(http("alice", "POST", "/api/practice"))
    add(http("alice", "POST", "/api/practice"))
    add(http(None, "POST", "/api/practice"))
    add(send("a", "join_table", table_id=T2))
    add(send("b", "join_table", table_id=T2))
    add(http("bob", "POST", f"/api/tables/{T2}/seat", {}))
    add(http("alice", "POST", f"/api/tables/{T2}/seat", {}))
    add(http("alice", "GET", "/api/tables"))
    add(send("a", "rebuy", table_id=T2, amount=500))  # practice chips refill only once they run out
    add(send("a", "sit", table_id=T2, seat=1, buy_in=500))
    add({"do": "auto", "table": T2, "turns": 30})
    add(http("alice", "GET", "/api/hands?limit=3"))
    add(http("alice", "GET", "/api/hands/1"))
    add(http("bob", "GET", "/api/hands"))
    add(http("alice", "GET", "/api/wallet"))

    # A private table with calling bots: Carol joins with the invite.
    add(http("bob", "POST", "/api/tables", {"seats": 4, "bots": "calling_station", "private": True, "big_blind": 50}))
    add(http("carol", "GET", "/api/tables"))
    add(http("carol", "GET", f"/api/invites/{I1}"))
    add(http("carol", "GET", "/api/invites/nope"))
    add(http("carol", "POST", f"/api/tables/{T3}/seat", {}))
    add(http("carol", "POST", f"/api/tables/{T3}/seat", {"invite": "wrong"}))
    add(send("b", "join_table", table_id=T3))
    add(send("c", "join_table", table_id=T3))  # not yet one of its people
    add({"do": "auto", "table": T3, "turns": 4})
    add(http("carol", "POST", f"/api/tables/{T3}/seat", {"invite": I1, "hold_only": True}))
    add(send("c", "join_table", table_id=T3))
    add({"do": "auto", "table": T3, "turns": 6})
    add(http("carol", "DELETE", f"/api/tables/{T3}/seat"))
    add(http("carol", "POST", f"/api/tables/{T3}/seat", {"invite": I1, "buy_in": 2_000}))
    add({"do": "auto", "table": T3, "turns": 14})
    add(http("carol", "POST", "/api/reports", {"table_id": T3, "seat": 3, "reason": "collusion"}))  # a bot

    # Quick seat: Dave is already seated; Carol gets a new table with bots at the stakes she asks for.
    add(http("dave", "POST", "/api/quick-seat", {}))
    add(http("carol", "POST", "/api/quick-seat", {"seats": 9, "big_blind": 200, "buy_in": 8_000}))
    add(http("carol", "POST", "/api/quick-seat", {"seats": 1}))
    add(http("carol", "POST", "/api/quick-seat", {"big_blind": 1000}))  # more than her wallet covers
    add(send("c", "join_table", table_id=T4))
    add({"do": "auto", "table": T4, "turns": 25})
    add(send("c", "rebuy", table_id=T4, amount=1_000))
    add({"do": "auto", "table": T4, "turns": 10})
    add(http("carol", "GET", "/api/hands"))
    add(http("carol", "GET", "/api/hands?limit=1&before=40"))

    # Everyone leaves; the tables close and the chips come home.
    add(send("c", "leave_table", table_id=T4))
    add({"do": "auto", "table": T4, "turns": 10})
    add(send("c", "leave_table", table_id=T3))
    add(send("b", "leave_table", table_id=T3))
    add({"do": "auto", "table": T3, "turns": 10})
    add(send("d", "leave_table", table_id=T1))
    add(send("b", "leave_table", table_id=T1))
    add({"do": "auto", "table": T1, "turns": 10})
    add(send("a", "leave_table", table_id=T1))
    add(send("a", "leave_table", table_id=T2))
    add({"do": "close", "socket": "d"})
    for name in PLAYERS:
        add(http(name, "GET", "/api/tables"))
        add(http(name, "GET", "/api/wallet"))
    add(http("alice", "GET", "/api/relations"))
    return script


# The harness


class Socket:
    """A WebSocket to the app, driven on the app's own event loop."""

    def __init__(self, app: Any, headers: dict[str, str]) -> None:
        self.inbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.outbound: list[str] = []
        self.taken = 0
        self.closed: int | None = None
        self.waiting = False
        self.latest: dict[str, Any] = {}
        self.answered: dict[str, int] = {}
        scope = {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "scheme": "ws",
            "path": "/ws",
            "raw_path": b"/ws",
            "query_string": b"",
            "root_path": "",
            "headers": [(key.lower().encode(), value.encode()) for key, value in headers.items()],
            "client": ("127.0.0.1", 50_000),
            "server": (HOST, 80),
            "subprotocols": [],
            "state": {},
        }
        self.inbound.put_nowait({"type": "websocket.connect"})
        self.task = asyncio.ensure_future(app(scope, self.receive, self.send))

    async def receive(self) -> dict[str, Any]:
        self.waiting = self.inbound.empty()
        message = await self.inbound.get()
        self.waiting = False
        return message

    async def send(self, message: dict[str, Any]) -> None:
        if message["type"] == "websocket.send":
            self.outbound.append(message["text"])
        elif message["type"] == "websocket.close":
            self.closed = message.get("code", 1000)

    def send_text(self, text: str) -> None:
        self.inbound.put_nowait({"type": "websocket.receive", "text": text})

    def close(self) -> None:
        self.inbound.put_nowait({"type": "websocket.disconnect", "code": 1001})

    @property
    def idle(self) -> bool:
        return self.task.done() or (self.waiting and self.inbound.empty())

    def take(self) -> list[Any]:
        """The messages received since the last call."""
        new = [json.loads(text) for text in self.outbound[self.taken :]]
        self.taken = len(self.outbound)
        for message in new:
            if message["type"] == "table":
                self.latest[message["table_id"]] = message
        return new


def runner_busy(runner: TableRunner) -> bool:
    table = runner.table
    if runner.lock.locked() or runner.may_deal():
        return True
    seat = table.to_act
    player = table.seats[seat] if seat is not None else None
    return player is not None and player.is_bot


def next_action(view: dict[str, Any]) -> str:
    """Check, call up to ten big blinds, or fold: what both servers' tests play."""
    legal = view["you"]["legal"]
    if legal["can_check"]:
        return "check"
    if legal["call"] <= 10 * view["settings"]["big_blind"] or not legal["can_fold"]:
        return "call"
    return "fold"


class Session:
    def __init__(self, full: bool) -> None:
        self.full = full
        self.sockets: dict[str, Socket] = {}
        self.clock = ManualClock(NOW)
        seeds = itertools.count(SEED)
        self.options = RunnerOptions(
            hand_pause=0.0,
            bot_delay=0.0,
            require_person=True,
            clock=self.clock,
            rng_factory=lambda: random.Random(next(seeds)),
        )
        self.app = create_app(secret=SECRET, options=self.options, limits=UNLIMITED)
        self.server = self.app.state.server

    def headers(self, who: str | None, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"host": HOST}
        if who is not None:
            player_id, address = PLAYERS[who]
            headers["cookie"] = cookie(player_id)
            headers["x-forwarded-for"] = address
        headers.update(extra or {})
        return headers

    async def request(self, step: Step) -> dict[str, Any]:
        body = step.get("body")
        headers = self.headers(step["as"], step.get("headers"))
        if body is not None:
            headers.setdefault("content-type", "application/json")
        path, _, query = step["path"].partition("?")
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": step["method"],
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": query.encode(),
            "root_path": "",
            "headers": [(key.lower().encode(), value.encode()) for key, value in headers.items()],
            "client": ("127.0.0.1", 50_000),
            "server": (HOST, 80),
            "state": {},
        }
        requested = False
        done = asyncio.Event()
        start: dict[str, Any] = {}
        chunks: list[bytes] = []

        async def receive() -> dict[str, Any]:
            nonlocal requested
            if not requested:
                requested = True
                return {"type": "http.request", "body": (body or "").encode(), "more_body": False}
            await done.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                start.update(message)
            elif message["type"] == "http.response.body":
                chunks.append(message.get("body", b""))
                if not message.get("more_body"):
                    done.set()

        await self.app(scope, receive, send)
        found = {key.decode().lower(): value.decode() for key, value in start["headers"]}
        return {
            "status": start["status"],
            "headers": {name: found[name] for name in HEADERS if name in found},
            "body": b"".join(chunks).decode(),
        }

    async def settle(self) -> None:
        """Wait until every socket's messages are handled and every table waits on a person or the clock."""
        quiet = 0
        while quiet < 5:
            await asyncio.sleep(0.002)
            busy = (
                any(not socket.idle for socket in self.sockets.values())
                or any(not connection.queue.empty() for connection in self.server.connections)
                or bool(self.server._closing)
                or any(runner_busy(runner) for runner in self.server.tables.tables.values())
            )
            quiet = 0 if busy else quiet + 1

    def collect(self, result: dict[str, Any]) -> None:
        """Add what each socket received since the last step."""
        for name, socket in sorted(self.sockets.items()):
            messages = socket.take()
            if messages:
                result.setdefault("received", {}).setdefault(name, []).extend(digest(m) for m in messages)
                if self.full:
                    result.setdefault("messages", {}).setdefault(name, []).extend(normalize(comparable(m)) for m in messages)
            if socket.closed is not None and not socket.task.done():
                continue
            if socket.closed is not None:
                result.setdefault("closed", {})[name] = socket.closed
        for name in [name for name, socket in self.sockets.items() if socket.task.done()]:
            del self.sockets[name]

    async def play(self, step: Step) -> dict[str, Any]:
        result: dict[str, Any] = {}
        do = step["do"]
        if do == "http":
            result["response"] = await self.request(step)
        elif do == "open":
            socket = Socket(self.app, {**self.headers(step["as"]), "origin": ORIGIN})
            self.sockets[step["socket"]] = socket
            socket.send_text(json.dumps({"type": "hello", "protocol": 2}))
        elif do == "send":
            self.sockets[step["socket"]].send_text(step["text"])
        elif do == "close":
            self.sockets[step["socket"]].close()
        elif do == "advance":
            self.clock.advance(step["seconds"])
        elif do == "auto":
            acted = result.setdefault("acted", [])
            table = step["table"]
            for _ in range(step["turns"]):
                turn = None
                for name, socket in sorted(self.sockets.items()):
                    latest = socket.latest.get(table)
                    if latest is None or latest["view"]["you"]["legal"] is None:
                        continue
                    if latest["view"]["turn"]["seq"] > socket.answered.get(table, 0):
                        turn = (name, socket, latest["view"])
                        break
                if turn is None:
                    break
                name, socket, view = turn
                action = next_action(view)
                socket.answered[table] = view["turn"]["seq"]
                socket.send_text(json.dumps({"type": "act", "table_id": table, "seq": view["seq"], "action": action}))
                acted.append([name, action, view["seq"]])
                await self.settle()
                self.collect(result)
        else:
            raise ValueError(f"unknown step {do!r}")
        await self.settle()
        self.collect(result)
        return result


def numbered_tokens() -> Any:
    """``secrets.token_urlsafe`` for the session: table ids (9 bytes) and invite codes (12) by number."""
    tables = itertools.count(1)
    invites = itertools.count(1)
    real = secrets.token_urlsafe

    def token(nbytes: int | None = None) -> str:
        if nbytes == 9:
            return table_id(next(tables))
        if nbytes == 12:
            return invite_code(next(invites))
        return real(nbytes)

    return token


async def record(full: bool) -> list[dict[str, Any]]:
    session = Session(full)
    for player_id, _ in PLAYERS.values():
        session.server.players.claim(player_id)
    recorded = []
    async with session.app.router.lifespan_context(session.app):
        for step in steps():
            recorded.append({**step, "result": await session.play(step)})
        for socket in session.sockets.values():
            socket.close()
        await session.settle()
    return recorded


def export(full: bool = False) -> str:
    """The JSON text of the session: every step and what the server answered."""
    with mock.patch.object(time, "time", lambda: NOW), mock.patch.object(secrets, "token_urlsafe", numbered_tokens()):
        recorded = asyncio.run(record(full))
    document = {
        "note": "Generated by test/server/export_table_contract.py from serve-nl's app. Do not edit.",
        "secret": SECRET.decode(),
        "now": NOW,
        "seed": SEED,
        "players": {
            name: {"id": player_id, "address": address, "cookie": cookie(player_id)}
            for name, (player_id, address) in PLAYERS.items()
        },
        "steps": recorded,
    }
    return json.dumps(document, indent="\t", ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--full", metavar="PATH", help="also write every socket message to PATH")
    args = parser.parse_args()
    if args.full:
        Path(args.full).write_text(export(full=True), encoding="utf-8")
        print(f"wrote the session with every message to {args.full}")
        return 0
    text = export()
    OUTPUT.write_text(text, encoding="utf-8")
    document = json.loads(text)
    messages = sum(len(m) for s in document["steps"] for m in s["result"].get("received", {}).values())
    print(f"wrote {len(document['steps'])} steps and {messages} socket messages to {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
