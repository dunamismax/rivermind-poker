"""Database fixtures. Tests use RIVERMIND_TEST_DATABASE_URL, an isolated database.

Locally the database tests are skipped when the variable is unset. In CI
(``CI`` set) a missing variable fails them instead, so they can never be
skipped silently there. Each test starts from an empty ``public`` schema, so
the database name must contain ``test``.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.engine import make_url

from rivermind.db import make_engine, normalize_url

ENV_VAR = "RIVERMIND_TEST_DATABASE_URL"


@pytest.fixture(scope="session")
def database_url() -> str:
    url = os.environ.get(ENV_VAR)
    if not url:
        if os.environ.get("CI"):
            pytest.fail(f"{ENV_VAR} must be set in CI")
        pytest.skip(f"{ENV_VAR} is not set")
    name = make_url(normalize_url(url)).database or ""
    if "test" not in name:
        pytest.fail(f"refusing to reset database {name!r}: its name must contain 'test'")
    return normalize_url(url)


@pytest.fixture()
def empty_database(database_url: str) -> Iterator[str]:
    """A database with an empty ``public`` schema."""
    engine = make_engine(database_url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    engine.dispose()
    yield database_url


@pytest.fixture()
def engine(empty_database: str) -> Iterator[Engine]:
    from rivermind.db import upgrade

    upgrade(empty_database)
    eng = make_engine(empty_database)
    yield eng
    eng.dispose()
