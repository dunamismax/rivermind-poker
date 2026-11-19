"""Players' own hand histories (P4.6).

Each player lists the finished hands they were dealt into and opens one in
full, seeing their own cards and the hands shown at showdown, never a hand
that was folded or mucked, and never a hand they were not in.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from rivermind.engine import card_str
from rivermind.engine.history import replay_record
from rivermind.server import protocol as p
from rivermind.server.hands import MemoryHands
from rivermind.server.table import Finished, HandSeat
from test.server.test_lobby import new_table, take_seat
from test.server.test_protocol_v2 import Player, Socket, cards_in, make_app

Message = dict[str, Any]


def hands_of(player: Player, status: int = 200, **params: Any) -> Message:
    response = player.client.get("/api/hands", params=params, headers=player.headers())
    assert response.status_code == status, response.text
    if status == 200:
        p.HandListResponse.model_validate(response.json())
    return dict(response.json())


def detail(player: Player, hand_id: str, status: int = 200) -> Message:
    response = player.client.get(f"/api/hands/{hand_id}", headers=player.headers())
    assert response.status_code == status, response.text
    if status == 200:
        p.HandDetail.model_validate(response.json())
    return dict(response.json())


def play_together(sockets: list[Socket], table_id: str, hands: int) -> None:
    """Play every turn of each socket until ``hands`` more hands have ended."""
    first = sockets[0]
    start = first.latest[table_id]["view"]["hand"]["hand_no"] if first.latest[table_id]["view"]["hand"] else 0
    while True:
        view = first.latest[table_id]["view"]
        done = view["hand"] is not None and view["hand"]["hand_no"] > start + hands
        if done:
            return
        for socket in sockets:
            latest = socket.latest[table_id]
            if socket._is_new_turn(latest, table_id):
                socket.play(table_id, latest)
        for socket in sockets:
            socket.receive()


def test_two_people_see_their_own_hands_and_only_the_cards_shown() -> None:
    with TestClient(make_app(seed=7)) as client:
        alice, bob = Player(client), Player(client)
        table_id = new_table(alice, seats=2, bots=None)["table_id"]
        take_seat(bob, table_id, buy_in=5_000)
        server = client.app.state.server  # type: ignore[attr-defined]
        with alice.socket() as a, bob.socket() as b:
            for socket in (a, b):
                socket.send(type="join_table", table_id=table_id)
                socket.until(lambda m: m["type"] == "table")
            play_together([a, b], table_id, 6)

        carol = Player(client)
        assert hands_of(carol) == {"hands": [], "more": False}
        listed = {}
        for player in (alice, bob):
            body = hands_of(player)
            hands = body["hands"]
            assert len(hands) >= 6 and body["more"] is False
            assert [h["hand_no"] for h in hands] == sorted((h["hand_no"] for h in hands), reverse=True)
            assert all(h["table_id"] == table_id and h["seat_count"] == 2 and len(h["cards"]) == 2 for h in hands)
            listed[player.player_id] = hands
        assert [h["hand_id"] for h in listed[alice.player_id]] == [h["hand_id"] for h in listed[bob.player_id]]
        # Heads-up, every chip one wins the other loses.
        for mine, theirs in zip(listed[alice.player_id], listed[bob.player_id], strict=True):
            assert mine["net"] == -theirs["net"] and mine["seat"] != theirs["seat"]

        folded = shown = 0
        for summary in listed[alice.player_id]:
            hand_id = summary["hand_id"]
            stored = server.hands.get(hand_id)
            state = replay_record(stored.record)
            assert state.result is not None
            for player in (alice, bob):
                seat = stored.seat_of(player.player_id)
                other = 1 - seat
                body = detail(player, hand_id)
                assert body["hand"]["seat"] == seat
                mine = [card_str(c) for c in state.hole_cards[seat]]
                theirs = [card_str(c) for c in state.hole_cards[other]]
                seen = cards_in(body)
                assert set(mine) <= seen
                you = next(s for s in body["seats"] if s["you"])
                assert you["seat"] == seat and you["name"] == player.name
                if other in state.result.shown:
                    shown += 1
                    assert set(theirs) <= seen
                else:
                    folded += 1
                    assert not set(theirs) & seen, "a folded or mucked hand never shows"
                    assert not any(card in body["text"] for card in theirs)
                    assert next(s for s in body["seats"] if s["seat"] == other)["cards"] is None
                assert player.name in body["text"] and "S0" not in body["text"]
            # Nobody else may open it.
            detail(carol, hand_id, status=404)
        assert folded and shown, (folded, shown)
        detail(alice, "nope", status=404)
        detail(alice, "999999", status=404)
        assert client.get("/api/hands").status_code == 401


def test_hands_page_newest_first() -> None:
    with TestClient(make_app(seed=3)) as client:
        alice = Player(client)
        table_id = alice.new_table(3, bots="random")
        with alice.socket() as a:
            a.send(type="join_table", table_id=table_id)
            a.play_until(table_id, lambda m: m["view"]["hand"] is not None and m["view"]["hand"]["hand_no"] > 5)
        everything = hands_of(alice, limit=50)["hands"]
        assert len(everything) >= 5
        first = hands_of(alice, limit=2)
        assert first["more"] is True and [h["hand_id"] for h in first["hands"]] == [h["hand_id"] for h in everything[:2]]
        second = hands_of(alice, limit=2, before=first["hands"][-1]["hand_id"])
        assert [h["hand_id"] for h in second["hands"]] == [h["hand_id"] for h in everything[2:4]]
        assert len(hands_of(alice, limit=500)["hands"]) == len(everything), "the limit is capped at 50"
        body = detail(alice, everything[0]["hand_id"])
        bots = [s for s in body["seats"] if s["kind"] == "bot"]
        assert len(bots) == 2 and all(s["bot"] == "random" for s in bots)
        assert sum(s["net"] for s in body["seats"]) == 0, "chips are conserved"


def test_memory_hands_keep_the_newest() -> None:
    from rivermind.engine import HandConfig, start_hand

    import random

    hands = MemoryHands(limit=3, per_player=2)
    state = start_hand(HandConfig(50, 100), (1000, 1000), 0, rng=random.Random(1))
    # Fold the hand out so it has a result.
    from rivermind.engine import Action, ActionKind, apply

    state = apply(state, Action(ActionKind.FOLD))
    seats = (HandSeat("p_a", "A", None), HandSeat("bot-1", "Bot", "random"))
    added = [hands.add("t", "Table", Finished(n, state, seats)) for n in range(1, 5)]
    assert [h.hand_id for h in hands.played("p_a", 10)] == [added[3].hand_id, added[2].hand_id]
    assert hands.get(added[0].hand_id) is None, "the oldest hand is dropped"
    assert hands.played("bot-1", 10) == [] and hands.get("x") is None
    assert added[3].seats[1].player_id is None and added[3].seats[1].bot == "random"
    assert added[3].seats[0].net + added[3].seats[1].net == 0


def test_live_tables_shuffle_with_the_systems_cryptographic_randomness(monkeypatch: Any) -> None:
    """D-8: `serve-nl` deals every table from `secrets.SystemRandom`, never a seeded generator."""
    import secrets

    import uvicorn
    from click.testing import CliRunner

    from rivermind.server.cli import serve_nl

    served: list[Any] = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **_: served.append(app))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    result = CliRunner().invoke(serve_nl, ["--port", "1"])
    assert result.exit_code == 0, result.output
    (app,) = served
    with TestClient(app) as client:
        alice = Player(client)
        table_id = alice.new_table(2, bots="random")
        runner = client.app.state.server.tables.get(table_id)  # type: ignore[attr-defined]
        assert type(runner.rng) is secrets.SystemRandom
