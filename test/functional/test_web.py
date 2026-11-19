"""RM-08: the browser table's HTTP and WebSocket server."""
from collections import defaultdict

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from poker_ai.web.app import create_app
from test.functional.training_helpers import STAGES

LUT = {stage: defaultdict(int) for stage in STAGES}


@pytest.fixture
def client():
    return TestClient(create_app(card_info_lut=LUT, strategy={}))


def _new(client, opponents="random"):
    response = client.post("/api/tables", json={"opponents": opponents})
    assert response.status_code == 201, response.text
    return response.json()


def _join(ws, seat):
    ws.send_json({"type": "join", **seat})
    message = ws.receive_json()
    assert message["type"] == "view", message
    return message["view"]


def _play_hand(ws, view, action="call"):
    """Act until the hand ends; return the final view."""
    while view["result"] is None:
        assert view["your_turn"], "the server must run bots until the human acts"
        choice = action if action in view["legal_actions"] else "call"
        ws.send_json({"type": "act", "action": choice, "seq": view["seq"]})
        message = ws.receive_json()
        assert message["type"] == "view", message
        view = message["view"]
    return view


def test_serves_client_and_config(client):
    page = client.get("/")
    assert page.status_code == 200 and "RiverMind Poker" in page.text
    assert client.get("/static/app.js").status_code == 200
    css = client.get("/static/style.css")
    assert css.status_code == 200
    for response in (page, css):
        assert response.headers["cache-control"] == "no-cache"
        assert response.headers.get("etag") or page is response
    assert client.get("/api/config").json() == {"opponents": ["random", "checkpoint"]}
    assert TestClient(create_app()).get("/api/config").json() == {"opponents": ["random"]}


def test_rejects_unknown_opponents(client):
    assert client.post("/api/tables", json={"opponents": "nope"}).status_code == 400
    plain = TestClient(create_app())
    assert plain.post("/api/tables", json={"opponents": "checkpoint"}).status_code == 400


@pytest.mark.parametrize("opponents", ["random", "checkpoint"])
def test_consecutive_hands_over_websocket(client, opponents):
    seat = _new(client, opponents)
    with client.websocket_connect("/ws") as ws:
        view = _join(ws, seat)
        balance = 0
        for hand in range(1, 6):
            assert view["hand"] == hand
            assert len(view["seats"][0]["cards"]) == 2
            assert view["seats"][1]["cards"] is None or view["result"]
            final = _play_hand(ws, view)
            payouts = {int(k): v for k, v in final["result"]["payouts"].items()}
            assert sum(payouts.values()) == 0
            balance += payouts[0]
            assert final["seats"][0]["balance"] == balance
            bots = [e for e in final["events"] if e["seat"] != 0]
            assert all(e["action"] in {"fold", "call", "raise"} for e in bots)
            ws.send_json({"type": "next_hand", "seq": final["seq"]})
            view = ws.receive_json()["view"]
    assert final["seats"][1]["name"].startswith(
        "RiverMind" if opponents == "checkpoint" else "Random")


def test_errors_carry_the_current_view_and_do_not_advance(client):
    seat = _new(client)
    with client.websocket_connect("/ws") as ws:
        view = _join(ws, seat)
        for message, code in [
            ({"type": "act", "action": "call", "seq": view["seq"] - 1}, "stale"),
            ({"type": "act", "action": "check", "seq": view["seq"]}, "illegal_action"),
            ({"type": "next_hand", "seq": view["seq"]}, "hand_in_progress"),
            ({"type": "dance"}, "bad_request"),
        ]:
            ws.send_json(message)
            reply = ws.receive_json()
            assert reply["type"] == "error" and reply["code"] == code, reply
            assert reply["view"] == view
        ws.send_text("not json")
        assert ws.receive_json()["code"] == "bad_request"
        ws.send_json({"type": "act", "action": "call", "seq": view["seq"]})
        moved = ws.receive_json()["view"]
        assert moved["seq"] > view["seq"]
        # The same request again is a duplicate and is rejected.
        ws.send_json({"type": "act", "action": "call", "seq": view["seq"]})
        assert ws.receive_json()["code"] == "stale"


def test_reconnect_resumes_the_same_seat(client):
    seat = _new(client)
    with client.websocket_connect("/ws") as ws:
        view = _join(ws, seat)
        ws.send_json({"type": "act", "action": "call", "seq": view["seq"]})
        before = ws.receive_json()["view"]
    with client.websocket_connect("/ws") as ws:
        assert _join(ws, seat) == before
        ws.send_json({"type": "refresh"})
        assert ws.receive_json()["view"] == before


def test_every_open_socket_for_the_seat_gets_updates(client):
    seat = _new(client)
    with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
        view = _join(a, seat)
        assert _join(b, seat) == view
        a.send_json({"type": "act", "action": "fold", "seq": view["seq"]})
        assert a.receive_json()["view"] == b.receive_json()["view"]


@pytest.mark.parametrize("join, code", [
    ({"type": "join", "table_id": "missing", "token": "x"}, "unknown_table"),
    ({"type": "hello"}, "unknown_table"),
])
def test_join_rejections_close_the_socket(client, join, code):
    with client.websocket_connect("/ws") as ws:
        ws.send_json(join)
        assert ws.receive_json()["code"] == code
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_wrong_token_cannot_take_the_seat(client):
    seat = _new(client)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "join", "table_id": seat["table_id"], "token": "guess"})
        assert ws.receive_json()["code"] == "unknown_seat"


def test_idle_tables_are_evicted_when_full():
    app = create_app(max_tables=2, idle_seconds=3600)
    client = TestClient(app)
    first = _new(client)
    _new(client)
    _new(client)  # evicts the least recently used idle table
    assert len(app.state.registry._tables) == 2
    assert app.state.registry.get(first["table_id"]) is None


def _app(path, **kwargs):
    return create_app(card_info_lut=LUT, strategy={}, state_path=str(path), **kwargs)


@pytest.mark.parametrize("opponents", ["random", "checkpoint"])
def test_tables_survive_a_restart_mid_hand(tmp_path, opponents):
    db = tmp_path / "tables.sqlite3"
    client = TestClient(_app(db))
    seat = _new(client, opponents)
    with client.websocket_connect("/ws") as ws:
        view = _join(ws, seat)
        ws.send_json({"type": "act", "action": "call", "seq": view["seq"]})
        before = ws.receive_json()["view"]
    # A new app on the same file stands in for a restarted server.
    restarted = TestClient(_app(db))
    with restarted.websocket_connect("/ws") as ws:
        assert _join(ws, seat) == before
        final = _play_hand(ws, before)
        ws.send_json({"type": "next_hand", "seq": final["seq"]})
        after = ws.receive_json()["view"]
        assert after["hand"] == before["hand"] + 1
        assert after["seats"][0]["balance"] == final["seats"][0]["balance"]
    # And again, after the next hand started.
    with TestClient(_app(db)).websocket_connect("/ws") as ws:
        assert _join(ws, seat) == after


def test_checkpoint_tables_wait_for_the_checkpoint(tmp_path):
    db = tmp_path / "tables.sqlite3"
    seat = _new(TestClient(_app(db)), "checkpoint")
    without = create_app(state_path=str(db))  # started without a checkpoint
    assert without.state.registry.get(seat["table_id"]) is None
    assert _app(db).state.registry.get(seat["table_id"]) is not None


def test_unreadable_and_expired_tables_are_dropped(tmp_path):
    from poker_ai.web.store import TableStore
    db = tmp_path / "tables.sqlite3"
    keep = _new(TestClient(_app(db)))
    store = TableStore(db)
    store.save("broken", "random", 9e18, {"version": 999})
    store.close()
    app = _app(db)
    assert app.state.registry.get(keep["table_id"]) is not None
    ids = [row[0] for row in TableStore(db).rows()]
    assert "broken" not in ids and keep["table_id"] in ids
    _app(db, idle_seconds=-1)  # everything is now too old
    assert list(TableStore(db).rows()) == []


def test_eviction_removes_saved_tables(tmp_path):
    from poker_ai.web.store import TableStore
    db = tmp_path / "tables.sqlite3"
    client = TestClient(_app(db, max_tables=1))
    first = _new(client)
    second = _new(client)
    ids = [row[0] for row in TableStore(db).rows()]
    assert ids == [second["table_id"]] and first["table_id"] not in ids


@pytest.fixture
def built_client(tmp_path):
    root = tmp_path / "build"
    (root / "_app" / "immutable").mkdir(parents=True)
    (root / "200.html").write_text("<!doctype html><title>RiverMind Poker</title>")
    (root / "_app" / "immutable" / "start.abc.js").write_text("export {};")
    (root / "robots.txt").write_text("User-agent: *\n")
    (tmp_path / "secret.txt").write_text("outside")
    return root


def test_serves_the_built_client_with_the_site_headers(built_client):
    client = TestClient(create_app(client_dir=str(built_client)))
    for path in ("/", "/some/route", "/..%2fsecret.txt"):
        page = client.get(path)
        assert page.status_code == 200 and "RiverMind Poker" in page.text, path
        assert page.headers["cache-control"] == "no-cache"
        csp = page.headers["content-security-policy"]
        assert "script-src 'self';" in csp and "style-src 'self';" in csp
        assert "connect-src 'self' ws://testserver" in csp
        assert page.headers["x-frame-options"] == "DENY"
    asset = client.get("/_app/immutable/start.abc.js")
    assert asset.status_code == 200
    assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert client.head("/").status_code == 200
    assert client.get("/robots.txt").headers["cache-control"] == "no-cache"
    assert client.get("/_app/immutable/missing.js").status_code == 404
    assert client.get("/api/missing").status_code == 404
    # The legacy client is off: its path is just another SPA route.
    assert "RiverMind Poker" in client.get("/static/app.js").text
    config = client.get("/api/config")
    assert config.json() == {"opponents": ["random"]}
    assert "content-security-policy" not in config.headers
    seat = _new(client)
    with client.websocket_connect("/ws") as ws:
        assert _join(ws, seat)["hand"] == 1


def test_client_dir_must_be_built(tmp_path):
    with pytest.raises(ValueError, match="200.html"):
        create_app(client_dir=str(tmp_path))
