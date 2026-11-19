"""`rivermind-poker serve`: run the browser table."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import click
import joblib

log = logging.getLogger("poker_ai.web")


@click.command()
@click.option("--host", default="127.0.0.1", show_default=True,
              help="Interface to listen on. Keep the default behind a reverse proxy.")
@click.option("--port", default=8000, show_default=True)
@click.option("--strategy_path", default=None,
              help="Checkpoint (agent.joblib) for RiverMind opponents.")
@click.option("--lut_path", default=None,
              help="Directory with the checkpoint's matching card_info_lut.joblib.")
@click.option("--max_tables", default=500, show_default=True,
              help="Tables kept in memory; idle ones are evicted first.")
@click.option("--state_path", default=None,
              help="SQLite file that keeps tables across restarts. Without it, "
                   "a restart closes every table.")
def serve(host: str, port: int, strategy_path: Optional[str],
          lut_path: Optional[str], max_tables: int, state_path: Optional[str]):
    """Serve the browser table. Without a checkpoint, opponents are random."""
    import uvicorn

    from poker_ai.web.app import create_app

    # Show the app's own messages (restored tables, dropped snapshots) in the
    # same stream as Uvicorn's.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")
    if bool(strategy_path) != bool(lut_path):
        raise click.UsageError("Pass --strategy_path and --lut_path together.")
    strategy = card_info_lut = None
    if strategy_path:
        # Trusted local artifacts only: joblib uses pickle.
        click.echo(f"Loading checkpoint {strategy_path} and tables {lut_path} ...")
        strategy = joblib.load(strategy_path)["strategy"]
        card_info_lut = joblib.load(Path(lut_path) / "card_info_lut.joblib")
    app = create_app(card_info_lut=card_info_lut, strategy=strategy,
                     max_tables=max_tables, state_path=state_path)
    # Client messages are tiny; cap them well below Uvicorn's 16 MB default.
    uvicorn.run(app, host=host, port=port, log_level="info",
                ws_max_size=64 * 1024, server_header=False)


@click.command()
@click.option("--output", default=None,
              help="Write the JSON Schema to this file instead of standard output.")
@click.option("--typescript", "typescript_path", default=None,
              help="Also write TypeScript types generated from the schema to this "
                   "file (the web client's src/lib/protocol.ts).")
def protocol_schema(output: Optional[str], typescript_path: Optional[str]):
    """Export the table protocol as JSON Schema, optionally as TypeScript too."""
    import json

    from poker_ai.web.protocol import json_schema
    from poker_ai.web.typescript import to_typescript

    schema = json_schema()
    text = json.dumps(schema, indent=2) + "\n"
    if output:
        Path(output).write_text(text)
    elif not typescript_path:
        click.echo(text, nl=False)
    if typescript_path:
        Path(typescript_path).write_text(to_typescript(schema))
        click.echo(f"Wrote {typescript_path}", err=True)
