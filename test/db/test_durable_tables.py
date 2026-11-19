"""Durable no-limit tables in PostgreSQL (P3.5).

Tables are saved before any change is published and restored when the
server starts, finished hands are stored as replayable histories, and a
server process killed mid-hand comes back with the identical table.
"""

from __future__ import annotations

import contextlib
import copy
import json
import os
import random
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select

from rivermind.db import Hand, HandHistory, PokerTable, Seat
from rivermind.engine.history import replay_record
from rivermind.server import RunnerOptions, Table, TableConfig, TableRunner
from rivermind.server.app import create_app
from rivermind.server.clock import ManualClock
from rivermind.server.snapshot import table_to_dict
from rivermind.server.store import TableStore, seat_rows
from test.server.test_protocol_v2 import SECRET, Player, server_runner, wait_for

ROOT = Path(__file__).resolve().parents[2]


def make_app(store: TableStore, seed: int = 0) -> Any:
    seeds = iter(range(seed * 1000, seed * 1000 + 1000))
    options = RunnerOptions(
        hand_pause=0.0,
        bot_delay=0.0,
        require_person=True,
        clock=ManualClock(),
        rng_factory=lambda: random.Random(next(seeds)),
    )
    return create_app(secret=SECRET, options=options, store=store)


def saved_state(engine: Engine, table_id: str) -> dict[str, Any] | None:
    with engine.connect() as conn:
        return conn.execute(select(PokerTable.state).where(PokerTable.id == table_id)).scalar_one()


def test_the_store_saves_loads_and_closes_tables(engine: Engine) -> None:
    store = TableStore(engine)
    table = Table(TableConfig(6, 50, 100))
    table.sit(0, "p_a", "Guest 1000", 8_000)
    table.sit(3, "bot:random:1", "Random bot 4", 10_000, bot="random")
    table.start_hand(random.Random(1))
    table.drain_events()
    state = table_to_dict(table)
    store.save("t1", "A table", state, seat_rows(table), (1, table.hand.button))  # type: ignore[union-attr]
    (saved,) = store.load_open()
    assert (saved.table_id, saved.name, saved.state) == ("t1", "A table", state)
    with engine.connect() as conn:
        seats = conn.execute(select(Seat.seat_no, Seat.is_bot, Seat.bot_kind, Seat.stack).order_by(Seat.seat_no)).all()
        assert [tuple(row) for row in seats] == [(0, False, None, table.stack_of(0)), (3, True, "random", table.stack_of(3))]
        joined = conn.execute(select(Seat.joined_at).where(Seat.seat_no == 0)).scalar_one()
        assert conn.execute(select(func.count()).select_from(Hand)).scalar_one() == 1
    # Saving again keeps one hand row and the first arrival time.
    def save_again() -> None:
        table.drain_events()
        table.drain_finished()
        table.drain_departures()
        store.save("t1", "A table", table_to_dict(table), seat_rows(table), (table.hand_no, table.button))  # type: ignore[arg-type]

    save_again()
    with engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(Hand)).scalar_one() == 1
        assert conn.execute(select(Seat.joined_at).where(Seat.seat_no == 0)).scalar_one() == joined
    # Someone new in the seat is a new arrival; an emptied seat has no row.
    table.leave("p_a")  # folds heads-up, so the hand ends and the seat frees
    table.leave("bot:random:1")
    table.sit(0, "p_b", "Guest 2000", 8_000)
    save_again()
    with engine.connect() as conn:
        rows = conn.execute(select(Seat.seat_no, Seat.display_name, Seat.joined_at)).all()
        assert [(row[0], row[1]) for row in rows] == [(0, "Guest 2000")] and rows[0][2] > joined
    store.close("t1")
    assert store.load_open() == []
    with engine.connect() as conn:
        assert conn.execute(select(PokerTable.status)).scalar_one() == "closed"
        assert conn.execute(select(func.count()).select_from(Seat)).scalar_one() == 0
    # A save that arrives after the close does not reopen the table.
    store.save("t1", "A table", state, [], None)
    assert store.load_open() == []


def test_tables_are_saved_before_publishing_and_restored_at_startup(engine: Engine) -> None:
    store = TableStore(engine)
    published: list[tuple[int, int | None]] = []

    async def check_saved(runner: TableRunner, events: Any) -> None:
        state = saved_state(engine, runner.table_id)
        published.append((runner.table.seq, None if state is None else state["seq"]))

    with TestClient(make_app(store, 1)) as client:
        player = Player(client)
        table_id = player.new_table(6, bots="calling_station")
        runner = server_runner(client, table_id)
        runner.listeners.insert(0, check_saved)
        with player.socket() as ws:
            ws.send(type="join_table", table_id=table_id)
            for _ in range(25):
                ws.play(table_id, ws.my_turn(table_id))
            turn = ws.my_turn(table_id)
        seated = runner.table.seats[0]
        assert seated is not None
        # The disconnect is applied, then saved in a worker thread: wait for both.
        wait_for(
            lambda: not seated.connected and (saved_state(engine, table_id) or {}).get("seq") == runner.table.seq,
            seconds=15,
            describe=lambda: (
                f"(connected={seated.connected}, saved seq={(saved_state(engine, table_id) or {}).get('seq')},"
                f" live seq={runner.table.seq}, turn={runner.table.turn}, save failures={[getattr(h, 'failures', None) for h in runner.before_publish]})"
            ),
        )
        before = copy.deepcopy(saved_state(engine, table_id))
        live = table_to_dict(runner.table)
    assert before is not None
    # The table's lobby settings (P4.3) are saved beside its snapshot.
    assert before.pop("lobby") == {"fill": "calling_station", "private": False, "invite": None}
    assert published and all(seq == saved for seq, saved in published)  # nothing was shown before it was saved
    assert before == live  # the app stopped with the table saved as it was

    hand_no = turn["view"]["hand"]["hand_no"]
    with engine.connect() as conn:
        records = conn.execute(
            select(Hand.hand_no, HandHistory.record).join(HandHistory).where(Hand.table_id == table_id).order_by(Hand.hand_no)
        ).all()
    assert [n for n, _ in records] == list(range(1, hand_no))  # every finished hand, none in progress
    for _, record in records:
        replay_record(record)  # each replays to its recorded result

    with TestClient(make_app(store, 2)) as client:
        runner = server_runner(client, table_id)
        # The player had already disconnected, so nothing changed on restoring.
        assert table_to_dict(runner.table) == before
        player.client = client  # the same player and session, on the new server
        with player.socket() as ws:
            ws.send(type="join_table", table_id=table_id)
            again = ws.receive()["view"]
            assert again["hand"]["hand_no"] == hand_no
            assert again["seats"][0]["cards"] == turn["view"]["seats"][0]["cards"]
            assert again["you"]["legal"] == turn["view"]["you"]["legal"]
            ws.play_until(table_id, lambda m: m["view"]["hand"]["hand_no"] > hand_no + 2)
    assert store.history(table_id, hand_no + 1) is not None

    # Once everyone has left, the table closes and is not restored again.
    with TestClient(make_app(store, 3)) as client:
        player.client = client
        with player.socket() as ws:
            ws.send(type="join_table", table_id=table_id)
            ws.send(type="leave_table", table_id=table_id)
            ws.until(lambda m: m["type"] == "left_table")
        # The bots finish the hand, the seat frees and the table closes.
        deadline = time.monotonic() + 10
        while store.load_open():
            assert time.monotonic() < deadline, "the table never closed"
            time.sleep(0.02)
    with engine.connect() as conn:
        assert conn.execute(select(PokerTable.status).where(PokerTable.id == table_id)).scalar_one() == "closed"


# A real server process, killed mid-hand.


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class Server:
    def __init__(self, database_url: str, secret_file: Path, port: int, log: Path) -> None:
        command = Path(sys.executable).with_name("rivermind-poker")
        env = dict(os.environ, DATABASE_URL=database_url, PYTHONUNBUFFERED="1")
        env.pop("RIVERMIND_SECRET", None)
        self.base = f"http://127.0.0.1:{port}"
        self.ws_url = f"ws://127.0.0.1:{port}/ws"
        self.log = log.open("ab")
        self.process = subprocess.Popen(
            [str(command), "serve-nl", "--port", str(port), "--secret_file", str(secret_file),
             "--hand_pause", "0", "--bot_delay", "0"],
            env=env, cwd=ROOT, stdout=self.log, stderr=subprocess.STDOUT,
        )  # fmt: skip
        deadline = time.monotonic() + 30
        while True:
            try:
                urllib.request.urlopen(self.base + "/api/config", timeout=1).read()
                return
            except OSError:
                assert self.process.poll() is None, log.read_text()
                assert time.monotonic() < deadline, "the server did not start"
                time.sleep(0.1)

    def post(self, path: str, body: dict[str, Any], cookie: str | None = None) -> tuple[dict[str, Any], str | None]:
        """The response body and the session cookie it set, if any."""
        headers = {"Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        request = urllib.request.Request(self.base + path, json.dumps(body).encode(), headers, method="POST")
        with urllib.request.urlopen(request, timeout=10) as response:
            set_cookie = response.headers.get("Set-Cookie")
            return dict(json.loads(response.read())), set_cookie.split(";", 1)[0] if set_cookie else None

    def kill(self) -> None:
        self.process.send_signal(signal.SIGKILL)
        self.process.wait(10)
        self.log.close()


@pytest.fixture()
def servers(engine: Engine, tmp_path: Path) -> Iterator[list[Server]]:
    running: list[Server] = []
    yield running
    for server in running:
        if server.process.poll() is None:
            server.kill()


def test_a_server_killed_mid_hand_restores_the_table_identically(
    engine: Engine, database_url: str, tmp_path: Path, servers: list[Server]
) -> None:
    from websockets.sync.client import connect

    store = TableStore(engine)
    port = free_port()
    log = tmp_path / "server.log"
    servers.append(Server(database_url, tmp_path / "secret", port, log))
    _, cookie = servers[0].post("/api/session", {})
    assert cookie is not None and cookie.startswith("rm_session=")
    table_id = servers[0].post("/api/tables", {"seats": 6, "bots": "heuristic"}, cookie)[0]["table_id"]

    answered = [0]

    def my_turn(ws: Any) -> dict[str, Any]:
        """The next turn not yet acted on (a rejoin can send the same turn twice)."""
        while True:
            message = json.loads(ws.recv(timeout=20))
            if message["type"] != "table" or message["view"]["you"]["legal"] is None:
                continue
            if message["view"]["turn"]["seq"] > answered[0]:
                return dict(message["view"])

    def act(ws: Any, view: dict[str, Any]) -> None:
        answered[0] = view["turn"]["seq"]
        legal = view["you"]["legal"]
        action = "check" if legal["can_check"] else "call" if legal["call"] <= 1_000 else "fold"
        ws.send(json.dumps({"type": "act", "table_id": table_id, "seq": view["seq"], "action": action}))

    with connect(servers[0].ws_url, additional_headers={"Cookie": cookie}) as ws:
        ws.send(json.dumps({"type": "hello", "protocol": 2}))
        ws.send(json.dumps({"type": "join_table", "table_id": table_id}))
        for _ in range(6):
            act(ws, my_turn(ws))
        view = my_turn(ws)  # mid-hand, waiting for us
        before = saved_state(engine, table_id)
        servers[0].kill()  # no shutdown, no last save
        with contextlib.suppress(Exception):
            ws.close()
    assert before is not None and before["hand"]["result"] is None and before["turn"]["seat"] == 0
    assert before["seq"] == view["seq"]

    servers.append(Server(database_url, tmp_path / "secret", port, log))
    after = saved_state(engine, table_id)
    expected = copy.deepcopy(before)
    # The one change on restoring: nobody is connected, so the player's turn
    # loses its time bank until they come back (rule 13.2).
    expected["seq"] += 1
    expected["seats"][0].update(connected=False, disconnected_this_hand=True)
    expected["turn"]["final"] = expected["turn"]["deadline"]
    assert after == expected

    with connect(servers[1].ws_url, additional_headers={"Cookie": cookie}) as ws:
        ws.send(json.dumps({"type": "hello", "protocol": 2}))
        ws.send(json.dumps({"type": "join_table", "table_id": table_id}))
        again = my_turn(ws)
        for key in ("hand", "settings", "seats"):
            if key == "seats":
                assert [dict(s, connected=True) if s else s for s in again[key]] == [
                    dict(s, connected=True) if s else s for s in view[key]
                ]
            else:
                assert again[key] == view[key]
        assert again["you"]["legal"] == view["you"]["legal"]
        hand_no = view["hand"]["hand_no"]
        answered[0] = 0  # the turn is the same one, still unanswered
        act(ws, again)
        while True:
            next_view = my_turn(ws)
            if next_view["hand"]["hand_no"] > hand_no:
                break
            act(ws, next_view)
    record = store.history(table_id, hand_no)
    assert record is not None
    final = replay_record(record)
    assert final.result is not None and final.hole_cards[0] is not None


def test_lobby_settings_held_seats_and_the_waitlist_survive_a_restart(engine: Engine) -> None:
    """Private tables keep their invite, bots keep filling and people keep their places (P4.3)."""
    store = TableStore(engine)
    with TestClient(make_app(store, 5)) as client:
        alice, bob, carol = Player(client), Player(client), Player(client)
        made = client.post(
            "/api/tables", json={"seats": 2, "bots": None, "private": True}, headers=alice.headers()
        ).json()
        full, code = made["table_id"], made["invite"]
        assert client.post(f"/api/tables/{full}/seat", json={"invite": code}, headers=bob.headers()).json()["seated"]
        assert client.post(f"/api/tables/{full}/waitlist", json={"invite": code}, headers=carol.headers()).json() == {
            "table_id": full,
            "position": 1,
        }
        bots = client.post("/api/tables", json={"seats": 3, "bots": "random"}, headers=alice.headers()).json()["table_id"]
        hold = client.post(f"/api/tables/{bots}/seat", json={"hold_only": True}, headers=carol.headers()).json()
        assert hold["hold"]["ready"] is False  # Alice's hand is under way; the bot finishes it first
        runners = {t: server_runner(client, t) for t in (full, bots)}
        wait_for(lambda: all((saved_state(engine, t) or {}).get("seq") == r.table.seq for t, r in runners.items()))
        before = {t: (table_to_dict(r.table), r.lobby_state()) for t, r in runners.items()}
    assert before[full][1] == {"fill": None, "private": True, "invite": code}
    assert before[bots][1] == {"fill": "random", "private": False, "invite": None}

    with TestClient(make_app(store, 6)) as client:
        for table_id, (state, lobby) in before.items():
            runner = server_runner(client, table_id)
            assert runner.lobby_state() == lobby
            restored = table_to_dict(runner.table)
            assert restored["reservations"] == state["reservations"] and restored["waitlist"] == state["waitlist"]
        carol.client = client
        found = client.get(f"/api/invites/{code}", headers=carol.headers())
        assert found.status_code == 200 and found.json()["waitlist_position"] == 1
        listed = client.get("/api/tables", headers=carol.headers()).json()["tables"]
        assert {t["table_id"] for t in listed} == {full, bots}  # Carol waits at the private one
