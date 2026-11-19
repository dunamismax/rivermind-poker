"""`rivermind-poker serve-nl`: run the no-limit table server (Phase 3)."""

from __future__ import annotations

import logging
import os
import secrets
from pathlib import Path

import click

SECRET_ENV = "RIVERMIND_SECRET"


def load_secret(secret_file: str | None) -> bytes | None:
    """The session secret from ``RIVERMIND_SECRET`` or a file, made if missing."""
    value = os.environ.get(SECRET_ENV)
    if value:
        return value.encode()
    if not secret_file:
        return None
    path = Path(secret_file)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(secrets.token_hex(32) + "\n")
    return path.read_text().strip().encode()


@click.command()
@click.option("--host", default="127.0.0.1", show_default=True, help="Interface to listen on.")
@click.option("--port", default=8000, show_default=True)
@click.option(
    "--secret_file",
    default=None,
    help=f"File holding the secret that signs session cookies; made if missing. {SECRET_ENV} overrides it. "
    "Without either, sessions last only until a restart.",
)
@click.option("--max_tables", default=200, show_default=True)
@click.option("--hand_pause", default=3.0, show_default=True, help="Seconds between hands.")
@click.option("--bot_delay", default=0.6, show_default=True, help="Seconds a bot waits before acting.")
@click.option(
    "--database_url",
    envvar="DATABASE_URL",
    default=None,
    help="PostgreSQL URL for durable tables (default: DATABASE_URL). Migrate it first with "
    "`alembic upgrade head`. Without one, tables live only in memory.",
)
@click.option(
    "--allowed_origin",
    "allowed_origins",
    multiple=True,
    help="Another origin whose pages may use the API, such as https://example.com. Repeatable. "
    "The server's own origin, and loopback pages calling a loopback server, are always allowed.",
)
@click.option(
    "--client_dir",
    default=None,
    help="Also serve this SvelteKit build (web/build) with the site's security headers.",
)
def serve_nl(
    host: str,
    port: int,
    secret_file: str | None,
    max_tables: int,
    hand_pause: float,
    bot_delay: float,
    database_url: str | None,
    allowed_origins: tuple[str, ...],
    client_dir: str | None,
) -> None:
    """Serve no-limit tables of 2 to 9 seats against the Phase 2 bots."""
    import uvicorn

    from .app import create_app
    from .runner import RunnerOptions

    logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")
    options = RunnerOptions(hand_pause=hand_pause, bot_delay=bot_delay, require_person=True)
    store = None
    if database_url:
        from rivermind.db import make_engine

        from .store import TableStore

        store = TableStore(make_engine(database_url))
    else:
        logging.getLogger("rivermind.server").warning("No DATABASE_URL: tables will not survive a restart")
    app = create_app(
        secret=load_secret(secret_file),
        options=options,
        max_tables=max_tables,
        client_dir=client_dir,
        store=store,
        allowed_origins=allowed_origins,
    )
    uvicorn.run(app, host=host, port=port, log_level="info", ws_max_size=64 * 1024, server_header=False)
