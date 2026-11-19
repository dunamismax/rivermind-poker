"""Reports, mutes and blocks, and collusion signals in PostgreSQL (P4.5)."""

from __future__ import annotations

import threading

from click.testing import CliRunner
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select

from poker_ai.cli.runner import cli
from rivermind.db import PlayerReport
from rivermind.server import auth
from rivermind.server.players import DatabasePlayers
from rivermind.server.safety import DatabaseSafety, Report, Signal, handle_allowed
from rivermind.server.store import TableStore
from test.db.test_durable_tables import make_app
from test.server.test_lobby import new_table, take_seat
from test.server.test_protocol_v2 import Player as Browser


def test_reports_relations_and_signals_are_stored(engine: Engine) -> None:
    players = DatabasePlayers(engine)
    alice, bob, carol = players.create(), players.create(), players.create()
    safety = DatabaseSafety(engine)

    report = Report(alice.player_id, bob.player_id, bob.handle, "handle", "t1", 4, 1_000_000.0)
    assert safety.report(report)
    assert not safety.report(report), "the same report within a day counts once"
    assert safety.report(Report(alice.player_id, bob.player_id, bob.handle, "handle", "t1", 9, 1_000_000.0 + 86_401))
    assert safety.report(Report(carol.player_id, bob.player_id, bob.handle, "handle", None, None, 1_000_000.0))
    stored = safety.reports(10)
    assert [(r.reporter_id, r.hand_no, r.at) for r in stored] == [
        (carol.player_id, None, 1_000_000.0),
        (alice.player_id, 9, 1_000_000.0 + 86_401),
        (alice.player_id, 4, 1_000_000.0),
    ]

    safety.set_relation(alice.player_id, bob.player_id, "mute")
    safety.set_relation(alice.player_id, bob.player_id, "block")  # a mute becomes a block in place
    safety.set_relation(carol.player_id, alice.player_id, "block")
    safety.set_relation(carol.player_id, bob.player_id, "mute")
    assert [(r.target_id, r.handle, r.kind) for r in safety.relations(alice.player_id)] == [
        (bob.player_id, bob.handle, "block")
    ]
    assert safety.blocks_involving(alice.player_id) == {bob.player_id, carol.player_id}
    assert safety.blocks_involving(bob.player_id) == {alice.player_id}, "a mute is not a block"
    safety.remove_relation(alice.player_id, bob.player_id)
    assert safety.relations(alice.player_id) == [] and safety.blocks_involving(bob.player_id) == set()

    safety.signal(Signal("same_address", "t1", (alice.player_id, bob.player_id), {"address": "ab12"}, 2_000_000.0))
    (signal,) = safety.signals(10)
    assert signal == Signal("same_address", "t1", (alice.player_id, bob.player_id), {"address": "ab12"}, 2_000_000.0)


def test_concurrent_repeat_reports_count_once(engine: Engine) -> None:
    players = DatabasePlayers(engine)
    alice, bob = players.create(), players.create()
    safety = DatabaseSafety(engine)
    results: list[bool] = []
    barrier = threading.Barrier(8)

    def send() -> None:
        barrier.wait()
        results.append(safety.report(Report(alice.player_id, bob.player_id, bob.handle, "abuse", None, None, 5_000_000.0)))

    threads = [threading.Thread(target=send) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == [False] * 7 + [True]
    with engine.connect() as conn:
        assert conn.execute(select(func.count()).select_from(PlayerReport)).scalar_one() == 1


def test_the_app_stores_safety_in_the_database_and_moderation_reads_it(engine: Engine, empty_database: str) -> None:
    store = TableStore(engine)
    with TestClient(make_app(store)) as client:
        alice, bob = Browser(client), Browser(client)
        table_id = new_table(alice, seats=2, bots=None)["table_id"]
        take_seat(bob, table_id, buy_in=5_000)
        body = {"table_id": table_id, "seat": 1, "reason": "collusion"}
        assert client.post("/api/reports", json=body, headers=alice.headers()).json() == {"recorded": True}
        mute = {"table_id": table_id, "seat": 0, "kind": "mute"}
        assert client.put("/api/relations", json=mute, headers=bob.headers()).status_code == 200
    # A new process reads the mute back.
    with TestClient(make_app(store, 2)) as client:
        players = client.get("/api/relations", headers=bob.headers()).json()["players"]
        assert players == [{"ref": auth.public_ref(alice.player_id), "name": alice.name, "kind": "mute"}]
    safety = DatabaseSafety(engine)
    (signal,) = safety.signals(5)
    assert set(signal.player_ids) == {alice.player_id, bob.player_id}

    runner = CliRunner()
    env = {"DATABASE_URL": empty_database}
    listed = runner.invoke(cli, ["moderation", "reports"], env=env)
    assert listed.exit_code == 0, listed.output
    assert "collusion" in listed.output and bob.name in listed.output and alice.player_id in listed.output
    flagged = runner.invoke(cli, ["moderation", "signals"], env=env)
    assert flagged.exit_code == 0 and "same_address" in flagged.output and table_id in flagged.output
    renamed = runner.invoke(cli, ["moderation", "rename", bob.player_id], env=env)
    assert renamed.exit_code == 0, renamed.output
    new_handle = DatabasePlayers(engine).get(bob.player_id)
    assert new_handle is not None and new_handle.handle != bob.name and handle_allowed(new_handle.handle)
    assert f"{bob.name} -> {new_handle.handle}" in renamed.output
    missing = runner.invoke(cli, ["moderation", "rename", "p_nobody"], env=env)
    assert missing.exit_code != 0 and "No player" in missing.output
    assert runner.invoke(cli, ["moderation", "reports"], env={"DATABASE_URL": ""}).exit_code != 0
