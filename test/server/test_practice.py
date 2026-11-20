"""One-click practice at any balance (P6.0b).

A guest, even one with no chips, starts a heads-up hand against the labelled
RiverMind Easy bot with one request. The practice table belongs to that
guest alone, is not listed, returns the same table when asked again, never
touches the wallet or its ledger, refills a guest who ran out and marks its
hands as practice. An abandoned one closes when the server needs room.
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

from fastapi.testclient import TestClient

from rivermind.bots import CallingStationPolicy, HeuristicPolicy
from rivermind.server import RunnerOptions
from rivermind.server import protocol as p
from rivermind.server.app import PRACTICE_IDLE_SECONDS, PRACTICE_STACK, create_app
from rivermind.server.clock import ManualClock
from test.server.test_hands import hands_of
from test.server.test_lobby import advance, lobby, take_seat, waitlist
from test.server.test_protocol_v2 import SECRET, Player, Socket, make_app, server_runner, wait_for

Message = dict[str, Any]


def practice(player: Player, status: int = 200) -> Message:
    response = player.client.post("/api/practice", headers=player.headers())
    assert response.status_code == status, response.text
    if status == 200:
        p.PracticeResponse.model_validate(response.json())
    return dict(response.json())


def wallet(player: Player) -> Message:
    response = player.client.get("/api/wallet", headers=player.headers())
    assert response.status_code == 200, response.text
    return dict(response.json())


def joined(socket: Socket, table_id: str) -> Message:
    socket.send(type="join_table", table_id=table_id)
    return socket.until(lambda m: m["type"] == "table" and m["table_id"] == table_id)


def hand_no(message: Message) -> int:
    hand = message["view"]["hand"]
    return 0 if hand is None else int(hand["hand_no"])


def test_a_new_guest_practises_heads_up_against_easy_without_touching_the_wallet() -> None:
    with TestClient(make_app(seed=3)) as client:
        alice = Player(client)
        before = wallet(alice)
        started = practice(alice)
        assert started["created"] is True and started["seat"] == 0
        assert started["bot"] == "heuristic" and started["stack"] == PRACTICE_STACK
        table_id = started["table_id"]
        runner = server_runner(client, table_id)
        assert runner.practice == alice.player_id and runner.private and runner.invite is None
        with alice.socket() as a:
            first = joined(a, table_id)
            view = first["view"]
            assert view["practice"] is True and view["settings"]["seat_count"] == 2
            assert view["name"] == "Practice vs RiverMind Easy"
            you, bot = view["seats"]
            assert you["kind"] == "human" and you["stack"] == PRACTICE_STACK
            assert bot["kind"] == "bot" and bot["bot"] == "heuristic" and bot["name"].startswith("RiverMind Easy")
            # The first hand is dealt at once: no buy-in, no other step.
            a.play_until(table_id, lambda m: hand_no(m) >= 1)
            a.play_until(table_id, lambda m: hand_no(m) > 3)
            assert wallet(alice) == before
            a.send(type="leave_table", table_id=table_id)
            a.until(lambda m: m["type"] in ("left_table", "table_closed"))
        wait_for(lambda: client.app.state.server.tables.get(table_id) is None)  # type: ignore[attr-defined]
        # Practice chips stay at the table: leaving pays nothing into the wallet.
        assert wallet(alice) == before
        assert [e["kind"] for e in before["entries"]] == ["grant"]
        played = hands_of(alice)["hands"]
        assert len(played) >= 3 and all(h["practice"] for h in played)


def test_a_guest_with_no_chips_can_practise() -> None:
    with TestClient(make_app()) as client:
        alice = Player(client)
        server = client.app.state.server  # type: ignore[attr-defined]
        server.wallet.debit(alice.player_id, wallet(alice)["balance"], "buy_in", None)
        assert wallet(alice)["balance"] == 0
        # A wallet-backed table refuses them until their next top-up.
        response = client.post("/api/quick-seat", json={}, headers=alice.headers())
        assert response.status_code == 400, response.text
        table_id = practice(alice)["table_id"]
        with alice.socket() as a:
            joined(a, table_id)
            a.play_until(table_id, lambda m: hand_no(m) > 1)
        assert wallet(alice)["balance"] == 0


def test_asking_again_and_concurrent_starts_return_the_same_table() -> None:
    with TestClient(make_app()) as client:
        alice = Player(client)
        server = client.app.state.server  # type: ignore[attr-defined]
        first = practice(alice)
        again = practice(alice)
        assert again["table_id"] == first["table_id"] and again["created"] is False

        bob = Player(client)
        record = client.portal.call(server.player, bob.player_id)  # type: ignore[union-attr]

        async def twice() -> list[p.PracticeResponse]:
            return list(await asyncio.gather(server.start_practice(record), server.start_practice(record)))

        one, two = client.portal.call(twice)  # type: ignore[union-attr]
        assert one.table_id == two.table_id and {one.created, two.created} == {True, False}
        practice_tables = [r for r in server.tables.tables.values() if r.practice is not None]
        assert sorted(r.practice for r in practice_tables) == sorted([alice.player_id, bob.player_id])


def test_only_its_guest_can_see_or_join_a_practice_table() -> None:
    with TestClient(make_app()) as client:
        alice, mallory = Player(client), Player(client)
        table_id = practice(alice)["table_id"]
        assert lobby(alice) == [] and lobby(mallory) == []
        take_seat(mallory, table_id, status=404)
        waitlist(mallory, table_id, status=404)
        # Not even its own guest can buy into it with wallet chips.
        take_seat(alice, table_id, status=400)
        with mallory.socket() as m:
            m.send(type="join_table", table_id=table_id)
            refused = m.until(lambda msg: msg["type"] == "error")
            assert refused["code"] == "unknown_table"
        # Quick seat never sends anyone to a practice table, its guest included.
        seat = client.post("/api/quick-seat", json={"seats": 2}, headers=alice.headers())
        assert seat.status_code == 200, seat.text
        assert seat.json()["table_id"] != table_id
        with alice.socket() as a:
            joined(a, table_id)
            a.send(type="sit", table_id=table_id, seat=1, buy_in=4_000)
            assert a.until(lambda msg: msg["type"] == "error")["code"] == "bad_request"


def test_a_guest_who_busts_gets_a_fresh_practice_stack() -> None:
    seeds = iter(range(1000))
    options = RunnerOptions(
        hand_pause=0.0,
        bot_delay=0.0,
        require_person=True,
        clock=ManualClock(),
        rng_factory=lambda: random.Random(next(seeds)),
    )
    # A practice bot that calls every shove, so the guest busts within a few hands.
    bots = {"heuristic": CallingStationPolicy()}
    with TestClient(create_app(secret=SECRET, options=options, bots=bots)) as client:
        alice = Player(client)
        before = wallet(alice)
        table_id = practice(alice)["table_id"]
        with alice.socket() as a:
            joined(a, table_id)
            # Refilling with chips left is refused.
            a.send(type="rebuy", table_id=table_id, amount=PRACTICE_STACK)
            assert a.until(lambda m: m["type"] == "error")["code"] == "bad_request"

            def busted(m: Message) -> bool:
                view = m["view"]
                return view["seats"][0]["stack"] == 0 and (view["hand"] is None or view["hand"]["result"] is not None)

            for _ in range(200):
                latest = a.latest[table_id]
                if busted(latest):
                    break
                if a._is_new_turn(latest, table_id):
                    legal = latest["view"]["you"]["legal"]
                    if legal["max_to"] is not None:
                        a.act(table_id, latest, legal["raise_kind"], legal["max_to"])
                    else:
                        a.act(table_id, latest, "call")
                a.receive()
            else:
                raise AssertionError("the guest never busted")
            bust = hand_no(a.latest[table_id])
            a.send(type="rebuy", table_id=table_id, amount=1)
            refilled = a.until(lambda m: m["type"] == "table" and m["view"]["seats"][0]["stack"] > 0)
            assert refilled["view"]["seats"][0]["stack"] == PRACTICE_STACK
            a.play_until(table_id, lambda m: hand_no(m) > bust)
        assert wallet(alice) == before


def test_an_abandoned_practice_table_closes_when_the_server_needs_room() -> None:
    with TestClient(make_app()) as client:
        alice, bob = Player(client), Player(client)
        old = practice(alice)["table_id"]
        runner = server_runner(client, old)
        guest = runner.table.seats[0]
        assert guest is not None and guest.bot is None

        def quiet() -> bool:
            return guest.sitting_out and not runner.table.hand_in_progress

        def guests_turn() -> bool:
            turn = runner.table.turn
            return turn is not None and turn.seat == 0 and turn.final > runner.options.clock.now()

        # Nobody follows the table: the guest times out until they are sat out, and then it goes quiet.
        # Each step waits for the guest's own turn first. Moving the clock while the bot's thread is
        # still deciding would time the bot out instead, and a hand the bot folds without the guest
        # timing out resets the guest's absences (they count as connected), so under load the test
        # could run out of steps (CI on 36201aa).
        for _ in range(50):
            wait_for(lambda: quiet() or guests_turn())
            if quiet():
                break
            advance(client, 60)
        else:
            raise AssertionError("the absent guest was never sat out")
        advance(client, PRACTICE_IDLE_SECONDS + 1)
        practice(bob)
        wait_for(lambda: client.app.state.server.tables.get(old) is None)  # type: ignore[attr-defined]
        again = practice(alice)
        assert again["created"] is True and again["table_id"] != old


def test_the_practice_bot_falls_back_to_one_the_server_runs() -> None:
    options = RunnerOptions(hand_pause=0.0, bot_delay=0.0, require_person=True, clock=ManualClock())
    with TestClient(create_app(secret=SECRET, options=options, bots={"easy": HeuristicPolicy()})) as client:
        alice = Player(client)
        assert practice(alice)["bot"] == "easy"


def test_the_practice_stack_is_a_server_setting() -> None:
    options = RunnerOptions(hand_pause=0.0, bot_delay=0.0, require_person=True, clock=ManualClock())
    with TestClient(create_app(secret=SECRET, options=options, practice_stack=1_000)) as client:
        assert client.get("/api/config").json()["practice_stack"] == 1_000
        alice = Player(client)
        started = practice(alice)
        assert started["stack"] == 1_000
        settings = server_runner(client, started["table_id"]).table.config
        assert (settings.min_buy_in, settings.max_buy_in) == (1_000, 1_000)
    for bad in (0, 99, 1.5):
        try:
            create_app(secret=SECRET, practice_stack=bad)  # type: ignore[arg-type]
        except ValueError:
            continue
        raise AssertionError(f"a practice stack of {bad!r} was accepted")
