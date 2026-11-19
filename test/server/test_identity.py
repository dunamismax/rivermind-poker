"""Anonymous players, session cookies and origin checks (P4.1).

Every check goes through the real app: a first visit makes a player with a
random handle and a signed ``HttpOnly``, ``Secure``, ``SameSite=Lax``
cookie; HTTP and the WebSocket authenticate by it; and missing, forged,
expired and foreign-origin requests are refused.
"""

from __future__ import annotations

import json
import re
import time
from http.cookies import SimpleCookie
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from rivermind.server import auth
from rivermind.server.app import NO_SESSION_MESSAGE, RELOAD_MESSAGE, create_app
from rivermind.server.players import ADJECTIVES, ANIMALS, MemoryPlayers, random_handle
from test.server.test_protocol_v2 import SECRET, Player, make_app

HANDLE = re.compile(r"^([A-Z][a-z]+) ([A-Z][a-z]+) (\d{1,2})$")
OTHER_SECRET = b"another-secret-another-secret-an"


def session_cookie(response: Any) -> dict[str, Any]:
    """The attributes of the session cookie a response set."""
    headers = [value for name, value in response.headers.multi_items() if name.lower() == "set-cookie"]
    assert len(headers) == 1, headers
    cookie = SimpleCookie()
    cookie.load(headers[0])
    morsel = cookie[auth.COOKIE_NAME]
    flags = {part.strip().lower() for part in headers[0].split(";")}
    return {
        "value": morsel.value,
        "httponly": "httponly" in flags,
        "secure": "secure" in flags,
        "samesite": morsel["samesite"].lower(),
        "path": morsel["path"],
        "max_age": int(morsel["max-age"]),
    }


def cookie_header(value: str) -> dict[str, str]:
    return {"Cookie": f"{auth.COOKIE_NAME}={value}"}


def hello(
    client: TestClient, headers: dict[str, str], message: dict[str, Any] | None = None, url: str = "/ws"
) -> dict[str, Any]:
    with client.websocket_connect(url, headers=headers) as ws:
        ws.send_text(json.dumps(message or {"type": "hello", "protocol": 2}))
        return dict(json.loads(ws.receive_text()))


# Sessions


def test_a_first_visit_makes_a_player_with_a_random_handle_and_a_strict_cookie() -> None:
    with TestClient(make_app()) as client:
        response = client.post("/api/session")
        assert response.status_code == 200
        body = response.json()
        assert body["created"] is True and body["player_id"].startswith("p_")
        assert HANDLE.match(body["name"]), body["name"]
        cookie = session_cookie(response)
        assert cookie["httponly"] and cookie["secure"] and cookie["samesite"] == "lax"
        assert cookie["path"] == "/" and cookie["max_age"] == auth.SESSION_SECONDS
        assert auth.read_session(SECRET, cookie["value"], time.time()) is not None

        # The same browser comes back: the same player, and a fresh cookie needs no renewal.
        again = client.post("/api/session", headers=cookie_header(cookie["value"]))
        assert again.json() == {**body, "created": False}
        assert "set-cookie" not in again.headers

        # Another browser is another player with another handle.
        client.cookies.clear()
        other = client.post("/api/session").json()
        assert other["player_id"] != body["player_id"] and other["name"] != body["name"]


def test_the_cookie_is_not_secure_only_on_plain_http_to_this_machine() -> None:
    for base, secure in (
        ("http://127.0.0.1:8000", False),
        ("http://localhost:5173", False),
        ("https://localhost", True),
        ("http://rivermindpoker.com", True),
        ("https://rivermindpoker.com", True),
    ):
        with TestClient(make_app(), base_url=base) as client:
            assert session_cookie(client.post("/api/session"))["secure"] is secure, base


def test_an_old_session_is_renewed_on_a_visit() -> None:
    with TestClient(make_app()) as client:
        player = Player(client)
        two_days_ago = auth.issue_session(SECRET, player.player_id, time.time() - 2 * 24 * 3600)
        response = client.post("/api/session", headers=cookie_header(two_days_ago))
        assert response.json()["player_id"] == player.player_id
        renewed = session_cookie(response)["value"]
        session = auth.read_session(SECRET, renewed, time.time())
        assert session is not None and session[0] == player.player_id and time.time() - session[1] < 60


def bad_sessions(player_id: str) -> dict[str, str]:
    now = time.time()
    genuine = auth.issue_session(SECRET, player_id, now)
    version, pid, issued, signature = genuine.split(".")
    return {
        "forged signature": f"{version}.{pid}.{issued}.{signature[:-1]}{'0' if signature[-1] != '0' else '1'}",
        "another player's id": f"{version}.p_someoneelse.{issued}.{signature}",
        "moved issue time": f"{version}.{pid}.{int(issued) + 1}.{signature}",
        "another server's secret": auth.issue_session(OTHER_SECRET, player_id, now),
        "expired": auth.issue_session(SECRET, player_id, now - auth.SESSION_SECONDS - 60),
        "issued in the future": auth.issue_session(SECRET, player_id, now + 3600),
        "a Phase 3 token": auth.issue(SECRET, player_id),
        "unknown player": auth.issue_session(SECRET, "p_neverstored00", now),
        "garbage": "s1.p_x.1.zz",
        "empty": "",
    }


def test_missing_forged_and_expired_sessions_are_refused_over_http() -> None:
    with TestClient(make_app()) as client:
        player = Player(client)
        assert client.post("/api/tables", json={"seats": 2}).status_code == 401
        for reason, value in bad_sessions(player.player_id).items():
            response = client.post("/api/tables", json={"seats": 2}, headers=cookie_header(value))
            assert response.status_code == 401, reason
            assert response.json() == {"detail": NO_SESSION_MESSAGE}
        assert client.post("/api/tables", json={"seats": 2}, headers=player.headers()).status_code == 201


def test_missing_forged_and_expired_sessions_are_refused_over_the_socket() -> None:
    with TestClient(make_app()) as client:
        player = Player(client)
        assert hello(client, {}) == {"type": "error", "code": "unauthorized", "message": NO_SESSION_MESSAGE, "table_id": None}
        for reason, value in bad_sessions(player.player_id).items():
            assert hello(client, cookie_header(value))["code"] == "unauthorized", reason
        assert hello(client, player.headers())["type"] == "welcome"


def test_a_bad_session_on_a_visit_makes_a_new_player() -> None:
    with TestClient(make_app()) as client:
        player = Player(client)
        for reason, value in bad_sessions(player.player_id).items():
            response = client.post("/api/session", headers=cookie_header(value))
            body = response.json()
            assert body["created"] is True and body["player_id"] != player.player_id, reason
            assert session_cookie(response)["value"] != value
            client.cookies.clear()


def test_a_phase_3_token_moves_its_player_onto_a_cookie_once() -> None:
    with TestClient(make_app()) as client:
        player_id = auth.new_player_id()
        token = auth.issue(SECRET, player_id)
        response = client.post("/api/session", json={"legacy_token": token})
        body = response.json()
        # The same player, with the handle their seats already showed.
        assert body == {"player_id": player_id, "name": auth.guest_name(player_id), "created": False}
        cookie = session_cookie(response)["value"]
        client.cookies.clear()
        assert hello(client, cookie_header(cookie))["player_id"] == player_id

        # A forged token makes a new player rather than claiming one.
        forged = client.post("/api/session", json={"legacy_token": token[:-1] + "x"}).json()
        assert forged["created"] is True and forged["player_id"] != player_id
        client.cookies.clear()

        # A browser with a session keeps it whatever token it sends.
        other = Player(client)
        kept = client.post("/api/session", json={"legacy_token": token}, headers=other.headers()).json()
        assert kept["player_id"] == other.player_id

        # Old pages that still say hello with their token are told to reload.
        assert hello(client, {}, {"type": "hello", "token": token, "protocol": 2}) == {
            "type": "error",
            "code": "unauthorized",
            "message": RELOAD_MESSAGE,
            "table_id": None,
        }


def test_the_seat_shows_the_players_handle() -> None:
    with TestClient(make_app()) as client:
        player = Player(client)
        table_id = player.new_table(2)
        with player.socket() as socket:
            socket.send(type="join_table", table_id=table_id)
            view = socket.until(lambda m: m["type"] == "table")["view"]
            assert view["seats"][0]["name"] == player.name


# Origins


def test_requests_from_other_origins_are_refused() -> None:
    ws_url = "wss://rivermindpoker.com/ws"  # the test client's sockets otherwise go to ws://testserver
    with TestClient(make_app(), base_url="https://rivermindpoker.com") as client:
        player = Player(client)
        for origin in ("https://evil.example", "https://rivermindpoker.com.evil.example", "null", "http://localhost:5173"):
            headers = {"Origin": origin}
            assert client.post("/api/session", headers=headers).status_code == 403, origin
            response = client.post("/api/tables", json={"seats": 2}, headers={**player.headers(), **headers})
            assert response.status_code == 403 and response.json() == {"detail": "Requests from other sites are not allowed."}
            with pytest.raises(WebSocketDisconnect) as refused:
                with client.websocket_connect(ws_url, headers={**player.headers(), **headers}):
                    pass
            assert refused.value.code == 1008
        same = {"Origin": "https://rivermindpoker.com"}
        assert client.post("/api/tables", json={"seats": 2}, headers={**player.headers(), **same}).status_code == 201
        assert hello(client, {**player.headers(), **same}, url=ws_url)["type"] == "welcome"
        assert client.get("/api/config", headers={"Origin": "https://evil.example"}).status_code == 200  # reads are harmless


def test_loopback_pages_and_allowed_origins_may_call_the_server() -> None:
    # The Vite dev server proxies from localhost:5173 to the API on 127.0.0.1:8000.
    with TestClient(make_app(), base_url="http://127.0.0.1:8000") as client:
        assert client.post("/api/session", headers={"Origin": "http://localhost:5173"}).status_code == 200
        assert client.post("/api/session", headers={"Origin": "https://evil.example"}).status_code == 403
    app = create_app(secret=SECRET, allowed_origins=["https://play.example/"])
    with TestClient(app, base_url="https://api.example") as client:
        assert client.post("/api/session", headers={"Origin": "https://play.example"}).status_code == 200
        assert client.post("/api/session", headers={"Origin": "https://evil.example"}).status_code == 403


@pytest.mark.parametrize(
    ("origin", "host", "allowed"),
    [
        (None, "rivermindpoker.com", True),
        ("https://rivermindpoker.com", "rivermindpoker.com", True),
        ("https://RiverMindPoker.com", "rivermindpoker.com", True),
        ("http://localhost:5173", "127.0.0.1:8000", True),
        ("http://[::1]:5173", "localhost:8000", True),
        ("https://rivermindpoker.com", "rivermindpoker.com:443", False),
        ("https://evil.example", "rivermindpoker.com", False),
        ("http://localhost:5173", "rivermindpoker.com", False),
        ("https://evil.example", "127.0.0.1:8000", False),
        ("null", "rivermindpoker.com", False),
        ("https://rivermindpoker.com", None, False),
    ],
)
def test_origin_rules(origin: str | None, host: str | None, allowed: bool) -> None:
    assert auth.origin_allowed(origin, host) is allowed


# Handles


def test_handles_are_random_and_never_repeat() -> None:
    handles = [random_handle() for _ in range(2_000)]
    for handle in handles:
        match = HANDLE.match(handle)
        assert match and match[1] in ADJECTIVES and match[2] in ANIMALS
        assert len(handle) <= 32
    assert len(set(handles)) > 1_900
    players = MemoryPlayers()
    made = [players.create() for _ in range(3_000)]
    assert len({p.handle for p in made}) == len(made) == len({p.player_id for p in made})
    assert all(players.get(p.player_id) == p for p in made)
    assert players.get("p_missing") is None
