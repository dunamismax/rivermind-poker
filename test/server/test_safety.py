"""Safety and abuse controls (P4.5).

Rate limits on HTTP and the socket, the handle filter, preset reactions,
reports, mutes and blocks, and the same-address collusion signal, through
the app as a browser uses it.
"""

from __future__ import annotations

import random
from typing import Any

import pytest
from fastapi.testclient import TestClient

from rivermind.server import auth
from rivermind.server import protocol as p
from rivermind.server.app import create_app
from rivermind.server.clock import ManualClock
from rivermind.server.players import ADJECTIVES, ANIMALS, MemoryPlayers, random_handle
from rivermind.server.runner import RunnerOptions
from rivermind.server.safety import (
    REACTIONS,
    UNLIMITED,
    Limits,
    MemorySafety,
    RateLimiter,
    Report,
    address_tag,
    client_address,
    handle_allowed,
    pairs,
)
from test.server.test_lobby import lobby, new_table, take_seat
from test.server.test_protocol_v2 import SECRET, Player, Socket

Message = dict[str, Any]


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def make_app(limits: Limits = UNLIMITED, seed: int = 0) -> Any:
    seeds = iter(range(seed * 1000, seed * 1000 + 1000))
    options = RunnerOptions(
        hand_pause=0.0,
        bot_delay=0.0,
        require_person=True,
        clock=ManualClock(),
        rng_factory=lambda: random.Random(next(seeds)),
    )
    return create_app(secret=SECRET, options=options, limits=limits)


def server_of(client: TestClient) -> Any:
    return client.app.state.server  # type: ignore[attr-defined]


def until_type(socket: Socket, kind: str) -> Message:
    return socket.until(lambda m: m["type"] == kind)


def two_at_a_table(client: TestClient) -> tuple[Player, Player, str]:
    """Alice and Bob seated at a two-seat table for people, Alice in seat 0 and Bob in seat 1."""
    alice, bob = Player(client), Player(client)
    table_id = new_table(alice, seats=2, bots=None)["table_id"]
    seat = take_seat(bob, table_id, buy_in=5_000)
    assert seat["seated"] and seat["seat"] == 1
    return alice, bob, table_id


# Rate limits


def test_a_token_bucket_spends_its_burst_then_refills() -> None:
    clock = FakeClock()
    limiter = RateLimiter(rate=2.0, burst=3, clock=clock)
    assert [limiter.allow("a") for _ in range(4)] == [True, True, True, False]
    assert limiter.allow("b"), "each key has its own bucket"
    assert limiter.retry_after("a") == pytest.approx(0.5)
    clock.now += 0.5
    assert limiter.allow("a") and not limiter.allow("a")
    clock.now += 100
    assert [limiter.allow("a") for _ in range(4)] == [True, True, True, False], "a bucket never holds more than its burst"
    clock.now += 61  # full buckets are forgotten
    limiter.allow("c")
    assert set(limiter._buckets) == {"c"}
    with pytest.raises(ValueError):
        RateLimiter(rate=0, burst=1)


def test_forwarded_addresses_are_trusted_only_from_this_machine() -> None:
    assert client_address("127.0.0.1", "203.0.113.9") == "203.0.113.9"
    assert client_address("::1", "198.51.100.1, 203.0.113.9") == "203.0.113.9", "Caddy adds the client last"
    assert client_address("198.51.100.7", "203.0.113.9") == "198.51.100.7", "a remote peer cannot choose its address"
    assert client_address("testclient", "203.0.113.9") == "testclient"
    assert client_address(None, None) == "unknown"
    assert client_address("127.0.0.1", None) == "127.0.0.1"
    tag = address_tag(SECRET, "203.0.113.9")
    assert tag == address_tag(SECRET, "203.0.113.9") and "203" not in tag
    assert tag != address_tag(SECRET, "203.0.113.10") and tag != address_tag(b"other", "203.0.113.9")


def test_unsafe_requests_are_limited_per_player_and_new_players_per_address() -> None:
    clock = FakeClock()
    limits = Limits(http_rate=1.0, http_burst=4, new_player_rate=0.1, new_player_burst=3, clock=clock)
    with TestClient(make_app(limits)) as client:
        alice = Player(client)  # one new player and one request from this address
        for _ in range(4):
            assert client.post("/api/session", headers=alice.headers()).status_code == 200
        refused = client.post("/api/session", headers=alice.headers())
        assert refused.status_code == 429 and refused.headers["Retry-After"] == "1"
        p.HttpError.model_validate(refused.json())
        assert client.get("/api/wallet", headers=alice.headers()).status_code == 200, "reading is not limited"
        clock.now += 1
        assert client.post("/api/session", headers=alice.headers()).status_code == 200
        # Two more new players from this address, then the third is refused.
        Player(client)
        Player(client)
        made = client.post("/api/session")
        assert made.status_code == 429 and int(made.headers["Retry-After"]) == 9, "a second has passed since the first"
        client.cookies.clear()
        clock.now += 10
        Player(client)


def test_a_socket_sending_too_fast_is_refused_then_closed() -> None:
    clock = FakeClock()
    limits = Limits(socket_rate=1.0, socket_burst=2, socket_strikes=3, clock=clock)
    with TestClient(make_app(limits)) as client:
        alice = Player(client)
        table_id = alice.new_table(2, bots="random")
        with alice.socket() as a:
            a.send(type="join_table", table_id=table_id)
            until_type(a, "table")
            a.send(type="refresh", table_id=table_id)
            a.send(type="refresh", table_id=table_id)
            refused = until_type(a, "error")
            assert refused["code"] == p.ErrorCode.RATE_LIMITED and refused["message"] == "Too many messages: slow down."
            clock.now += 1
            for _ in range(4):
                a.send(type="refresh", table_id=table_id)
            # One more is allowed, then two refusals, and the third closes the socket.
            errors = []
            with pytest.raises(Exception):  # noqa: B017 - the socket closes
                while True:
                    message = a.receive()
                    if message["type"] == "error":
                        errors.append(message["message"])
            assert errors == ["Too many messages: slow down."] * 2 + ["Too many messages: reload the page to keep playing."]


# Handles


def test_every_generated_handle_passes_the_filter() -> None:
    for adjective in ADJECTIVES:
        for animal in ANIMALS:
            assert handle_allowed(f"{adjective} {animal} 42"), (adjective, animal)
    for _ in range(2_000):
        assert handle_allowed(random_handle())
    assert handle_allowed("Guest 4821") and handle_allowed("Proud Peacock 7")


@pytest.mark.parametrize(
    "handle",
    ["Sh1t Fox", "f u c k", "f.u.c.k Owl", "Shitty", "Big Bitch 9", "$lut", "Fûck", "Nazi Wolf", "", "   ", "x" * 33, "C0CK", "Dick Seal 1"],
)
def test_the_filter_refuses_blocked_words(handle: str) -> None:
    assert not handle_allowed(handle)


def test_renaming_gives_a_new_allowed_handle() -> None:
    players = MemoryPlayers()
    record = players.create()
    renamed = players.rename(record.player_id)
    assert renamed.player_id == record.player_id and renamed.handle != record.handle
    assert handle_allowed(renamed.handle) and players.get(record.player_id) == renamed


# Reactions, mutes and blocks


def test_seated_people_react_and_a_mute_hides_their_reactions() -> None:
    clock = FakeClock()
    limits = Limits(reaction_rate=0.5, reaction_burst=2, clock=clock)
    with TestClient(make_app(limits)) as client:
        alice, bob, table_id = two_at_a_table(client)
        carol = Player(client)
        with alice.socket() as a, bob.socket() as b, carol.socket() as c:
            for socket in (a, b, c):
                socket.send(type="join_table", table_id=table_id)
                until_type(socket, "table")
            a.send(type="react", table_id=table_id, reaction="nice_hand")
            for socket in (a, b, c):
                reaction = until_type(socket, "reaction")
                assert reaction == {
                    "type": "reaction",
                    "table_id": table_id,
                    "seat": 0,
                    "name": alice.name,
                    "ref": auth.public_ref(alice.player_id),
                    "reaction": "nice_hand",
                    "text": "Nice hand",
                }
            # Only the preset reactions, and only from a seat.
            a.send(type="react", table_id=table_id, reaction="you stink")
            assert until_type(a, "error")["code"] == "bad_request"
            c.send(type="react", table_id=table_id, reaction="wow")
            assert until_type(c, "error")["code"] == "not_seated"
            # Bob mutes Alice: he no longer hears her, Carol still does.
            muted = client.put("/api/relations", json={"table_id": table_id, "seat": 0, "kind": "mute"}, headers=bob.headers())
            assert muted.status_code == 200, muted.text
            assert muted.json() == {
                "players": [{"ref": auth.public_ref(alice.player_id), "name": alice.name, "kind": "mute"}]
            }
            a.send(type="react", table_id=table_id, reaction="good_game")
            assert until_type(a, "reaction")["reaction"] == "good_game"
            assert until_type(c, "reaction")["reaction"] == "good_game"
            b.send(type="refresh", table_id=table_id)
            b.until(lambda m: m["type"] == "table" and m["events"] == [])
            assert [m["reaction"] for m in b.messages if m["type"] == "reaction"] == ["nice_hand"]
            # Alice has spent her two reactions; the third waits for the bucket.
            a.send(type="react", table_id=table_id, reaction="wow")
            refused = until_type(a, "error")
            assert refused["code"] == "rate_limited" and refused["table_id"] == table_id
            clock.now += 2
            a.send(type="react", table_id=table_id, reaction="wow")
            assert until_type(c, "reaction")["reaction"] == "wow"
            # Unmuting by the public reference brings her back.
            ref = auth.public_ref(alice.player_id)
            assert client.delete(f"/api/relations/{ref}", headers=bob.headers()).json() == {"players": []}
            assert client.delete(f"/api/relations/{ref}", headers=bob.headers()).status_code == 404
            clock.now += 2
            a.send(type="react", table_id=table_id, reaction="thanks")
            assert until_type(b, "reaction")["reaction"] == "thanks"


def test_seat_views_name_people_by_ref_never_by_id() -> None:
    with TestClient(make_app()) as client:
        alice, bob, table_id = two_at_a_table(client)
        with alice.socket() as a:
            a.send(type="join_table", table_id=table_id)
            view = until_type(a, "table")["view"]
            assert [s["ref"] for s in view["seats"]] == [auth.public_ref(alice.player_id), auth.public_ref(bob.player_id)]
            text = str([s for s in view["seats"]])
            assert bob.player_id not in text
        carol = Player(client)
        bots = new_table(carol, seats=3, bots="random")["table_id"]
        with carol.socket() as c:
            c.send(type="join_table", table_id=bots)
            view = until_type(c, "table")["view"]
            assert [s["ref"] is None for s in view["seats"]] == [False, True, True]


def test_relations_need_a_person_in_the_seat() -> None:
    with TestClient(make_app()) as client:
        alice, bob, table_id = two_at_a_table(client)
        carol = Player(client)
        bots = new_table(carol, seats=3, bots="random")["table_id"]
        for body, status in (
            ({"table_id": table_id, "seat": 0, "kind": "block"}, 400),  # Alice's own seat
            ({"table_id": bots, "seat": 1, "kind": "block"}, 400),  # a bot
            ({"table_id": "nope", "seat": 1, "kind": "block"}, 404),
            ({"table_id": table_id, "seat": 1, "kind": "hate"}, 400),
            ({"table_id": table_id, "seat": 9, "kind": "mute"}, 400),
        ):
            response = client.put("/api/relations", json=body, headers=alice.headers())
            assert response.status_code == status, (body, response.text)
        assert client.get("/api/relations").status_code == 401
        assert client.get("/api/relations", headers=alice.headers()).json() == {"players": []}


def test_quick_seat_keeps_blocked_players_apart() -> None:
    with TestClient(make_app()) as client:
        alice, bob = Player(client), Player(client)
        table_id = new_table(alice, seats=6, bots=None)["table_id"]
        # Bob sits with Alice, blocks her and leaves; quick seat no longer sends him there.
        take_seat(bob, table_id, buy_in=5_000)
        seat = server_of(client).tables.get(table_id).table.seat_of(bob.player_id)
        assert seat is not None
        blocked = client.put("/api/relations", json={"table_id": table_id, "seat": 0, "kind": "block"}, headers=bob.headers())
        assert blocked.json()["players"][0]["kind"] == "block"
        (row,) = lobby(bob)
        assert row["blocked"] is True
        assert lobby(alice)[0]["blocked"] is True, "a block keeps both apart"
        carol = Player(client)
        assert lobby(carol)[0]["blocked"] is False
        with bob.socket() as b:
            b.send(type="join_table", table_id=table_id)
            until_type(b, "table")
            b.send(type="leave_table", table_id=table_id)
            until_type(b, "left_table")
        runner = server_of(client).tables.get(table_id)
        client.portal.call(runner.wait_until, lambda t: t.seat_of(bob.player_id) is None)
        quick = client.post("/api/quick-seat", json={"seats": 6, "buy_in": 5_000}, headers=bob.headers())
        assert quick.status_code == 200 and quick.json()["table_id"] != table_id
        # Carol is not blocked, so she joins Alice's busier table.
        joined = client.post("/api/quick-seat", json={"seats": 6, "buy_in": 5_000}, headers=carol.headers())
        assert joined.json()["table_id"] == table_id
        # A block can change to a mute in place.
        table = server_of(client).tables.get(table_id).table
        carol_seat = table.seat_of(carol.player_id)
        assert carol_seat is not None
        for kind in ("block", "mute"):
            body = {"table_id": table_id, "seat": carol_seat, "kind": kind}
            players = client.put("/api/relations", json=body, headers=alice.headers()).json()["players"]
            assert [(x["name"], x["kind"]) for x in players] == [(carol.name, kind)]


# Reports


def test_reports_are_recorded_once_a_day_and_limited() -> None:
    clock = FakeClock()
    limits = Limits(report_rate=1 / 60, report_burst=3, clock=clock)
    with TestClient(make_app(limits)) as client:
        alice, bob, table_id = two_at_a_table(client)
        safety = server_of(client).safety

        def report(reporter: Player, seat: int, reason: str, status: int = 201) -> Message:
            response = client.post(
                "/api/reports", json={"table_id": table_id, "seat": seat, "reason": reason}, headers=reporter.headers()
            )
            assert response.status_code == status, response.text
            return dict(response.json())

        assert report(alice, 1, "handle") == {"recorded": True}
        assert report(alice, 1, "handle") == {"recorded": False}, "the same report counts once"
        assert report(alice, 1, "collusion") == {"recorded": True}
        report(alice, 1, "abuse", status=429)
        assert report(alice, 0, "abuse", status=400)["detail"] == "That is your own seat."
        report(bob, 0, "rude", status=400)
        report(bob, 5, "abuse", status=404)
        stored = safety.reports(10)
        assert [(r.reason, r.target_id, r.target_handle, r.table_id) for r in stored] == [
            ("collusion", bob.player_id, bob.name, table_id),
            ("handle", bob.player_id, bob.name, table_id),
        ]
        assert all(r.reporter_id == alice.player_id for r in stored)


def test_memory_reports_repeat_after_a_day() -> None:
    safety = MemorySafety()
    report = Report("p_a", "p_b", "B", "abuse", "t", 3, 1000.0)
    assert safety.report(report) and not safety.report(report)
    assert safety.report(Report("p_a", "p_b", "B", "abuse", "t", 9, 1000.0 + 24 * 3600))
    assert safety.report(Report("p_c", "p_b", "B", "abuse", "t", 3, 1000.0)), "another reporter counts"


# Collusion signals


def test_two_people_from_one_address_at_a_table_raise_one_signal() -> None:
    with TestClient(make_app()) as client:
        # Every TestClient request comes from the address "testclient".
        alice, bob, table_id = two_at_a_table(client)
        server = server_of(client)
        (signal,) = server.safety.signals(10)
        assert signal.kind == "same_address" and signal.table_id == table_id
        assert set(signal.player_ids) == {alice.player_id, bob.player_id}
        assert signal.detail["address"] == address_tag(SECRET, "testclient")
        assert signal.detail["seats"] == [0, 1]
        # Leaving and sitting again does not repeat it.
        with bob.socket() as b:
            b.send(type="join_table", table_id=table_id)
            until_type(b, "table")
            b.send(type="leave_table", table_id=table_id)
            until_type(b, "left_table")
        runner = server.tables.get(table_id)
        client.portal.call(runner.wait_until, lambda t: t.seat_of(bob.player_id) is None)
        take_seat(bob, table_id, buy_in=5_000)
        assert len(server.safety.signals(10)) == 1


def test_people_from_different_addresses_raise_none() -> None:
    with TestClient(make_app()) as client:
        alice, bob = Player(client), Player(client)
        server = server_of(client)
        server.note_address(alice.player_id, "203.0.113.1")
        table_id = new_table(alice, seats=2, bots=None)["table_id"]
        server.note_address(bob.player_id, "203.0.113.2")
        take_seat(bob, table_id, buy_in=5_000)
        assert server.safety.signals(10) == []
        bots = new_table(Player(client), seats=3, bots="random")["table_id"]
        assert server.safety.signals(10) == [] and bots


def test_config_offers_the_preset_reactions() -> None:
    with TestClient(make_app()) as client:
        reactions = client.get("/api/config").json()["reactions"]
        assert [r["kind"] for r in reactions] == [k.value for k in REACTIONS]
        assert all(r["text"] for r in reactions)


def test_pairs() -> None:
    assert pairs(["b", "a", "c", "a"]) == [("a", "b"), ("a", "c"), ("b", "c")]


def test_the_client_offers_the_servers_reactions() -> None:
    import re
    from pathlib import Path

    source = (Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "nl" / "safety.ts").read_text()
    offered = re.findall(r"\{ kind: '(\w+)', text: '([^']+)' \}", source)
    assert offered == [(kind.value, text) for kind, text in REACTIONS.items()]
