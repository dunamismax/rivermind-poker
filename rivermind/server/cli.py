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
    "--practice_stack",
    default=10_000,
    show_default=True,
    help="Chips a practice table gives at 50/100, and again whenever the guest runs out (P6.0b).",
)
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
    practice_stack: int,
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
        practice_stack=practice_stack,
    )
    uvicorn.run(app, host=host, port=port, log_level="info", ws_max_size=64 * 1024, server_header=False)


@click.group()
def moderation() -> None:
    """Review reports and collusion signals, and rename reported players (P4.5).

    Reads DATABASE_URL, like serve-nl. On ubuntu-vm, load the service's
    environment first, for example `set -a; . /etc/rivermind-poker/web.env`.
    """


def _safety(database_url: str | None):  # type: ignore[no-untyped-def]
    if not database_url:
        raise click.UsageError("Set DATABASE_URL (or --database_url) to the site's database.")
    from rivermind.db import make_engine

    from .safety import DatabaseSafety

    return DatabaseSafety(make_engine(database_url))


def _when(at: float) -> str:
    from datetime import UTC, datetime

    return datetime.fromtimestamp(at, UTC).strftime("%Y-%m-%d %H:%M UTC")


_database = click.option("--database_url", envvar="DATABASE_URL", default=None, help="PostgreSQL URL (default: DATABASE_URL).")


@moderation.command()
@_database
@click.option("--limit", default=50, show_default=True)
def reports(database_url: str | None, limit: int) -> None:
    """List the newest reports."""
    for report in _safety(database_url).reports(limit):
        where = f" at table {report.table_id}" if report.table_id else ""
        hand = f", hand {report.hand_no}" if report.hand_no else ""
        click.echo(
            f"{_when(report.at)}  {report.reason:<9}  {report.target_handle} ({report.target_id})"
            f"  by {report.reporter_id}{where}{hand}"
        )


@moderation.command()
@_database
@click.option("--limit", default=50, show_default=True)
def signals(database_url: str | None, limit: int) -> None:
    """List the newest collusion signals."""
    for signal in _safety(database_url).signals(limit):
        players = ", ".join(signal.player_ids)
        click.echo(f"{_when(signal.at)}  {signal.kind}  table {signal.table_id}  {players}  {signal.detail}")


@moderation.command()
@_database
@click.argument("player_id")
def rename(database_url: str | None, player_id: str) -> None:
    """Give PLAYER_ID a new random handle. Tables they sit at show it after they sit again."""
    if not database_url:
        raise click.UsageError("Set DATABASE_URL (or --database_url) to the site's database.")
    from rivermind.db import make_engine

    from .players import DatabasePlayers

    store = DatabasePlayers(make_engine(database_url))
    before = store.get(player_id)
    if before is None:
        raise click.ClickException(f"No player {player_id}.")
    after = store.rename(player_id)
    click.echo(f"{player_id}: {before.handle} -> {after.handle}")
