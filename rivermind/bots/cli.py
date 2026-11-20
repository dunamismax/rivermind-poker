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


SETTING_OPTIONS = (
    "seed",
    "chunk_size",
    "chunks_per_batch",
    "discount_every",
    "discount_until",
    "prune_after",
    "prune_probability",
    "prune_threshold",
    "regret_floor",
)


@click.group()
def blueprint() -> None:
    """Heads-up blueprint training on the hu-m1 abstraction (docs/bots.md)."""


@blueprint.command("tree")
def tree_command() -> None:
    """Print each depth class's compiled tree: nodes, widths and SHA-256."""
    from rivermind.bots.blueprint import compile_tree
    from rivermind.bots.blueprint.tree import DEPTHS

    click.echo(json.dumps([compile_tree(d).summary() for d in DEPTHS], indent=2))


@blueprint.command("train")
@click.argument("run")
@click.option("--tables", "tables_path", default="artifacts/tables/hu-m1", show_default=True, help="Card table set.")
@click.option("--iterations", required=True, type=int, help="Train until this many iterations in all (whole batches).")
@click.option("--workers", default=None, type=int, help="Processes to use (default: every CPU).")
@click.option("--checkpoint_every", default=10_000_000, show_default=True, type=int)
@click.option("--keep", default=2, show_default=True, help="Checkpoints to keep.")
@click.option("--resume", is_flag=True, help="Continue RUN from its latest checkpoint.")
@click.option("--seed", default=0, show_default=True)
@click.option("--chunk_size", default=1_000, show_default=True)
@click.option("--chunks_per_batch", default=64, show_default=True)
@click.option("--discount_every", default=1_000_000, show_default=True)
@click.option("--discount_until", default=40_000_000, show_default=True)
@click.option("--prune_after", default=20_000_000, show_default=True)
@click.option("--prune_probability", default=0.95, show_default=True)
@click.option("--prune_threshold", default=-10_000_000, show_default=True)
@click.option("--regret_floor", default=-11_000_000, show_default=True)
@click.pass_context
def train_command(
    ctx: click.Context,
    run: str,
    tables_path: str,
    iterations: int,
    workers: int | None,
    checkpoint_every: int,
    keep: int,
    resume: bool,
    **options: object,
) -> None:
    """Train (or with --resume, continue) the blueprint in RUN.

    Ctrl-C or SIGTERM stops at the end of the current batch and writes a
    checkpoint. Progress lines go to RUN/train.log as JSON.
    """
    import os
    import signal
    import time

    from rivermind.bots.blueprint import CardDealer, CheckpointError, Settings, Trainer, latest_checkpoint
    from rivermind.bots.blueprint.train import RunInUseError
    from rivermind.bots.cards import TableError
    from rivermind.bots.cards.build import MemorySampler

    run_path = Path(run)
    workers = workers or os.cpu_count() or 1
    try:
        dealer = CardDealer(tables_path, verify=True)
    except (TableError, ValueError) as e:
        raise click.ClickException(str(e)) from e
    given = [n for n in SETTING_OPTIONS if ctx.get_parameter_source(n) is not click.core.ParameterSource.DEFAULT]
    has_checkpoint = latest_checkpoint(run_path) is not None
    try:
        if resume:
            if given:
                raise click.ClickException(f"a resumed run keeps its settings; drop {', '.join('--' + n for n in given)}")
            trainer = Trainer.resume(run_path, dealer, workers=workers)
        else:
            if has_checkpoint:
                raise click.ClickException(f"{run} already has checkpoints; pass --resume to continue it")
            trainer = Trainer(run_path, Settings(**options), dealer, workers=workers)  # type: ignore[arg-type]
    except (CheckpointError, RunInUseError, ValueError) as e:
        raise click.ClickException(str(e)) from e

    stop = {"requested": False}

    def request_stop(signum: int, frame: object) -> None:
        stop["requested"] = True
        click.echo("stopping at the end of this batch", err=True)

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    log = (run_path / "train.log").open("a")
    started = time.time()
    start_iteration = trainer.iteration
    last = {"t": 0.0}

    def on_batch(p: object) -> None:
        from rivermind.bots.blueprint.train import Progress

        assert isinstance(p, Progress)
        now = time.time()
        if p.checkpoint is None and now - last["t"] < 30:
            return
        last["t"] = now
        rate = (p.iteration - start_iteration) / max(now - started, 1e-9)
        line = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "iteration": p.iteration,
            "iterations_per_second": round(rate, 1),
            "seconds": round(p.seconds, 1),
            "peak_rss_bytes": memory.peak,
            "checkpoint": p.checkpoint.name if p.checkpoint else None,
        }
        log.write(json.dumps(line) + "\n")
        log.flush()
        eta = (iterations - p.iteration) / rate if rate else 0
        click.echo(f"{p.iteration:,} iterations, {rate:,.0f}/s, {eta / 3600:.2f} h left" + (f", checkpoint {p.checkpoint.name}" if p.checkpoint else ""))

    with MemorySampler(interval=5) as memory, trainer:
        final = trainer.train(
            iterations,
            checkpoint_every=checkpoint_every,
            on_batch=on_batch,
            should_stop=lambda: stop["requested"],
            keep=keep,
        )
    summary = {
        "run": run,
        "iteration": final.iteration,
        "seconds_this_session": round(time.time() - started, 1),
        "iterations_per_second": round((final.iteration - start_iteration) / max(time.time() - started, 1e-9), 1),
        "peak_rss_bytes_all_processes": memory.peak,
        "workers": workers,
        "checkpoint": str(latest_checkpoint(run_path)),
    }
    log.write(json.dumps({"summary": summary}) + "\n")
    log.close()
    click.echo(json.dumps(summary, indent=2))


@blueprint.command("info")
@click.argument("path")
@click.option("--verify", is_flag=True, help="Check every file against the manifest's SHA-256s.")
def info_command(path: str, verify: bool) -> None:
    """Summarize a checkpoint, or a run's latest checkpoint."""
    from rivermind.bots.blueprint import CheckpointError, latest_checkpoint, read_manifest

    target = Path(path)
    if not (target / "manifest.json").exists():
        found = latest_checkpoint(target)
        if found is None:
            raise click.ClickException(f"{path} is neither a checkpoint nor a run with one")
        target = found
    try:
        manifest = read_manifest(target, verify=verify)
    except CheckpointError as e:
        raise click.ClickException(str(e)) from e
    shown = {
        "checkpoint": str(target),
        "iteration": manifest["iteration"],
        "settings": manifest["settings"],
        "trees": [{k: t[k] for k in ("depth", "decision_nodes", "info_sets", "sha256")} for t in manifest["game"]["trees"]],
        "cards": {k: manifest["cards"][k] for k in ("path", "abstraction", "seed")},
        "stats": manifest["stats"],
        "software": manifest["software"],
        "verified": verify,
    }
    click.echo(json.dumps(shown, indent=2))


@blueprint.command("export")
@click.argument("checkpoint")
@click.option("--out", required=True, help="Bundle directory to create, such as artifacts/bundles/hu-m1-s0-128m.")
@click.option("--tables", "tables_path", default=None, help="Card table set (default: the one the checkpoint names).")
def export_command(checkpoint: str, out: str, tables_path: str | None) -> None:
    """Export CHECKPOINT (or a run's latest) as a serving bundle for the Node server (P4B.6)."""
    from rivermind.bots.blueprint import CheckpointError, latest_checkpoint
    from rivermind.bots.blueprint.bundle import BundleError, export_bundle
    from rivermind.bots.cards import TableError

    target = Path(checkpoint)
    if not (target / "manifest.json").exists():
        target = latest_checkpoint(target) or target
    try:
        manifest = export_bundle(target, out, tables=tables_path)
    except (BundleError, CheckpointError, TableError, FileExistsError) as e:
        raise click.ClickException(str(e)) from e
    shown = {
        "out": out,
        "checkpoint": manifest["checkpoint"]["path"],
        "iteration": manifest["checkpoint"]["iteration"],
        "table_set": manifest["cards"]["table_set"],
        "bytes": sum(f["bytes"] for f in manifest["files"].values()),
        "files": manifest["files"],
    }
    click.echo(json.dumps(shown, indent=2))


@blueprint.command("strategy")
@click.argument("checkpoint")
@click.argument("hole")
@click.argument("board", default="")
@click.option("--history", default="", help="Abstract history, such as r0c/kb1c/k.")
@click.option("--depth", default=100, show_default=True, help="Depth class in big blinds.")
@click.option("--tables", "tables_path", default=None, help="Card table set (default: the one the checkpoint names).")
def strategy_command(checkpoint: str, hole: str, board: str, history: str, depth: int, tables_path: str | None) -> None:
    """Print the average and current strategies for HOLE on BOARD at a history."""
    from rivermind.bots.blueprint import Blueprint, CheckpointError, info_set_key, latest_checkpoint
    from rivermind.bots.cards import CardTables, TableError

    target = Path(checkpoint)
    if not (target / "manifest.json").exists():
        target = latest_checkpoint(target) or target
    try:
        bp = Blueprint(target)
        tables = CardTables(tables_path or bp.manifest["cards"]["path"])
        if tables.sha256 != bp.manifest["cards"]["sha256"]:
            raise click.ClickException("those card tables are not the ones the checkpoint was trained with")
        d = bp.game.depth_index(depth)
        node = bp.game.trees[d].node(history)
        street = bp.game.trees[d].street[node]
        board_cards = parse_cards(board) if board else ()
        if len(board_cards) != (0, 3, 4, 5)[street]:
            raise click.ClickException(f"the history {history!r} is on a street with {(0, 3, 4, 5)[street]} board cards")
        bucket = tables.bucket(parse_cards(hole), board_cards)
        shown = {
            "key": info_set_key(bp.game.trees[d], node, bucket),
            "iteration": bp.iteration,
            "average": bp.average(depth, history, bucket),
            "current": bp.current(depth, history, bucket),
        }
    except (CheckpointError, TableError, KeyError, ValueError) as e:
        raise click.ClickException(str(e)) from e
    click.echo(json.dumps(shown, indent=2))


@blueprint.command("evaluate")
@click.argument("checkpoint")
@click.option("--name", required=True, help="Report name: writes OUT/NAME.json and OUT/NAME.md.")
@click.option("--out", default="docs/evaluations", show_default=True)
@click.option("--deals", default=20_000, show_default=True, help="Deals per matchup (each played twice).")
@click.option("--seed", default=0, show_default=True)
@click.option("--workers", default=None, type=int, help="Processes to use (default: every CPU).")
@click.option("--tables", "tables_path", default=None, help="Card table set (default: the one the checkpoint names).")
@click.option(
    "--against",
    multiple=True,
    help="OPPONENT@STACK_BB, such as heuristic@100 or blueprint:<checkpoint>@100; repeatable (default: the P5.4 plan).",
)
def evaluate_command(
    checkpoint: str, name: str, out: str, deals: int, seed: int, workers: int | None, tables_path: str | None, against: tuple[str, ...]
) -> None:
    """Evaluate a blueprint CHECKPOINT (or a run's latest) in duplicate heads-up matches (P5.4)."""
    import os
    import shlex
    import time

    from rivermind.bots.blueprint import latest_checkpoint
    from rivermind.bots.match import DEFAULT_PLAN, evaluate, render_markdown

    target = Path(checkpoint)
    if not (target / "manifest.json").exists():
        found = latest_checkpoint(target)
        if found is None:
            raise click.ClickException(f"{checkpoint} is neither a checkpoint nor a run with one")
        target = found
    plan = []
    for item in against:
        opponent, _, stack = item.rpartition("@")
        if not opponent or not stack.isdigit():
            raise click.ClickException(f"--against takes OPPONENT@STACK_BB, not {item!r}")
        plan.append((opponent, int(stack)))
    started = time.time()

    def progress(r: dict) -> None:  # type: ignore[type-arg]
        lo, hi = r["ci95_bb_per_100"]
        click.echo(f"{r['opponent']} at {r['stack_bb']} bb: {r['bb_per_100']:+.2f} bb/100 ({lo:+.2f} to {hi:+.2f})", err=True)

    try:
        report = evaluate(
            f"blueprint:{target}",
            plan or DEFAULT_PLAN,
            deals=deals,
            seed=seed,
            workers=workers or os.cpu_count() or 1,
            tables=tables_path,
            progress=progress,
        )
    except ValueError as e:
        raise click.ClickException(str(e)) from e
    argv = ["uv", "run", "--locked", "rivermind-poker", "blueprint", "evaluate", str(target), "--name", name]
    argv += ["--out", out, "--deals", str(deals), "--seed", str(seed)]
    if tables_path:
        argv += ["--tables", tables_path]
    for opponent, stack_bb in plan:
        argv += ["--against", f"{opponent}@{stack_bb}"]
    command = shlex.join(argv)
    report["command"] = command
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.json").write_text(json.dumps(report, indent=2) + "\n")
    (out_dir / f"{name}.md").write_text(render_markdown(report, name=name, command=command))
    click.echo(json.dumps({"report": str(out_dir / f"{name}.md"), "seconds": round(time.time() - started, 1)}, indent=2))


@blueprint.command("gate")
@click.argument("report")
@click.option("--incumbent", default=None, help="blueprint:<checkpoint> of the champion a replacement must also beat.")
def gate_command(report: str, incumbent: str | None) -> None:
    """Check an evaluation REPORT (JSON) against the P5.5 promotion gate; exits 1 when it fails."""
    from rivermind.bots.match import gate

    try:
        data = json.loads(Path(report).read_text())
    except (OSError, ValueError) as e:
        raise click.ClickException(f"{report} is not a readable report") from e
    result = gate(data, incumbent)
    click.echo(json.dumps(result, indent=2))
    if not result["passed"]:
        raise SystemExit(1)
