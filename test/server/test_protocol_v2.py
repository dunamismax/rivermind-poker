"""Protocol v2 over the real app (P3.4).

Each test runs ``rivermind.server.app`` in a ``TestClient`` and plays over
its WebSocket: every message must match the schema, never show another
seat's hidden cards and survive reconnecting, at every seat count.
"""

from __future__ import annotations

import json
import random
import re
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from click.testing import CliRunner
from fastapi.testclient import TestClient

from poker_ai.cli.runner import cli
from rivermind.engine import card_str
from rivermind.server import ErrorCode as TableErrorCode
from rivermind.server import RunnerOptions, TableRunner
from rivermind.server import protocol as p
from rivermind.server.clock import ManualClock
from rivermind.server.app import create_app
from rivermind.server.typescript import to_typescript

ROOT = Path(__file__).resolve().parents[2]
GENERATED = ROOT / "web" / "src" / "lib" / "protocol-v2.ts"
SECRET = b"test-secret-test-secret-test-sec"
Message = dict[str, Any]


def make_app(seed: int = 0) -> Any:
    """The app with seeded decks and a clock that never moves, so nobody times out."""
    seeds = iter(range(seed * 1000, seed * 1000 + 1000))
    options = RunnerOptions(
        hand_pause=0.0,
        bot_delay=0.0,
        require_person=True,
        clock=ManualClock(),
        rng_factory=lambda: random.Random(next(seeds)),
    )
    return create_app(secret=SECRET, options=options)


class Player:
    def __init__(self, client: TestClient) -> None:
        response = client.post("/api/players")
        assert response.status_code == 201
        body = response.json()
        self.client = client
        self.player_id: str = body["player_id"]
        self.token: str = body["token"]

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def new_table(self, seats: int, bots: str = "random", buy_in: int | None = None) -> str:
        body: Message = {"seats": seats, "bots": bots}
        if buy_in is not None:
            body["buy_in"] = buy_in
        response = self.client.post("/api/tables", json=body, headers=self.headers())
        assert response.status_code == 201, response.text
        assert response.json()["seat"] == 0
        return str(response.json()["table_id"])

    @contextmanager
    def socket(self) -> Iterator[Socket]:
        with self.client.websocket_connect("/ws") as ws:
            socket = Socket(ws)
            socket.send(type="hello", token=self.token, protocol=2)
            welcome = socket.receive()
            assert welcome["type"] == "welcome" and welcome["player_id"] == self.player_id
            yield socket


class Socket:
    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self.messages: list[Message] = []
        self.latest: dict[str, Message] = {}
        """Table id -> the last table message received for it."""
        self.answered: dict[str, int] = {}
        """Table id -> the seq of the last turn this socket acted on."""

    def send(self, **message: Any) -> None:
        self.ws.send_text(json.dumps(message))

    def receive(self) -> Message:
        text = self.ws.receive_text()
        p.ServerMessage.model_validate_json(text)  # every message matches the schema
        message: Message = json.loads(text)
        self.messages.append(message)
        if message["type"] == "table":
            self.latest[message["table_id"]] = message
        return message

    def until(self, predicate: Callable[[Message], bool], limit: int = 2_000) -> Message:
        for _ in range(limit):
            message = self.receive()
            if predicate(message):
                return message
        raise AssertionError("the expected message never came")

    def _is_new_turn(self, message: Message, table_id: str) -> bool:
        if message["type"] != "table" or message["table_id"] != table_id:
            return False
        view = message["view"]
        if view["you"]["legal"] is None:
            return False
        return bool(view["turn"]["seq"] > self.answered.get(table_id, 0))

    def my_turn(self, table_id: str) -> Message:
        """The view of the viewer's next turn not yet acted on.

        The last message already received may be that turn (the snapshot
        after joining often is), so it is checked before waiting for more.
        """
        latest = self.latest.get(table_id)
        if latest is not None and self._is_new_turn(latest, table_id):
            return latest
        return self.until(lambda m: self._is_new_turn(m, table_id))

    def act(self, table_id: str, turn: Message, action: str, amount: int | None = None) -> None:
        self.answered[table_id] = turn["view"]["turn"]["seq"]
        message: Message = dict(type="act", table_id=table_id, seq=turn["view"]["seq"], action=action)
        if amount is not None:
            message["amount"] = amount
        self.send(**message)

    def play(self, table_id: str, turn: Message) -> None:
        """Check, call up to ten big blinds, or fold, so the player rarely busts."""
        view = turn["view"]
        legal = view["you"]["legal"]
        if legal["can_check"]:
            action = "check"
        elif legal["call"] <= 10 * view["settings"]["big_blind"] or not legal["can_fold"]:
            action = "call"
        else:
            action = "fold"
        self.act(table_id, turn, action)

    def play_until(self, table_id: str, predicate: Callable[[Message], bool], limit: int = 5_000) -> Message:
        """Play every turn at the table until a message for it matches ``predicate``."""
        for _ in range(limit):
            latest = self.latest.get(table_id)
            if latest is not None and predicate(latest):
                return latest
            if latest is not None and self._is_new_turn(latest, table_id):
                self.play(table_id, latest)
            self.receive()
        raise AssertionError("the expected message never came")


class Spy:
    """Records every seat's hole cards per hand, from inside the server."""

    def __init__(self, runner: TableRunner) -> None:
        self.holes: dict[int, dict[int, list[str]]] = {}
        runner.listeners.insert(0, self)

    async def __call__(self, runner: TableRunner, events: Any) -> None:
        hand = runner.table.hand
        if hand is not None:
            self.holes[runner.table.hand_no] = {
                seat: [card_str(c) for c in hole] for seat, hole in enumerate(hand.hole_cards) if hole is not None
            }


def card_text(c: Message) -> str:
    rank = "23456789TJQKA"[c["rank"] - 2]
    return rank + c["suit"][0]


def cards_in(value: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        if set(value) == {"rank", "suit"}:
            found.add(card_text(value))
        for item in value.values():
            found |= cards_in(item)
    elif isinstance(value, list):
        for item in value:
            found |= cards_in(item)
    return found


def check_privacy(message: Message, spy: Spy) -> None:
    """No card of another seat appears unless that seat showed it."""
    if message["type"] != "table" or message["view"]["hand"] is None:
        return
    view = message["view"]
    hand = view["hand"]
    holes = spy.holes[hand["hand_no"]]
    shown = set(hand["result"]["shown"]) if hand["result"] else set()
    visible = cards_in(message)
    for seat, hole in holes.items():
        if seat == view["you"]["seat"] or seat in shown:
            continue
        assert not visible & set(hole), f"S{seat}'s hidden cards leaked to {view['you']['seat']}"
    for info in view["seats"]:
        if info and info["cards"] is not None and info["seat"] != view["you"]["seat"]:
            assert hand["result"] is not None and info["seat"] in shown


def wait_for(condition: Callable[[], bool], seconds: float = 5.0) -> None:
    """Wait for something the server does after a socket's last message."""
    deadline = time.monotonic() + seconds
    while not condition():
        assert time.monotonic() < deadline, "the server never got there"
        time.sleep(0.01)


def server_runner(client: TestClient, table_id: str) -> TableRunner:
    runner = client.app.state.server.tables.get(table_id)  # type: ignore[attr-defined]
    assert runner is not None
    return runner


def test_generated_typescript_is_current() -> None:
    expected = to_typescript(p.json_schema(), 2)
    assert GENERATED.read_text() == expected, (
        "web/src/lib/protocol-v2.ts is stale. Regenerate it with `pnpm protocol` in web/."
    )


def test_cli_exports_the_v2_schema(tmp_path: Path) -> None:
    result = CliRunner().invoke(cli, ["protocol-schema", "--version", "2"])
    assert result.exit_code == 0, result.output
    schema = json.loads(result.output)
    assert schema == p.json_schema()
    for name in ("ClientMessage", "ServerMessage", "TableView", "TableEvent", "HelloMessage", "ErrorCode"):
        assert name in schema["$defs"]


def test_error_codes_cover_the_table_and_the_app() -> None:
    codes = {code.value for code in p.ErrorCode}
    assert {code.value for code in TableErrorCode} <= codes
    app_source = (ROOT / "rivermind" / "server" / "app.py").read_text()
    used = set(re.findall(r'ErrorCode\.([A-Z_]+)', app_source)) | {
        v.upper() for v in re.findall(r'_error\("(\w+)"', app_source)
    }
    assert {name.lower() for name in used} <= codes


def test_http_endpoints() -> None:
    with TestClient(make_app()) as client:
        config = client.get("/api/config").json()
        p.ConfigResponse.model_validate(config)
        assert config["protocol"] == 2 and config["seat_counts"] == list(range(2, 10))
        assert {bot["kind"] for bot in config["bots"]} == {"random", "calling_station", "heuristic"}
        player = Player(client)
        assert client.post("/api/tables", json={"seats": 6}).status_code == 401
        bad = {"Authorization": f"Bearer {player.token}x"}
        assert client.post("/api/tables", json={"seats": 6}, headers=bad).status_code == 401
        for body in ({"seats": 10}, {"seats": "6"}, {"bots": "nobody"}, {"big_blind": 7}, {"buy_in": 1}, {"x": 1}):
            response = client.post("/api/tables", json=body, headers=player.headers())
            assert response.status_code == 400, body
            p.HttpError.model_validate(response.json())


def test_sockets_must_say_hello_with_a_real_token() -> None:
    with TestClient(make_app()) as client:
        player = Player(client)
        with client.websocket_connect("/ws") as ws:
            ws.send_text(json.dumps({"type": "join_table", "table_id": "x"}))
            assert json.loads(ws.receive_text())["code"] == "bad_request"
        with client.websocket_connect("/ws") as ws:  # a short-deck page left open since the cutover
            ws.send_text(json.dumps({"type": "join", "table_id": "old", "token": "x"}))
            closed = json.loads(ws.receive_text())
            assert closed["code"] == "unknown_table" and "no-limit" in closed["message"]
        with client.websocket_connect("/ws") as ws:
            ws.send_text(json.dumps({"type": "hello", "token": player.token + "0", "protocol": 2}))
            assert json.loads(ws.receive_text())["code"] == "unauthorized"
        with player.socket() as socket:
            socket.send(type="join_table", table_id="nope")
            assert socket.receive()["code"] == "unknown_table"
            socket.send(type="dance")
            assert socket.receive()["code"] == "bad_request"
            table_id = player.new_table(2)
            socket.send(type="act", table_id=table_id, seq=1, action="call")
            assert socket.receive()["code"] == "not_subscribed"
            socket.send(type="join_table", table_id=table_id)
            turn = socket.my_turn(table_id)
            socket.send(type="act", table_id=table_id, seq=turn["view"]["seq"], action="raise")
            assert socket.until(lambda m: m["type"] == "error")["code"] == "bad_request"  # a raise needs an amount
            legal = turn["view"]["you"]["legal"]
            socket.send(type="act", table_id=table_id, seq=turn["view"]["seq"], action="raise", amount=legal["max_to"] + 1)
            assert socket.until(lambda m: m["type"] == "error")["code"] == "illegal_action"


@pytest.mark.parametrize("seats", range(2, 10))
def test_play_reconnect_and_hidden_cards_at_every_seat_count(seats: int) -> None:
    with TestClient(make_app(seats)) as client:
        player = Player(client)
        table_id = player.new_table(seats)
        spy = Spy(server_runner(client, table_id))
        with player.socket() as socket:
            socket.send(type="join_table", table_id=table_id)
            snapshot = socket.receive()
            assert snapshot["type"] == "table" and snapshot["view"]["you"]["seat"] == 0
            assert sum(1 for s in snapshot["view"]["seats"] if s and s["kind"] == "bot") == seats - 1
            turns = 0
            while turns < 12:
                socket.play(table_id, socket.my_turn(table_id))
                turns += 1
            turn = socket.my_turn(table_id)  # leave mid-hand, on our turn
            mine = [info for info in turn["view"]["seats"] if info and info["seat"] == 0][0]["cards"]
            hand_no = turn["view"]["hand"]["hand_no"]
            last_seq = turn["view"]["seq"]
        runner = server_runner(client, table_id)
        player_state = runner.table.seats[0]
        assert player_state is not None
        wait_for(lambda: not player_state.connected)  # the server has seen the socket close
        with player.socket() as socket:
            socket.send(type="join_table", table_id=table_id)
            again = socket.receive()
            view = again["view"]
            assert view["seq"] >= last_seq + 1  # the disconnect is an event
            if view["hand"]["hand_no"] == hand_no and view["hand"]["result"] is None:
                assert view["seats"][0]["cards"] == mine  # the same hand, the same cards
                assert view["you"]["legal"] is not None and view["turn"]["seat"] == 0
            socket.play_until(table_id, lambda m: m["view"]["hand"]["hand_no"] > hand_no + 1)
            hands = socket.messages
        events = [e for m in hands if m["type"] == "table" for e in m["events"]]
        seqs = [e["seq"] for e in events]
        assert seqs == list(range(seqs[0], seqs[0] + len(seqs)))  # in order, without gaps
        assert "connected" in {e["kind"] for e in events}
        for message in hands:
            check_privacy(message, spy)


def test_privacy_over_many_hands_including_showdowns() -> None:
    with TestClient(make_app(42)) as client:
        player = Player(client)
        table_id = player.new_table(6, bots="calling_station")
        spy = Spy(server_runner(client, table_id))
        with player.socket() as socket:
            socket.send(type="join_table", table_id=table_id)
            for _ in range(60):
                socket.play(table_id, socket.my_turn(table_id))
            showdowns = [
                m
                for m in socket.messages
                if m["type"] == "table" and m["view"]["hand"] and (m["view"]["hand"]["result"] or {}).get("showdown")
            ]
            assert showdowns
            for message in socket.messages:
                check_privacy(message, spy)
            shown = showdowns[-1]["view"]
            for seat in shown["hand"]["result"]["shown"]:
                assert shown["seats"][seat] is None or shown["seats"][seat]["cards"] is not None


def test_stale_and_duplicate_actions_are_refused() -> None:
    with TestClient(make_app(7)) as client:
        player = Player(client)
        table_id = player.new_table(3, bots="calling_station")
        with player.socket() as socket:
            socket.send(type="join_table", table_id=table_id)
            first = socket.my_turn(table_id)
            action = "check" if first["view"]["you"]["legal"]["can_check"] else "call"
            old = dict(type="act", table_id=table_id, seq=first["view"]["seq"], action=action)
            socket.act(table_id, first, action)
            socket.send(**old)  # sent twice: only one is applied
            error = socket.until(lambda m: m["type"] == "error")
            assert error["code"] in ("not_your_turn", "stale")
            runner = server_runner(client, table_id)
            nxt = socket.my_turn(table_id)
            assert nxt["view"]["turn"]["seq"] > first["view"]["seq"]
            acted = len([a for a in nxt["view"]["hand"]["actions"] if a["seat"] == 0])
            socket.send(**dict(old, action="fold"))  # an action for the earlier turn
            assert socket.until(lambda m: m["type"] == "error")["code"] == "stale"
            hand = runner.table.hand
            assert hand is not None and hand.to_act == 0  # still our turn, nothing applied
            assert len([a for a in hand.actions if a.seat == 0]) == acted
            legal = nxt["view"]["you"]["legal"]
            socket.act(table_id, nxt, "check" if legal["can_check"] else "fold")
            socket.until(
                lambda m: m["type"] == "table" and any(e["kind"] == "action" and e["seat"] == 0 for e in m["events"])
            )


def test_only_the_seated_player_acts_for_their_seat() -> None:
    with TestClient(make_app(3)) as client:
        owner = Player(client)
        other = Player(client)
        table_id = owner.new_table(4)
        spy = Spy(server_runner(client, table_id))
        with owner.socket() as mine, other.socket() as theirs:
            mine.send(type="join_table", table_id=table_id)
            theirs.send(type="join_table", table_id=table_id)
            turn = mine.my_turn(table_id)
            theirs.send(type="act", table_id=table_id, seq=turn["view"]["seq"], action="fold")
            assert theirs.until(lambda m: m["type"] == "error")["code"] == "not_seated"
            theirs.send(type="sit", table_id=table_id, seat=0, buy_in=10_000)
            assert theirs.until(lambda m: m["type"] == "error")["code"] == "seat_taken"
            runner = server_runner(client, table_id)
            hand = runner.table.hand
            assert hand is not None and hand.to_act == 0
            acted = len(hand.actions)
            assert acted == len(turn["view"]["hand"]["actions"])  # the other player changed nothing
            bot_turn = mine.play_until(table_id, lambda m: m["view"]["turn"] is not None and m["view"]["turn"]["seat"] != 0)
            mine.send(type="act", table_id=table_id, seq=bot_turn["view"]["seq"], action="fold")
            # Refused either way: the bot is still to act, or it has acted and the seq is old.
            assert mine.until(lambda m: m["type"] == "error")["code"] in ("not_your_turn", "stale")
            spectator_view = theirs.until(lambda m: m["type"] == "table" and m["view"]["hand"] is not None)
            assert spectator_view["view"]["you"]["seat"] is None and spectator_view["view"]["you"]["legal"] is None
            for message in mine.messages + theirs.messages:
                check_privacy(message, spy)


def test_one_socket_follows_several_tables() -> None:
    with TestClient(make_app(5)) as client:
        player = Player(client)
        tables = [player.new_table(2), player.new_table(9, bots="heuristic")]
        with player.socket() as socket:
            for table_id in tables:
                socket.send(type="join_table", table_id=table_id)
            for _ in range(3):
                for table_id in tables:
                    socket.play(table_id, socket.my_turn(table_id))
            seen = {m["table_id"] for m in socket.messages if m["type"] == "table"}
            assert seen == set(tables)


def test_sit_out_rebuy_and_leave_over_the_socket() -> None:
    with TestClient(make_app(9)) as client:
        player = Player(client)
        table_id = player.new_table(3, buy_in=5_000)
        with player.socket() as socket:
            socket.send(type="join_table", table_id=table_id)
            socket.my_turn(table_id)
            socket.send(type="rebuy", table_id=table_id, amount=100_000)
            assert socket.until(lambda m: m["type"] == "error")["code"] == "bad_buy_in"
            socket.send(type="rebuy", table_id=table_id, amount=500)
            rebuy = socket.until(lambda m: m["type"] == "table" and m["view"]["you"]["pending_rebuy"] == 500)
            assert any(e["kind"] == "rebuy_pending" and e["amount"] == 500 for e in rebuy["events"])
            socket.send(type="sit_out", table_id=table_id)
            pending = socket.until(lambda m: m["type"] == "table" and m["view"]["you"]["sitting_out_next"])
            assert any(e["kind"] == "sitting_out_next" for e in pending["events"])
            out = socket.play_until(table_id, lambda m: m["view"]["you"]["sitting_out"])
            assert out["view"]["you"]["pending_rebuy"] == 0
            events = [e["kind"] for m in socket.messages if m["type"] == "table" for e in m["events"]]
            assert "rebought" in events or "rebuy_dropped" in events
            socket.send(type="sit_in", table_id=table_id)
            socket.my_turn(table_id)
            socket.send(type="leave_table", table_id=table_id)
            socket.until(lambda m: m["type"] == "left_table")
        # No person is left, so the table closes once the hand is over.
        wait_for(lambda: client.app.state.server.tables.get(table_id) is None)  # type: ignore[attr-defined]
