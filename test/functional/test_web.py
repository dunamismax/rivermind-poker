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
