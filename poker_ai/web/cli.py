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
def serve(host: str, port: int, strategy_path: Optional[str],
          lut_path: Optional[str], max_tables: int):
    """Serve the browser table. Without a checkpoint, opponents are random."""
    import uvicorn

    from poker_ai.web.app import create_app

    if bool(strategy_path) != bool(lut_path):
        raise click.UsageError("Pass --strategy_path and --lut_path together.")
    strategy = card_info_lut = None
    if strategy_path:
        # Trusted local artifacts only: joblib uses pickle.
        click.echo(f"Loading checkpoint {strategy_path} and tables {lut_path} ...")
        strategy = joblib.load(strategy_path)["strategy"]
        card_info_lut = joblib.load(Path(lut_path) / "card_info_lut.joblib")
    app = create_app(card_info_lut=card_info_lut, strategy=strategy,
                     max_tables=max_tables)
    uvicorn.run(app, host=host, port=port, log_level="info")
