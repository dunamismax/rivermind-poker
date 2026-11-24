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
@click.option("--name", "abstraction", default="hu-m1", show_default=True, help="The card abstraction's name, recorded in the manifest.")
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
    abstraction: str,
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
        abstraction=abstraction,
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
    "abstraction",
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


ABSTRACTION_NAMES = ("hu-m1", "6max-s1")


@click.group()
def blueprint() -> None:
    """Blueprint training, evaluation and promotion for the trained bots (docs/bots.md)."""


@blueprint.command("tree")
@click.option("--abstraction", default="hu-m1", show_default=True, type=click.Choice(ABSTRACTION_NAMES))
def tree_command(abstraction: str) -> None:
    """Print each depth class's compiled tree: nodes, widths and SHA-256."""
    from rivermind.bots.blueprint import compile_tree
    from rivermind.bots.blueprint.abstraction import abstraction_named

    chosen = abstraction_named(abstraction)
    click.echo(json.dumps([compile_tree(d, chosen).summary() for d in chosen.depths], indent=2))


@blueprint.command("train")
@click.argument("run")
@click.option("--tables", "tables_path", default="artifacts/tables/hu-m1", show_default=True, help="Card table set.")
@click.option("--iterations", required=True, type=int, help="Train until this many iterations in all (whole batches).")
@click.option("--workers", default=None, type=int, help="Processes to use (default: every CPU).")
@click.option("--checkpoint_every", default=10_000_000, show_default=True, type=int)
@click.option("--keep", default=2, show_default=True, help="Checkpoints to keep.")
@click.option("--resume", is_flag=True, help="Continue RUN from its latest checkpoint.")
@click.option("--abstraction", default="hu-m1", show_default=True, type=click.Choice(ABSTRACTION_NAMES), help="The format to train; 6max-s1 needs --tables artifacts/tables/c200.")
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


@blueprint.command("nine-train")
@click.argument("out")
@click.option("--bundle", required=True, help="The six-seat champion's serving bundle the nine-seat model plays on, such as artifacts/models/6max-s1-s0-3600m/bundle.")
@click.option("--batches", required=True, type=int, help="Batches of chunks; each batch plays CHUNKS x PER_CHUNK deals from one current strategy.")
@click.option("--chunks", default=16, show_default=True)
@click.option("--per-chunk", "per_chunk", default=125, show_default=True)
@click.option("--seed", default=0, show_default=True)
@click.option("--workers", default=None, type=int, help="Processes to use (default: every CPU); the result does not depend on it.")
def nine_train_command(out: str, bundle: str, batches: int, chunks: int, per_chunk: int, seed: int, workers: int | None) -> None:
    """Train the early-seat table of a nine-seat model on a six-seat bundle, and write a checkpoint to OUT (P5.6, option 1)."""
    import os

    from rivermind.bots.blueprint.nine import train

    if Path(out).exists():
        raise click.ClickException(f"{out} exists")
    every = max(1, batches // 20)

    def log(entry: dict) -> None:  # type: ignore[type-arg]
        if entry["batch"] % every == 0 or entry["batch"] == batches:
            click.echo(json.dumps(entry), err=True)

    path = train(out, bundle, batches=batches, chunks=chunks, per_chunk=per_chunk, seed=seed, workers=workers or os.cpu_count() or 1, log=log)
    click.echo(json.dumps({"checkpoint": str(path), "manifest": json.loads((path / "manifest.json").read_text())["training"]}, indent=2))


@blueprint.command("nine-export")
@click.argument("checkpoint")
@click.option("--out", required=True, help="Bundle directory to create, such as artifacts/bundles/9max-o1-s0.")
def nine_export_command(checkpoint: str, out: str) -> None:
    """Export a nine-seat CHECKPOINT's early table as a serving bundle (P5.6, option 1)."""
    from rivermind.bots.blueprint.nine import export

    if Path(out).exists():
        raise click.ClickException(f"{out} exists")
    try:
        path = export(checkpoint, out)
    except (ValueError, OSError) as e:
        raise click.ClickException(str(e)) from e
    click.echo((path / "manifest.json").read_text())


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
    help="OPPONENT@STACK_BB, such as heuristic@100, blueprint:<checkpoint>@100 or bundle:<directory>@100; repeatable (default: the P5.4 plan).",
)
@click.option(
    "--level",
    type=click.Choice(["medium"]),
    default=None,
    help="Evaluate a difficulty level of the model instead: medium is RiverMind Medium, half its hands as the model and half as RiverMind Easy (P5.7).",
)
@click.option(
    "--seats",
    type=int,
    default=None,
    help="Play a multiway model at a smaller table than its own, of 3 seats or more (P5.7). Such a report is never put to the gate.",
)
def evaluate_command(
    checkpoint: str,
    name: str,
    out: str,
    deals: int,
    seed: int,
    workers: int | None,
    tables_path: str | None,
    against: tuple[str, ...],
    level: str | None,
    seats: int | None,
) -> None:
    """Evaluate a blueprint CHECKPOINT (or a run's latest) in duplicate heads-up matches (P5.4).

    CHECKPOINT may also be a serving bundle, which plays the rounded strategy the site serves (P5.5).
    """
    import os
    import shlex
    import time

    from rivermind.bots.blueprint import latest_checkpoint
    from rivermind.bots.blueprint.bundle import KIND as BUNDLE_KIND
    from rivermind.bots.match import DEFAULT_PLAN, evaluate, render_markdown

    target = Path(checkpoint)
    if not (target / "manifest.json").exists():
        found = latest_checkpoint(target)
        if found is None:
            raise click.ClickException(f"{checkpoint} is neither a checkpoint, a serving bundle nor a run with a checkpoint")
        target = found
    try:
        kind = json.loads((target / "manifest.json").read_text()).get("kind")
    except (OSError, ValueError) as e:
        raise click.ClickException(f"{target} has no readable manifest.json") from e
    from rivermind.bots.blueprint.nine import BUNDLE_KIND as NINE_BUNDLE, CHECKPOINT_KIND as NINE_CHECKPOINT

    if kind in (NINE_BUNDLE, NINE_CHECKPOINT):
        candidate = f"nine:{target}"
    else:
        candidate = f"bundle:{target}" if kind == BUNDLE_KIND else f"blueprint:{target}"
    if level is not None:
        candidate = f"{level}:{candidate}"
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
            candidate,
            plan or DEFAULT_PLAN,
            deals=deals,
            seed=seed,
            workers=workers or os.cpu_count() or 1,
            tables=tables_path,
            progress=progress,
            seats=seats,
        )
    except (ValueError, OSError) as e:
        raise click.ClickException(str(e)) from e
    argv = ["uv", "run", "--locked", "rivermind-poker", "blueprint", "evaluate", str(target), "--name", name]
    argv += ["--out", out, "--deals", str(deals), "--seed", str(seed)]
    if tables_path:
        argv += ["--tables", tables_path]
    for opponent, stack_bb in plan:
        argv += ["--against", f"{opponent}@{stack_bb}"]
    if level is not None:
        argv += ["--level", level]
    if seats is not None:
        argv += ["--seats", str(seats)]
    command = shlex.join(argv)
    report["command"] = command
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.json").write_text(json.dumps(report, indent=2) + "\n")
    (out_dir / f"{name}.md").write_text(render_markdown(report, name=name, command=command))
    click.echo(json.dumps({"report": str(out_dir / f"{name}.md"), "seconds": round(time.time() - started, 1)}, indent=2))


@blueprint.command("gate")
@click.argument("report")
@click.option("--incumbent", default=None, help="blueprint:<checkpoint> (or bundle:<directory>) of the champion a replacement must also beat.")
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


@blueprint.command("promote")
@click.argument("report")
@click.option("--served", default=None, help="The report of the serving bundle exported from the same checkpoint; needed to promote.")
@click.option("--name", default=None, help="The model's name (default: REPORT's file name).")
@click.option("--checkpoint", default=None, help="The evaluated checkpoint (default: the path REPORT names).")
@click.option("--bundle", default=None, help="The evaluated bundle (default: the path the served report names).")
@click.option("--registry", "registry_path", default="docs/models.json", show_default=True)
@click.option("--page", default="docs/models.md", show_default=True)
@click.option("--site", default="web/src/lib/champions.json", show_default=True, help="The extract the site reads; empty to skip it.")
@click.option("--store", default="artifacts/models", show_default=True, help="Where a promoted run's checkpoint and bundle are kept.")
@click.option("--date", default=None, help="The decision's date (default: today).")
@click.option("--note", default=None, help="A sentence recorded with the decision.")
def promote_command(
    report: str,
    served: str | None,
    name: str | None,
    checkpoint: str | None,
    bundle: str | None,
    registry_path: str,
    page: str,
    site: str,
    store: str,
    date: str | None,
    note: str | None,
) -> None:
    """Put the candidate of REPORT (JSON) to the promotion gate and record the decision (P5.5).

    The gate is the one `blueprint gate` applies, against the format's champion
    too when there is one, and it must hold for the checkpoint (REPORT) and for
    the serving bundle exported from it (--served). The decision goes into the
    registry, its page and the site's extract whatever the outcome; a promoted
    run's checkpoint and bundle are also kept under --store. Exits 1 unless the
    run was promoted.
    """
    import time

    from rivermind.bots import registry as reg

    report_path = Path(report)
    try:
        data = reg._read_report(report_path)
        served_data = reg._read_report(Path(served)) if served else None
        checkpoint_path = Path(checkpoint or data["candidate"].get("checkpoint") or data["candidate"].get("model") or "")
        described = reg.describe_checkpoint(checkpoint_path)
        bundle_path = None
        described_bundle = None
        if served_data is not None:
            bundle_path = Path(bundle or served_data["candidate"].get("bundle") or served_data["candidate"].get("model") or "")
            described_bundle = reg.describe_bundle(bundle_path, checkpoint_path)
        registry = reg.load(registry_path)
        decision = reg.decide(
            registry,
            name=name or report_path.stem,
            date=date or time.strftime("%Y-%m-%d"),
            report=data,
            report_path=reg._published(report_path, Path(registry_path)),
            report_sha256=reg._sha256(report_path),
            checkpoint=described,
            served=served_data,
            served_path=reg._published(Path(served), Path(registry_path)) if served else None,
            served_sha256=reg._sha256(Path(served)) if served else None,
            bundle=described_bundle,
            note=note,
        )
        kept = None
        if decision["outcome"] == "promoted":
            assert bundle_path is not None
            kept = reg.keep(decision, checkpoint_path, bundle_path, store)
        reg.write(registry, registry_path, page, site or None)
    except (reg.RegistryError, OSError) as e:
        raise click.ClickException(str(e)) from e
    shown = {
        "name": decision["name"],
        "format": decision["format"],
        "outcome": decision["outcome"],
        "incumbent": decision["incumbent"],
        "evaluations": [{k: e[k] for k in ("candidate", "report", "outcome", "checks")} for e in decision["evaluations"]],
        "kept": str(kept) if kept else None,
        "registry": registry_path,
        "page": page,
    }
    click.echo(json.dumps(shown, indent=2))
    if decision["outcome"] != "promoted":
        raise SystemExit(1)


@blueprint.command("level")
@click.argument("report")
@click.option("--registry", "registry_path", default="docs/models.json", show_default=True)
@click.option("--page", default="docs/models.md", show_default=True)
@click.option("--site", default="web/src/lib/champions.json", show_default=True, help="The extract the site reads; empty to skip it.")
@click.option("--date", default=None, help="The record's date (default: today).")
def level_command(report: str, registry_path: str, page: str, site: str, date: str | None) -> None:
    """Record REPORT (JSON), an evaluation made with --level medium, as RiverMind Medium for its champion (P5.7).

    The report must evaluate the current champion's registered serving bundle
    mixed with RiverMind Easy as the site mixes them, and have played RiverMind
    Easy, the calling station and the champion's bundle itself at 100 big
    blinds. The site offers Medium only for a champion with a recorded level.
    """
    import time

    from rivermind.bots import registry as reg

    report_path = Path(report)
    try:
        data = reg._read_report(report_path)
        registry = reg.load(registry_path)
        entry = reg.record_level(
            registry,
            date=date or time.strftime("%Y-%m-%d"),
            report=data,
            report_path=reg._published(report_path, Path(registry_path)),
            report_sha256=reg._sha256(report_path),
        )
        reg.write(registry, registry_path, page, site or None)
    except (reg.RegistryError, OSError) as e:
        raise click.ClickException(str(e)) from e
    click.echo(json.dumps({**{k: entry[k] for k in ("format", "level", "champion", "share", "report")}, "results": entry["results"]}, indent=2))


@blueprint.command("champions")
@click.option("--registry", "registry_path", default="docs/models.json", show_default=True)
@click.option("--verify", default=None, help="Check the champions' files kept in this directory, such as artifacts/models.")
def champions_command(registry_path: str, verify: str | None) -> None:
    """List each format's champion from the registry; with --verify, check its kept files' hashes. Exits 1 on a mismatch."""
    from rivermind.bots import registry as reg

    try:
        registry = reg.load(registry_path)
    except reg.RegistryError as e:
        raise click.ClickException(str(e)) from e
    shown = []
    bad = False
    for fmt, d in reg.champions(registry).items():
        entry = {
            "format": fmt,
            "name": d["name"],
            "promoted": d["date"],
            "iteration": d["checkpoint"]["iteration"],
            "strategy.npy": d["checkpoint"]["files"].get("strategy.npy"),
            "strategy.u8": d["bundle"]["files"].get("strategy.u8") or d["bundle"]["files"].get("early.u8"),
            "table_set": d["checkpoint"]["cards"]["table_set"],
            "evaluations": [e["report"] for e in d["evaluations"]],
        }
        if verify is not None:
            problems = reg.verify_kept(d, Path(verify) / d["name"])
            entry["kept"] = str(Path(verify) / d["name"])
            entry["problems"] = problems
            bad = bad or bool(problems)
        shown.append(entry)
    click.echo(json.dumps(shown, indent=2))
    if bad:
        raise SystemExit(1)
