"""The lobby over HTTP and the socket (P4.3).

People list the public tables with filters, quick-seat, take a bot's seat,
hold seats, wait in line for a full table and join private tables with an
invite code. Two people at one table play several hands together, each
seeing only their own cards.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from rivermind.server import protocol as p
from rivermind.server.table import RESERVE_SECONDS
from test.server.test_protocol_v2 import Player, Spy, check_privacy, make_app, server_runner, wait_for

Message = dict[str, Any]


def lobby(player: Player, **filters: Any) -> list[Message]:
    response = player.client.get("/api/tables", params=filters, headers=player.headers())
    assert response.status_code == 200, response.text
    p.TableListResponse.model_validate(response.json())
    return list(response.json()["tables"])


def new_table(player: Player, **body: Any) -> Message:
    response = player.client.post("/api/tables", json=body, headers=player.headers())
    assert response.status_code == 201, response.text
    return dict(response.json())


def take_seat(player: Player, table_id: str, status: int = 200, **body: Any) -> Message:
    response = player.client.post(f"/api/tables/{table_id}/seat", json=body, headers=player.headers())
    assert response.status_code == status, response.text
    if status == 200:
        p.SeatResponse.model_validate(response.json())
    return dict(response.json())


def waitlist(player: Player, table_id: str, status: int = 200, **body: Any) -> Message:
    response = player.client.post(f"/api/tables/{table_id}/waitlist", json=body, headers=player.headers())
    assert response.status_code == status, response.text
    return dict(response.json())


def advance(client: TestClient, seconds: float) -> None:
    clock = client.app.state.server.options.clock  # type: ignore[attr-defined]
    client.portal.call(clock.advance, seconds)  # type: ignore[union-attr]


def test_the_lobby_lists_public_tables_with_filters() -> None:
    with TestClient(make_app()) as client:
        alice, bob, carol = Player(client), Player(client), Player(client)
        assert client.get("/api/tables").status_code == 401
        public = new_table(alice, seats=6, bots="random", big_blind=100)
        assert public["invite"] is None
        private = new_table(bob, seats=2, bots=None, big_blind=50, private=True)
        assert private["invite"]
        (row,) = lobby(carol)
        assert row["table_id"] == public["table_id"]
        assert (row["people"], row["bots"], row["free_seats"], row["bot_seats"]) == (1, 5, 0, 5)
        assert (row["small_blind"], row["big_blind"], row["seat_count"], row["private"]) == (50, 100, 6, False)
        assert not row["seated"] and row["hold"] is None and row["waitlist_position"] is None
        assert [t["table_id"] for t in lobby(carol, seats=6, big_blind=100, open=True)] == [public["table_id"]]
        assert lobby(carol, seats=2) == [] and lobby(carol, big_blind=200) == []
        # Each person sees the private table they are at, and only that one.
        assert {t["table_id"]: t["seated"] for t in lobby(bob)} == {public["table_id"]: False, private["table_id"]: True}
        assert [t["table_id"] for t in lobby(alice)] == [public["table_id"]]
        # Bob's table has a free seat but no bots; a full public table is left out of open=true.
        assert lobby(bob, seats=2)[0]["free_seats"] == 1


def test_two_people_play_together_after_one_takes_a_bots_seat() -> None:
    with TestClient(make_app(seed=4)) as client:
        alice, bob = Player(client), Player(client)
        table_id = new_table(alice, seats=3, bots="random")["table_id"]
        runner = server_runner(client, table_id)
        spy = Spy(runner)
        with alice.socket() as a, bob.socket() as b:
            a.send(type="join_table", table_id=table_id)
            a.my_turn(table_id)  # a hand is under way, waiting for Alice
            seat = take_seat(bob, table_id, buy_in=5_000)
            # The bot Bob displaced finishes the hand first; the seat is held for him.
            assert seat["seated"] is False and seat["hold"]["ready"] is False
            held = seat["seat"]
            a.play_until(table_id, lambda m: m["view"]["seats"][held] is None)
            hold = a.latest[table_id]["view"]["holds"][0]
            assert (hold["seat"], hold["name"], hold["ready"]) == (held, bob.name, True)
            b.send(type="join_table", table_id=table_id)
            view = b.until(lambda m: m["type"] == "table")["view"]
            assert view["you"]["hold"]["ready"] and view["you"]["seat"] is None
            b.send(type="sit", table_id=table_id, seat=held, buy_in=5_000)
            seated = b.until(lambda m: m["type"] == "table" and m["view"]["you"]["seat"] == held)
            assert seated["view"]["holds"] == [] and seated["view"]["seats"][held]["kind"] == "human"
            a.until(lambda m: m["type"] == "table" and m["view"]["seats"][held] is not None)
            # Both follow the table now and are in step: every change reaches
            # both, one message each. Play three hands; every message to either
            # keeps the other's cards hidden.
            start = a.latest[table_id]["view"]["hand"]["hand_no"]
            hands = start
            while hands < start + 3:
                for socket in (a, b):
                    latest = socket.latest[table_id]
                    if socket._is_new_turn(latest, table_id):
                        socket.play(table_id, latest)
                for socket in (a, b):
                    message = socket.receive()
                    assert message["type"] == "table", message
                    check_privacy(message, spy)
                hands = a.latest[table_id]["view"]["hand"]["hand_no"]
                assert b.latest[table_id]["view"]["seq"] == a.latest[table_id]["view"]["seq"]
            dealt = runner.table.hand_players
            assert {alice.player_id, bob.player_id} <= set(dealt)


def test_quick_seat_joins_the_busiest_matching_table_or_starts_one() -> None:
    with TestClient(make_app()) as client:
        alice, bob, carol = Player(client), Player(client), Player(client)
        table_id = new_table(alice, seats=6, bots="random", big_blind=100)["table_id"]
        quick = client.post("/api/quick-seat", json={}, headers=bob.headers())
        assert quick.status_code == 200, quick.text
        assert quick.json()["table_id"] == table_id
        # A hand is waiting for Alice, so Bob holds a bot's seat until it ends.
        assert quick.json()["seated"] or quick.json()["hold"] is not None
        other = client.post("/api/quick-seat", json={"seats": 2}, headers=carol.headers())
        assert other.status_code == 200 and other.json()["table_id"] != table_id and other.json()["seated"]
        assert server_runner(client, other.json()["table_id"]).table.config.seat_count == 2
        # Quick seat again: Carol already sits at a 2-seat table and goes back to it.
        again = client.post("/api/quick-seat", json={"seats": 2}, headers=carol.headers())
        assert again.json() == other.json()


def test_private_tables_need_their_invite() -> None:
    with TestClient(make_app()) as client:
        alice, bob, carol = Player(client), Player(client), Player(client)
        made = new_table(alice, seats=3, bots="random", private=True)
        table_id, code = made["table_id"], made["invite"]
        assert lobby(bob) == []
        assert client.get("/api/invites/not-a-code", headers=bob.headers()).status_code == 404
        found = client.get(f"/api/invites/{code}", headers=bob.headers())
        assert found.status_code == 200 and found.json()["table_id"] == table_id and found.json()["private"]
        take_seat(bob, table_id, status=404)
        take_seat(bob, table_id, status=404, invite="wrong")
        waitlist(bob, table_id, status=404)
        with carol.socket() as c:
            c.send(type="join_table", table_id=table_id)
            error = c.until(lambda m: m["type"] == "error")
            assert error["code"] == "unknown_table"
        held = take_seat(bob, table_id, invite=code, hold_only=True)
        assert held["seated"] is False and held["hold"] is not None
        with bob.socket() as b:
            b.send(type="join_table", table_id=table_id)
            view = b.until(lambda m: m["type"] == "table")["view"]
            assert view["private"] and view["invite"] == code
        with alice.socket() as a:
            a.send(type="join_table", table_id=table_id)
            assert a.until(lambda m: m["type"] == "table")["view"]["invite"] == code


def test_a_full_table_has_a_waitlist_and_held_seats_run_out() -> None:
    with TestClient(make_app(seed=2)) as client:
        alice, bob, carol, dave = (Player(client) for _ in range(4))
        table_id = new_table(alice, seats=2, bots=None)["table_id"]
        runner = server_runner(client, table_id)
        waitlist(carol, table_id, status=400)  # a seat is free: take it instead
        assert take_seat(bob, table_id)["seated"] is True
        take_seat(carol, table_id, status=409)
        assert waitlist(carol, table_id)["position"] == 1
        assert waitlist(dave, table_id)["position"] == 2
        assert waitlist(carol, table_id)["position"] == 1  # asking again keeps the place
        assert lobby(dave)[0]["waitlist_position"] == 2 and lobby(dave)[0]["waitlist"] == 2
        assert lobby(dave, open=True) == []
        with alice.socket() as a, bob.socket() as b:
            a.send(type="join_table", table_id=table_id)
            b.send(type="join_table", table_id=table_id)
            b.until(lambda m: m["type"] == "table")
            b.send(type="leave_table", table_id=table_id)
            b.until(lambda m: m["type"] == "left_table")
            # Bob folds out of the hand; when it ends his seat is held for Carol.
            a.play_until(table_id, lambda m: m["view"]["seats"][1] is None and bool(m["view"]["holds"]))
        hold = runner.table.reservations[1]
        assert hold.player_id == carol.player_id and hold.ready
        (row,) = lobby(carol)
        assert row["hold"]["seat"] == 1 and row["hold"]["ready"]
        assert lobby(dave)[0]["waitlist_position"] == 1
        # Carol does not come back in time: the seat passes to Dave.
        advance(client, RESERVE_SECONDS)
        wait_for(lambda: runner.table.reservations.get(1) is not None and runner.table.reservations[1].player_id == dave.player_id)
        take_seat(carol, table_id, status=409)
        assert take_seat(dave, table_id, buy_in=4_000)["seated"] is True
        assert runner.table.waitlist == [] and runner.table.reservations == {}
        # Giving up a place in line and a held seat over HTTP.
        assert waitlist(carol, table_id)["position"] == 1
        assert client.delete(f"/api/tables/{table_id}/waitlist", headers=carol.headers()).status_code == 204
        assert runner.table.waitlist == []


def test_a_seat_nobody_takes_goes_back_to_a_bot() -> None:
    with TestClient(make_app(seed=7)) as client:
        alice, bob = Player(client), Player(client)
        table_id = new_table(alice, seats=3, bots="calling_station")["table_id"]
        runner = server_runner(client, table_id)
        held = take_seat(bob, table_id, hold_only=True)["seat"]
        with alice.socket() as a:
            a.send(type="join_table", table_id=table_id)
            # The bot leaves when Alice's hand ends, and the empty seat waits for Bob.
            a.play_until(table_id, lambda m: m["view"]["seats"][held] is None)
            assert runner.table.reservations[held].ready
            assert client.delete(f"/api/tables/{table_id}/seat", headers=bob.headers()).status_code == 204
            refilled = a.until(lambda m: m["type"] == "table" and m["view"]["seats"][held] is not None)
            assert refilled["view"]["seats"][held]["kind"] == "bot" and refilled["view"]["holds"] == []
