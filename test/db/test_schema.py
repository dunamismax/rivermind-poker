"""PostgreSQL schema and migrations (P3.1)."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from rivermind.db import Base, Hand, HandHistory, PokerTable, Seat, alembic_config, downgrade, make_engine, upgrade
from rivermind.db.connection import database_url, normalize_url
from rivermind.engine.fuzz import play_random_hand
from rivermind.engine.history import FORMAT, hand_record, replay_record

ROOT = Path(__file__).resolve().parents[2]
TABLES = {"poker_tables", "seats", "hands", "hand_histories"}


def head(url: str) -> str:
    return ScriptDirectory.from_config(alembic_config(url)).get_current_head()  # type: ignore[return-value]


def current(engine: Engine) -> str | None:
    with engine.connect() as conn:
        return MigrationContext.configure(conn).get_current_revision()


def test_url_helpers() -> None:
    assert normalize_url("postgresql://u@h/db") == "postgresql+psycopg://u@h/db"
    assert normalize_url("postgres://h/db") == "postgresql+psycopg://h/db"
    assert normalize_url("postgresql+psycopg://h/db") == "postgresql+psycopg://h/db"
    assert database_url({"DATABASE_URL": "postgresql://h/db"}) == "postgresql+psycopg://h/db"
    with pytest.raises(RuntimeError):
        database_url({})


def test_upgrade_head_on_an_empty_database(empty_database: str) -> None:
    engine = make_engine(empty_database)
    assert not set(inspect(engine).get_table_names()) & TABLES
    upgrade(empty_database)
    assert TABLES <= set(inspect(engine).get_table_names())
    assert current(engine) == head(empty_database)
    engine.dispose()


def test_downgrade_then_upgrade(engine: Engine, empty_database: str) -> None:
    downgrade(empty_database, "base")
    assert not set(inspect(engine).get_table_names()) & TABLES
    assert current(engine) is None
    upgrade(empty_database)
    assert TABLES <= set(inspect(engine).get_table_names())
    assert current(engine) == head(empty_database)


def test_models_match_the_migrations(engine: Engine) -> None:
    with engine.connect() as conn:
        context = MigrationContext.configure(conn, opts={"compare_type": True})
        assert compare_metadata(context, Base.metadata) == []


def test_alembic_command_line(empty_database: str) -> None:
    env = {**os.environ, "DATABASE_URL": empty_database}
    for args in (["upgrade", "head"], ["current"], ["downgrade", "base"], ["upgrade", "head"]):
        done = subprocess.run(
            [sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env, capture_output=True, text=True, check=False
        )
        assert done.returncode == 0, done.stderr
    assert "0001" in subprocess.run(
        [sys.executable, "-m", "alembic", "current"], cwd=ROOT, env=env, capture_output=True, text=True, check=True
    ).stdout


def add_table(session: Session, table_id: str = "t1", seat_count: int = 6) -> PokerTable:
    table = PokerTable(
        id=table_id,
        name="Table 1",
        seat_count=seat_count,
        small_blind=50,
        big_blind=100,
        min_buy_in=4_000,
        max_buy_in=10_000,
    )
    session.add(table)
    return table


def test_tables_seats_hands_and_histories_round_trip(engine: Engine) -> None:
    import random

    state = play_random_hand(6, random.Random("db"), check_illegal=False)
    record = hand_record(state)
    with Session(engine) as session:
        table = add_table(session)
        table.seats = [
            Seat(seat_no=0, display_name="River", is_bot=False, stack=10_000),
            Seat(seat_no=3, display_name="Heuristic bot", is_bot=True, bot_kind="heuristic", stack=9_500),
        ]
        hand = Hand(hand_no=1, button=state.button)
        hand.history = HandHistory(format=FORMAT, record=record)
        table.hands.append(hand)
        session.commit()
    with Session(engine) as session:
        table = session.get(PokerTable, "t1")
        assert table is not None and table.status == "open" and table.ante == 0
        assert [(s.seat_no, s.is_bot, s.bot_kind) for s in table.seats] == [(0, False, None), (3, True, "heuristic")]
        stored = session.scalars(select(HandHistory)).one()
        assert stored.format == FORMAT and stored.hand.table_id == "t1"
        assert replay_record(stored.record) == state
        session.delete(table)
        session.commit()
        assert session.scalars(select(HandHistory)).all() == []


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO poker_tables (id, name, seat_count, small_blind, big_blind, min_buy_in, max_buy_in) VALUES ('x', 'x', 10, 50, 100, 1, 2)",
        "INSERT INTO poker_tables (id, name, seat_count, small_blind, big_blind, min_buy_in, max_buy_in) VALUES ('x', 'x', 6, 100, 50, 1, 2)",
        "INSERT INTO poker_tables (id, name, seat_count, small_blind, big_blind, min_buy_in, max_buy_in) VALUES ('x', 'x', 6, 50, 100, 5, 2)",
        "INSERT INTO poker_tables (id, name, seat_count, small_blind, big_blind, min_buy_in, max_buy_in, state) VALUES ('x', 'x', 6, 50, 100, 1, 2, '{}')",
        "INSERT INTO seats (table_id, seat_no, display_name, is_bot, stack) VALUES ('t1', 9, 'x', false, 10)",
        "INSERT INTO seats (table_id, seat_no, display_name, is_bot, stack) VALUES ('t1', 1, 'x', false, -1)",
        "INSERT INTO seats (table_id, seat_no, display_name, is_bot, stack) VALUES ('t1', 1, 'x', true, 10)",
        "INSERT INTO seats (table_id, seat_no, display_name, is_bot, stack) VALUES ('missing', 1, 'x', false, 10)",
        "INSERT INTO hands (table_id, hand_no, button) VALUES ('t1', 1, 0)",
        "INSERT INTO hands (table_id, hand_no, button) VALUES ('t1', 2, 9)",
    ],
)
def test_constraints_reject_bad_rows(engine: Engine, sql: str) -> None:
    with Session(engine) as session:
        add_table(session)
        session.add(Hand(table_id="t1", hand_no=1, button=0))
        session.commit()
    with engine.connect() as conn, pytest.raises(IntegrityError):
        conn.execute(text(sql))
