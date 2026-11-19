"""Run Alembic migrations from code (tests and, later, server start-up)."""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config

from .connection import normalize_url

MIGRATIONS = Path(__file__).with_name("migrations")


def alembic_config(url: str) -> Config:
    """An Alembic configuration for this package's migrations and ``url``."""
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS))
    config.set_main_option("sqlalchemy.url", normalize_url(url).replace("%", "%%"))
    return config


def upgrade(url: str, revision: str = "head") -> None:
    command.upgrade(alembic_config(url), revision)


def downgrade(url: str, revision: str = "base") -> None:
    command.downgrade(alembic_config(url), revision)
