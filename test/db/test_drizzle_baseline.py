"""The Drizzle migrations in ``web/drizzle`` build Alembic's schema exactly (P4B.3).

Until the Python server is retired (P4B.8) the live database is migrated by
Alembic, and from the cutover (P4B.7) by Drizzle. Both must describe the same
schema: every column with its type, default and identity, every constraint
and every index. A new Alembic revision for a live fix needs a matching
Drizzle migration (``pnpm db:generate`` from ``web/``), or this test fails.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, text

from rivermind.db import make_engine, upgrade

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "web" / "drizzle"

COLUMNS = """
SELECT table_name, ordinal_position, column_name, data_type, character_maximum_length,
       is_nullable, column_default, is_identity, identity_generation, identity_start,
       identity_increment, identity_maximum, identity_minimum, identity_cycle
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name <> 'alembic_version'
ORDER BY table_name, ordinal_position
"""
CONSTRAINTS = """
SELECT conrelid::regclass::text, conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace AND conrelid <> 'alembic_version'::regclass
ORDER BY 1, 2
"""
INDEXES = """
SELECT tablename, indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename <> 'alembic_version'
ORDER BY 1, 2
"""
SEQUENCES = """
SELECT sequencename, data_type, start_value, min_value, max_value, increment_by, cycle, cache_size
FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1
"""


def describe(engine: Engine) -> dict[str, list[tuple[Any, ...]]]:
    with engine.connect() as conn:
        return {
            name: [tuple(row) for row in conn.execute(text(query))]
            for name, query in (
                ("columns", COLUMNS),
                ("constraints", CONSTRAINTS),
                ("indexes", INDEXES),
                ("sequences", SEQUENCES),
            )
        }


def drizzle_migrations() -> list[str]:
    journal = json.loads((MIGRATIONS / "meta" / "_journal.json").read_text())
    return [(MIGRATIONS / f"{entry['tag']}.sql").read_text() for entry in journal["entries"]]


def test_drizzle_builds_alembics_schema(empty_database: str) -> None:
    engine = make_engine(empty_database)
    upgrade(empty_database)
    alembic = describe(engine)
    assert alembic["columns"] and alembic["constraints"] and alembic["indexes"]

    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
        # Alembic's table is created first, so the comparison's filters work on both sides.
        conn.execute(text("CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)"))
        for migration in drizzle_migrations():
            for statement in migration.split("--> statement-breakpoint"):
                if statement.strip():
                    conn.exec_driver_sql(statement)
    drizzle = describe(engine)
    engine.dispose()

    for part in alembic:
        assert drizzle[part] == alembic[part], part


def test_the_baseline_names_alembics_head() -> None:
    from rivermind.db.migrate import alembic_config
    from alembic.script import ScriptDirectory

    migrate_ts = (ROOT / "web" / "src" / "lib" / "server" / "db" / "migrate.ts").read_text()
    match = re.search(r"export const ALEMBIC_HEAD = '(\d+)'", migrate_ts)
    assert match
    revisions = {rev.revision for rev in ScriptDirectory.from_config(alembic_config("postgresql://x/y")).walk_revisions()}
    assert match.group(1) in revisions
