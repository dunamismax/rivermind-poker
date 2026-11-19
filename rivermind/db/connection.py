"""Database URLs and engines."""

from __future__ import annotations

import os

from sqlalchemy import Engine, create_engine

ENV_VAR = "DATABASE_URL"


def normalize_url(url: str) -> str:
    """Use the psycopg 3 driver for ``postgresql://`` and ``postgres://`` URLs."""
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix) :]
    return url


def database_url(environ: dict[str, str] | None = None) -> str:
    """The configured database URL, from ``DATABASE_URL``."""
    env = os.environ if environ is None else environ
    url = env.get(ENV_VAR)
    if not url:
        raise RuntimeError(f"set {ENV_VAR} to a PostgreSQL URL, such as postgresql://localhost/rivermind")
    return normalize_url(url)


def make_engine(url: str | None = None, **kwargs: object) -> Engine:
    """A SQLAlchemy engine for ``url``, or for ``DATABASE_URL`` when it is omitted."""
    return create_engine(normalize_url(url) if url else database_url(), pool_pre_ping=True, **kwargs)  # type: ignore[arg-type]
