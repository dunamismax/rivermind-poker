"""Players stored in PostgreSQL (P4.1)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select

from rivermind.db import Player
from rivermind.server import auth, players
from rivermind.server.players import DatabasePlayers
from rivermind.server.store import TableStore
from test.db.test_durable_tables import make_app
from test.server.test_protocol_v2 import Player as Browser


def test_players_are_stored_with_unique_handles(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    store = DatabasePlayers(engine)
    first = store.create()
    assert store.get(first.player_id) == first
    assert store.get("p_missing") is None

    # A handle that is taken is drawn again rather than shared.
    draws = iter([first.handle, first.handle, "Calm Otter 7"])
    monkeypatch.setattr(players, "random_handle", lambda: next(draws))
    second = store.create()
    assert second.handle == "Calm Otter 7" and second.player_id != first.player_id
    monkeypatch.setattr(players, "random_handle", lambda: first.handle)
    with pytest.raises(RuntimeError):
        store.create()

    # Claiming a Phase 3 player keeps their guest handle, and is idempotent.
    legacy = auth.new_player_id()
    claimed = store.claim(legacy)
    assert claimed.handle == auth.guest_name(legacy) and store.claim(legacy) == claimed

    with engine.connect() as conn:
        before = conn.execute(select(Player.last_seen_at).where(Player.id == first.player_id)).scalar_one()
    store.seen(first.player_id)
    with engine.connect() as conn:
        rows: list[Any] = conn.execute(select(Player.id, Player.handle, Player.last_seen_at)).all()
    assert {row.id for row in rows} == {first.player_id, second.player_id, legacy}
    assert next(row.last_seen_at for row in rows if row.id == first.player_id) >= before


def test_a_session_outlives_a_restart(engine: Engine) -> None:
    store = TableStore(engine)
    with TestClient(make_app(store, 1)) as client:
        browser = Browser(client)
    with TestClient(make_app(store, 2)) as client:
        again = client.post("/api/session", headers=browser.headers()).json()
        assert again == {"player_id": browser.player_id, "name": browser.name, "created": False, "balance": 20_000}
        assert client.post("/api/tables", json={"seats": 2}, headers=browser.headers()).status_code == 201
