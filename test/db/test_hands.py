"""Players' hand histories stored in PostgreSQL (P4.6)."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import Engine, select

from rivermind.db import HandPlayer, LedgerEntry, PokerTable
from rivermind.server.store import TableStore
from test.db.test_durable_tables import make_app
from test.server.test_hands import detail, hands_of
from test.server.test_protocol_v2 import Player


def test_hands_are_stored_with_their_players_and_outlive_a_restart(engine: Engine) -> None:
    store = TableStore(engine)
    with TestClient(make_app(store, 5)) as client:
        alice = Player(client)
        table_id = alice.new_table(3, bots="random")
        with alice.socket() as a:
            a.send(type="join_table", table_id=table_id)
            a.play_until(table_id, lambda m: m["view"]["hand"] is not None and m["view"]["hand"]["hand_no"] > 4)
        hands = hands_of(alice)["hands"]
    assert len(hands) >= 4
    with engine.connect() as conn:
        rows = conn.execute(select(HandPlayer.hand_id, HandPlayer.player_id, HandPlayer.bot_kind, HandPlayer.net)).all()
    by_hand: dict[int, list[tuple[str | None, str | None, int]]] = {}
    for hand_id, player_id, bot_kind, net in rows:
        by_hand.setdefault(hand_id, []).append((player_id, bot_kind, net))
    assert {str(h) for h in by_hand} >= {h["hand_id"] for h in hands}
    for seats in by_hand.values():
        assert sum(net for _, _, net in seats) == 0
        assert [p for p, _, _ in seats if p is not None] == [alice.player_id]
        assert sorted(b for _, b, _ in seats if b is not None) == ["random", "random"]
    # A new process lists and opens the same hands.
    with TestClient(make_app(store, 6)) as client:
        alice.client = client
        again = hands_of(alice)["hands"]
        assert [h["hand_id"] for h in again] == [h["hand_id"] for h in hands]
        body = detail(alice, hands[0]["hand_id"])
        assert body["hand"]["table_id"] == table_id and alice.name in body["text"]
        stranger = Player(client)
        detail(stranger, hands[0]["hand_id"], status=404)


def test_practice_tables_survive_a_restart_and_their_hands_are_marked(engine: Engine) -> None:
    """P6.0b: the table comes back for its guest only, its hands are practice, and the ledger never moves."""
    store = TableStore(engine)
    with TestClient(make_app(store, 7)) as client:
        alice = Player(client)
        before = client.get("/api/wallet", headers=alice.headers()).json()
        started = client.post("/api/practice", headers=alice.headers()).json()
        table_id = started["table_id"]
        with alice.socket() as a:
            a.send(type="join_table", table_id=table_id)
            a.play_until(table_id, lambda m: m["view"]["hand"] is not None and m["view"]["hand"]["hand_no"] > 2)
        regular = alice.new_table(2, bots="random")
        with alice.socket() as a:
            a.send(type="join_table", table_id=regular)
            a.play_until(regular, lambda m: m["view"]["hand"] is not None and m["view"]["hand"]["hand_no"] > 1)
    with engine.connect() as conn:
        marked = dict(conn.execute(select(PokerTable.id, PokerTable.practice)).all())
        ledger = conn.execute(select(LedgerEntry.kind, LedgerEntry.table_id).where(LedgerEntry.player_id == alice.player_id)).all()
    assert marked[table_id] is True and marked[regular] is False
    # Only the grant and the regular table's buy-in: practice never reached the ledger.
    assert sorted(kind for kind, _ in ledger) == ["buy_in", "grant"]
    assert all(t != table_id for _, t in ledger)
    with TestClient(make_app(store, 8)) as client:
        alice.client = client
        again = client.post("/api/practice", headers=alice.headers()).json()
        assert again == {**started, "created": False}
        hands = hands_of(alice)["hands"]
        by_table = {h["table_id"]: h["practice"] for h in hands}
        assert by_table == {table_id: True, regular: False}
        stranger = Player(client)
        with stranger.socket() as s:
            s.send(type="join_table", table_id=table_id)
            assert s.until(lambda m: m["type"] == "error")["code"] == "unknown_table"
        assert client.get("/api/wallet", headers=alice.headers()).json()["balance"] == before["balance"] - 10_000
