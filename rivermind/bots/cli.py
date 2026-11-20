"""``rivermind-poker tables``: build, verify and query card tables (P5.2)."""

from __future__ import annotations

import json
from pathlib import Path

import click

from rivermind.engine.cards import cards as parse_cards


@click.group()
def tables() -> None:
    """Card abstraction tables for the trained no-limit bots (docs/bots.md)."""


@tables.command("build")
@click.option("--out", default="artifacts/tables/hu-m1", show_default=True, help="Directory to create.")
@click.option("--seed", default=0, show_default=True)
@click.option("--workers", default=None, type=int, help="Processes to use (default: every CPU).")
@click.option("--flop_buckets", default=1000, show_default=True)
@click.option("--turn_buckets", default=1000, show_default=True)
@click.option("--river_buckets", default=1000, show_default=True)
@click.option("--sample", default=500_000, show_default=True, help="Flop and turn hands k-means is fitted on.")
@click.option("--max_iter", default=300, show_default=True)
@click.option("--limit", default=None, type=int, hidden=True, help="Only the first classes of each street (tests).")
@click.option("--keep_work", is_flag=True, help="Keep the river equities and histograms in work/.")
def build_command(
    out: str,
    seed: int,
    workers: int | None,
    flop_buckets: int,
    turn_buckets: int,
    river_buckets: int,
    sample: int,
    max_iter: int,
    limit: int | None,
    keep_work: bool,
) -> None:
    """Build a table set with exact equities and seeded k-means."""
    from rivermind.bots.cards import Settings, build

    settings = Settings(
        flop_buckets=flop_buckets,
        turn_buckets=turn_buckets,
        river_buckets=river_buckets,
        seed=seed,
        sample=sample,
        max_iter=max_iter,
        limit=limit,
    )
    try:
        manifest = build(Path(out), settings, workers=workers, keep_work=keep_work)
    except (FileExistsError, ValueError) as e:
        raise click.ClickException(str(e)) from e
    click.echo(json.dumps({"out": out, "build": manifest["build"], "files": manifest["files"]}, indent=2))


@tables.command("verify")
@click.argument("path")
def verify_command(path: str) -> None:
    """Check every file against the manifest's SHA-256s."""
    from rivermind.bots.cards import verify_files

    bad = verify_files(Path(path))
    if bad:
        raise click.ClickException(f"differ from the manifest: {', '.join(bad)}")
    click.echo(f"{path}: every file matches its manifest")


@tables.command("bucket")
@click.argument("path")
@click.argument("hole")
@click.argument("board", default="")
def bucket_command(path: str, hole: str, board: str) -> None:
    """Print the bucket of HOLE (such as AsKd) on BOARD (such as Qh7c2s)."""
    from rivermind.bots.cards import CardTables, TableError

    try:
        found = CardTables(path).bucket(parse_cards(hole), parse_cards(board) if board else ())
    except (TableError, ValueError) as e:
        raise click.ClickException(str(e)) from e
    click.echo(found)
