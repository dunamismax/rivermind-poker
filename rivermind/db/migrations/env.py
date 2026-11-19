"""Alembic environment for RiverMind's PostgreSQL schema."""

from __future__ import annotations

import os
import re

from alembic import context
from sqlalchemy import Connection, engine_from_config, pool, text

from rivermind.db.connection import database_url, normalize_url
from rivermind.db.models import Base

config = context.config
if config.config_file_name is not None:
    from logging.config import fileConfig

    fileConfig(config.config_file_name)
target_metadata = Base.metadata


def _url() -> str:
    configured = config.get_main_option("sqlalchemy.url")
    return normalize_url(configured) if configured else database_url()


def _assume_role(connection: Connection) -> None:
    """On ubuntu-vm the migration login role creates objects as the owner role."""
    role = os.environ.get("RIVERMIND_MIGRATION_ROLE")
    if not role:
        return
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", role):
        raise ValueError(f"bad RIVERMIND_MIGRATION_ROLE: {role!r}")
    connection.execute(text(f'SET ROLE "{role}"'))
    connection.commit()


def run_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_online() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
        return
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _url()
    engine = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with engine.connect() as conn:
        _assume_role(conn)
        context.configure(connection=conn, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_offline()
else:
    run_online()
