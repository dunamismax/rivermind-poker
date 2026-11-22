"""The model registry: which evaluated blueprint is each format's champion (P5.5, ``docs/models.md``).

A **decision** records one run put to the promotion gate, whatever came of
it. The gate is ``match.gate``: the lower bound of the 95% interval must be
above zero against RiverMind Easy and the calling station, and against the
format's champion when there is one. A run is **promoted** when the gate
holds twice, for the checkpoint and for the serving bundle exported from
it, because the bundle's rounded strategy is what the site plays. It
**failed** when some interval lies wholly below zero, and is
**inconclusive** otherwise; either way the format keeps its champion.

A **level** records the evaluation of a champion's difficulty level (P5.7):
RiverMind Medium, the champion's served bundle mixed with RiverMind Easy a
hand at a time (``levels.py``). It is not put to a gate, since it claims
only what its report measured, and it belongs to the champion it was made
from: a new champion has no Medium until its own is evaluated and recorded
(``blueprint level``).

``docs/models.json`` is the registry and ``docs/models.md`` shows it; the
part of the page between the two markers is generated from the JSON. A
promoted run's checkpoint and bundle are also kept under
``artifacts/models/<name>/``, outside the training run, which prunes its
old checkpoints.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np

from .match import GATE_STACK_BB, gate

FORMAT = 1
KIND = "rivermind-model-registry"
REGISTRY = "docs/models.json"
PAGE = "docs/models.md"
SITE = "web/src/lib/champions.json"
"""What the site needs of the registry: each champion, its bundle's hashes and its evaluations' results (P5.7a)."""
SITE_KIND = "rivermind-site-champions"
STORE = "artifacts/models"
START = "<!-- registry:start · generated from models.json by `rivermind-poker blueprint promote`; do not edit by hand -->"
END = "<!-- registry:end -->"

FORMATS = {2: "heads-up", 6: "6-max", 9: "9-max"}
"""A format is a table size; a champion is the best evaluated bot for one."""
OUTCOMES = ("promoted", "inconclusive", "failed")
OPPONENT_NAMES = {"heuristic": "RiverMind Easy", "calling_station": "the calling station"}


class RegistryError(ValueError):
    """The registry, a report or an artifact is missing, damaged or does not match what it is checked against."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            digest.update(block)
    return digest.hexdigest()


def empty() -> dict[str, Any]:
    return {"format": FORMAT, "kind": KIND, "decisions": []}


def load(path: str | Path = REGISTRY) -> dict[str, Any]:
    """The registry at ``path``, or an empty one when the file does not exist yet."""
    path = Path(path)
    if not path.exists():
        return empty()
    try:
        registry: dict[str, Any] = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise RegistryError(f"{path} is not a readable registry") from e
    if registry.get("kind") != KIND or registry.get("format") != FORMAT:
        raise RegistryError(f"{path} is not a format {FORMAT} model registry")
    return registry


def champion(registry: dict[str, Any], fmt: str) -> dict[str, Any] | None:
    """The newest promoted decision for a format."""
    for decision in reversed(registry["decisions"]):
        if decision["format"] == fmt and decision["outcome"] == "promoted":
            return decision
    return None


def champions(registry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    found = {}
    for fmt in FORMATS.values():
        current = champion(registry, fmt)
        if current is not None:
            found[fmt] = current
    return found


def _format_of(report: dict[str, Any]) -> str:
    seats = report.get("game", {}).get("seats")
    if seats not in FORMATS:
        raise RegistryError(f"no format is defined for {seats} seats")
    return FORMATS[seats]


def _incumbent_spec(report: dict[str, Any], incumbent: dict[str, Any]) -> str | None:
    """The report's name for the incumbent: an opponent whose files are the champion's checkpoint or bundle."""
    for spec, described in report.get("opponents", {}).items():
        files = described.get("files")
        if described.get("spec") == "blueprint" and files == incumbent["checkpoint"]["files"]:
            return str(spec)
        if described.get("spec") == "bundle" and incumbent.get("bundle") and files == incumbent["bundle"]["files"]:
            return str(spec)
    return None


def assess(report: dict[str, Any], incumbent: dict[str, Any] | None = None) -> dict[str, Any]:
    """The gate on one report, with the incumbent found by its hashes and named by its registry name."""
    spec = None
    if incumbent is not None:
        spec = _incumbent_spec(report, incumbent)
        if spec is None:
            raise RegistryError(
                f"a replacement must be evaluated against the champion, {incumbent['name']}: "
                f"add --against blueprint:<its checkpoint>@{GATE_STACK_BB} (or bundle:<its bundle>@{GATE_STACK_BB}) and evaluate again"
            )
    result = gate(report, spec)
    missing = [c["opponent"] for c in result["checks"] if c["outcome"] == "missing"]
    if missing:
        raise RegistryError(f"the report has no match against {', '.join(missing)} at {GATE_STACK_BB} big blinds")
    for check in result["checks"]:
        if check["opponent"] == spec and incumbent is not None:
            check["opponent"] = "incumbent"
            check["incumbent"] = incumbent["name"]
    return {"outcome": result["outcome"], "deals": report["deals_per_matchup"], "seed": report["seed"], "checks": result["checks"]}


def _read_report(path: Path) -> dict[str, Any]:
    try:
        report: dict[str, Any] = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise RegistryError(f"{path} is not a readable report") from e
    if report.get("kind") != "rivermind-evaluation":
        raise RegistryError(f"{path} is not an evaluation report")
    return report


def _published(report: Path, registry: Path) -> str:
    """A report's path as the registry and its page link to it: relative to the registry's directory."""
    try:
        return report.resolve().relative_to(registry.resolve().parent).as_posix()
    except ValueError as e:
        raise RegistryError(f"{report} must be published beside the registry, under {registry.parent}/") from e


def describe_checkpoint(checkpoint: Path) -> dict[str, Any]:
    """What the registry records about a checkpoint, after checking every file against its manifest."""
    from .blueprint import CheckpointError, read_manifest
    from .blueprint.bundle import table_set_digest

    try:
        m = read_manifest(checkpoint, verify=True)
    except CheckpointError as e:
        raise RegistryError(str(e)) from e
    return {
        "abstraction": m["abstraction"],
        "iteration": m["iteration"],
        "manifest_sha256": _sha256(checkpoint / "manifest.json"),
        "files": {k: v["sha256"] for k, v in sorted(m["files"].items())},
        "trees": [{"depth": t["depth"], "sha256": t["sha256"]} for t in m["game"]["trees"]],
        "settings": m["settings"],
        "engine": m.get("engine"),
        "trained_by": m.get("software", {}).get("commit"),
        "cards": {
            "seed": m["cards"].get("seed"),
            "table_set": table_set_digest(m["cards"]["sha256"]),
            "sha256": dict(sorted(m["cards"]["sha256"].items())),
        },
    }


def describe_bundle(bundle: Path, checkpoint: Path) -> dict[str, Any]:
    """What the registry records about a serving bundle, after checking it is ``checkpoint``'s export.

    Every file is checked against the bundle's manifest, the manifest against
    the checkpoint's hashes, and the served strategy against a fresh rounding
    of the checkpoint's.
    """
    from .blueprint import CheckpointError, read_manifest
    from .blueprint.bundle import BundleError, ServingBundle, quantize

    try:
        served = ServingBundle(bundle, verify=True)
        manifest = read_manifest(checkpoint)
    except (BundleError, CheckpointError) as e:
        raise RegistryError(str(e)) from e
    source = served.manifest["checkpoint"]
    if source.get("manifest_sha256") != _sha256(checkpoint / "manifest.json") or source.get("strategy_sha256") != manifest["files"]["strategy.npy"]["sha256"]:
        raise RegistryError(f"{bundle} was not exported from {checkpoint}")
    if served.manifest["cards"]["sha256"] != manifest["cards"]["sha256"]:
        raise RegistryError(f"{bundle} carries other card tables than {checkpoint} was trained with")
    sums = np.load(checkpoint / "strategy.npy", mmap_mode="r")
    if sums.shape != (served.game.size,) or not np.array_equal(np.asarray(served.strategy), quantize(served.game, sums)):
        raise RegistryError(f"{bundle}'s strategy is not the rounding of {checkpoint}'s")
    return {
        "levels": served.manifest["strategy"]["levels"],
        "table_set": served.manifest["cards"]["table_set"],
        "files": {k: v["sha256"] for k, v in sorted(served.manifest["files"].items())},
    }


def decide(
    registry: dict[str, Any],
    *,
    name: str,
    date: str,
    report: dict[str, Any],
    report_path: str,
    report_sha256: str,
    checkpoint: dict[str, Any],
    served: dict[str, Any] | None = None,
    served_path: str | None = None,
    served_sha256: str | None = None,
    bundle: dict[str, Any] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """The decision on one candidate, appended to ``registry``. Raises when the inputs do not belong together."""
    fmt = _format_of(report)
    c = report["candidate"]
    if c.get("spec") != "blueprint" or c.get("files") != checkpoint["files"]:
        raise RegistryError("the report did not evaluate this checkpoint")
    incumbent = champion(registry, fmt)
    if incumbent is not None and incumbent["checkpoint"]["files"] == checkpoint["files"]:
        raise RegistryError(f"this checkpoint is already the {fmt} champion, {incumbent['name']}")
    if any(e["sha256"] == report_sha256 for d in registry["decisions"] for e in d["evaluations"]):
        raise RegistryError("this report has already been recorded")
    evaluations = [{"candidate": "checkpoint", "report": report_path, "sha256": report_sha256, **assess(report, incumbent)}]
    if served is not None:
        if bundle is None or served_path is None or served_sha256 is None:
            raise RegistryError("a served report needs its bundle")
        s = served["candidate"]
        if _format_of(served) != fmt or s.get("spec") != "bundle" or s.get("files") != bundle["files"]:
            raise RegistryError("the served report did not evaluate this bundle")
        evaluations.append({"candidate": "bundle", "report": served_path, "sha256": served_sha256, **assess(served, incumbent)})
    outcomes = [e["outcome"] for e in evaluations]
    if "failed" in outcomes:
        outcome = "failed"
    elif "inconclusive" in outcomes:
        outcome = "inconclusive"
    elif served is None:
        raise RegistryError(
            "the checkpoint passes the gate; promotion also needs the gate on what the site serves: "
            "export a bundle (blueprint export), evaluate it (blueprint evaluate <bundle>) and pass its report as --served"
        )
    else:
        outcome = "promoted"
    decision = {
        "date": date,
        "format": fmt,
        "name": name,
        "outcome": outcome,
        "incumbent": incumbent["name"] if incumbent else None,
        "checkpoint": checkpoint,
        "bundle": bundle,
        "evaluations": evaluations,
        "note": note,
    }
    registry["decisions"].append(decision)
    return decision


LEVEL_OPPONENTS = ("heuristic", "calling_station", "hard")
"""What a level's report must have played at the gate's stacks: the two gate bots and its own champion."""


def levels(registry: dict[str, Any]) -> list[dict[str, Any]]:
    return list(registry.get("levels", []))


def level_of(registry: dict[str, Any], name: str, level: str = "medium") -> dict[str, Any] | None:
    """The newest recorded ``level`` of the model named ``name``."""
    for entry in reversed(levels(registry)):
        if entry["champion"] == name and entry["level"] == level:
            return entry
    return None


def _hard_spec(report: dict[str, Any], champion_decision: dict[str, Any]) -> str | None:
    """The report's name for the champion's own served bundle, the level's RiverMind Hard."""
    for spec, described in report.get("opponents", {}).items():
        if described.get("spec") == "bundle" and described.get("files") == champion_decision["bundle"]["files"]:
            return str(spec)
    return None


def record_level(
    registry: dict[str, Any],
    *,
    date: str,
    report: dict[str, Any],
    report_path: str,
    report_sha256: str,
) -> dict[str, Any]:
    """Record a Medium evaluation for the champion it was made from, appended to ``registry``. Raises when it does not belong."""
    from .levels import MEDIUM, MEDIUM_SHARE

    fmt = _format_of(report)
    c = report["candidate"]
    if c.get("spec") != MEDIUM:
        raise RegistryError("the report did not evaluate a difficulty level: evaluate with --level medium")
    current = champion(registry, fmt)
    if current is None:
        raise RegistryError(f"the {fmt} format has no champion to make a level of")
    strong = c.get("strong", {})
    if strong.get("spec") != "bundle" or strong.get("files") != current["bundle"]["files"]:
        raise RegistryError(f"the report's Medium is not made from the {fmt} champion's served bundle, {current['name']}")
    if c.get("share") != MEDIUM_SHARE or c.get("weak", {}).get("spec") != "heuristic":
        raise RegistryError(f"the report's Medium is not the site's: half its hands ({MEDIUM_SHARE}) as the champion and the rest as RiverMind Easy")
    if any(e["sha256"] == report_sha256 for e in levels(registry)):
        raise RegistryError("this report has already been recorded")
    hard = _hard_spec(report, current)
    have = {(r["opponent"], r["stack_bb"]) for r in report["results"]}
    wanted = {"heuristic": "heuristic", "calling_station": "calling_station", "hard": hard}
    missing = [k for k, spec in wanted.items() if spec is None or (spec, GATE_STACK_BB) not in have]
    if missing:
        names = {"heuristic": "RiverMind Easy", "calling_station": "the calling station", "hard": f"bundle:<{current['name']}'s bundle>"}
        raise RegistryError(f"the report has no match at {GATE_STACK_BB} big blinds against {', '.join(names[m] for m in missing)}")
    results = []
    for key in LEVEL_OPPONENTS:
        r = next(r for r in report["results"] if r["opponent"] == wanted[key] and r["stack_bb"] == GATE_STACK_BB)
        results.append({"opponent": key, "stack_bb": GATE_STACK_BB, "bb_per_100": r["bb_per_100"], "ci95_bb_per_100": r["ci95_bb_per_100"]})
    entry = {
        "date": date,
        "format": fmt,
        "level": MEDIUM,
        "champion": current["name"],
        "share": MEDIUM_SHARE,
        "report": report_path,
        "sha256": report_sha256,
        "deals": report["deals_per_matchup"],
        "seed": report["seed"],
        "results": results,
    }
    registry.setdefault("levels", []).append(entry)
    return entry


def dumps(registry: dict[str, Any]) -> str:
    return json.dumps(registry, indent=2) + "\n"


# The page


def _bb(value: float) -> str:
    return f"{value:+.2f}"


def _opponent(check: dict[str, Any]) -> str:
    if check["opponent"] == "incumbent":
        return f"`{check['incumbent']}`, the champion at the time"
    return OPPONENT_NAMES.get(check["opponent"], check["opponent"])


def _checks(evaluation: dict[str, Any]) -> str:
    parts = []
    for check in evaluation["checks"]:
        lo, hi = check["ci95_bb_per_100"]
        parts.append(f"{_bb(check['bb_per_100'])} ({_bb(lo)} to {_bb(hi)}) against {_opponent(check)}")
    return "; ".join(parts)


LEVEL_OPPONENT_NAMES = {**OPPONENT_NAMES, "hard": "RiverMind Hard, the champion itself"}


def _level_results(entry: dict[str, Any]) -> str:
    parts = []
    for r in entry["results"]:
        lo, hi = r["ci95_bb_per_100"]
        parts.append(f"{_bb(r['bb_per_100'])} ({_bb(lo)} to {_bb(hi)}) against {LEVEL_OPPONENT_NAMES[r['opponent']]}")
    return "; ".join(parts) + f" at {GATE_STACK_BB} big blinds"


def _link(evaluation: dict[str, Any], text: str) -> str:
    return f"[{text}]({evaluation['report'].removesuffix('.json')}.md)"


def _what(evaluation: dict[str, Any]) -> str:
    return "the checkpoint" if evaluation["candidate"] == "checkpoint" else "the served bundle"


def _settings(settings: dict[str, Any]) -> str:
    parts = []
    for key, value in settings.items():
        if isinstance(value, bool) or not isinstance(value, int):
            shown = json.dumps(value) if isinstance(value, (list, dict)) else str(value)
        else:
            shown = f"{value:,}"
        parts.append(f"`{key}` {shown}")
    return ", ".join(parts)


def render(registry: dict[str, Any]) -> str:
    """The generated part of ``docs/models.md``, without its markers."""
    lines = ["## Champions", ""]
    current = champions(registry)
    if not current:
        lines += ["No champion has been promoted yet.", ""]
    else:
        lines += [
            "| Format | Champion | Abstraction | Training iterations | Promoted | Evaluations |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for fmt, d in current.items():
            links = ", ".join(_link(e, _what(e).removeprefix("the ")) for e in d["evaluations"])
            c = d["checkpoint"]
            lines.append(f"| {fmt.capitalize()} | `{d['name']}` | `{c['abstraction']}` | {c['iteration']:,} | {d['date']} | {links} |")
        lines.append("")
        for fmt, d in current.items():
            c, b = d["checkpoint"], d["bundle"]
            replaced = f"replacing `{d['incumbent']}`" if d["incumbent"] else f"as the first {fmt} champion"
            lines += [f"### {fmt.capitalize()}: `{d['name']}`", "", f"Promoted on {d['date']}, {replaced}." + (f" {d['note']}" if d.get("note") else ""), ""]
            for e in d["evaluations"]:
                lines.append(
                    f"- **Gate, {_what(e)}:** {_checks(e)}, in big blinds per 100 hands with 95% intervals,"
                    f" over {e['deals']:,} duplicate deals each at {GATE_STACK_BB} big blinds, seed {e['seed']} ({_link(e, 'report')})."
                )
            lines.append(
                f"- **Checkpoint:** {c['iteration']:,} iterations of `{c['abstraction']}`"
                + (f", written at commit `{c['trained_by'][:7]}`" if c.get("trained_by") else "")
                + f". `manifest.json` `{c['manifest_sha256']}`, "
                + ", ".join(f"`{k}` `{v}`" for k, v in c["files"].items())
                + "."
            )
            lines.append("- **Trees:** " + ", ".join(f"{t['depth']} big blinds `{t['sha256']}`" for t in c["trees"]) + ".")
            buckets = ", ".join(f"`{k}` `{c['cards']['sha256'][k]}`" for k in ("preflop.npy", "flop.npy", "turn.npy", "river.npy") if k in c["cards"]["sha256"])
            lines.append(
                f"- **Card tables:** seed {c['cards']['seed']}, table set `{c['cards']['table_set']}` (one SHA-256 over its files’ hashes)."
                f" Bucket files: {buckets}. `models.json` has all {len(c['cards']['sha256'])} files."
            )
            lines.append(f"- **Training settings:** {_settings(c['settings'])}.")
            lines.append(
                f"- **Serving bundle:** `strategy.u8` `{b['files']['strategy.u8']}`, probabilities in multiples of 1/{b['levels']}."
                f" `models.json` has all {len(b['files'])} files."
            )
            lines.append(f"- **Kept in:** `{STORE}/{d['name']}/` (`checkpoint/` and `bundle/`).")
            medium = level_of(registry, d["name"])
            if medium is not None:
                lines.append(
                    f"- **RiverMind Medium:** each hand played as this served bundle with probability {medium['share']:g} and as RiverMind Easy otherwise;"
                    f" {_level_results(medium)}, over {medium['deals']:,} duplicate deals each, seed {medium['seed']} ({_link(medium, 'report')}; recorded {medium['date']})."
                )
            lines.append("")
    lines += ["## Decisions", ""]
    if not registry["decisions"]:
        lines += ["No run has been put to the gate yet.", ""]
        return "\n".join(lines)
    lines += [
        "Every run put to the gate, newest first. Results are big blinds per 100 hands with 95% intervals.",
        "",
        "| Date | Format | Candidate | Outcome | Checkpoint | Served bundle |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for d in reversed(registry["decisions"]):
        cells = {e["candidate"]: f"{_checks(e)} ({_link(e, 'report')})" for e in d["evaluations"]}
        outcome = d["outcome"].capitalize() + (f", replacing `{d['incumbent']}`" if d["outcome"] == "promoted" and d["incumbent"] else "")
        candidate = f"`{d['name']}`, {d['checkpoint']['iteration']:,} iterations"
        lines.append(f"| {d['date']} | {d['format'].capitalize()} | {candidate} | {outcome} | {cells.get('checkpoint', '—')} | {cells.get('bundle', 'not evaluated')} |")
    lines.append("")
    notes = [d for d in reversed(registry["decisions"]) if d.get("note") and d["outcome"] != "promoted"]
    for d in notes:
        lines += [f"- `{d['name']}` ({d['date']}, {d['outcome']}): {d['note']}"]
    if notes:
        lines.append("")
    return "\n".join(lines)


def page_text(page: str, registry: dict[str, Any]) -> str:
    """``page`` with the part between the markers replaced by the registry's rendering."""
    if START not in page or END not in page or page.index(START) > page.index(END):
        raise RegistryError("the page has no registry markers to write between")
    head, rest = page.split(START, 1)
    tail = rest.split(END, 1)[1]
    return f"{head}{START}\n\n{render(registry)}\n{END}{tail}"


def _model_name(registry: dict[str, Any], described: dict[str, Any]) -> str | None:
    """The registry's name for a blueprint or bundle a report describes, found by its files."""
    for decision in registry["decisions"]:
        bundle = decision.get("bundle") or {}
        if described.get("files") in (decision["checkpoint"]["files"], bundle.get("files")):
            return str(decision["name"])
    return None


def site_data(registry: dict[str, Any], docs: str | Path) -> dict[str, Any]:
    """The champions as the site reads them (``web/src/lib/champions.json``, P5.7a).

    For each format's champion: what the Node server checks a bundle against
    before it serves it (every file's SHA-256 and the card table set), and
    every result of its evaluations, the served bundle's first, for the page
    that a bot's label links to (D-7). ``docs`` is the registry's directory,
    where its reports are.
    """
    docs = Path(docs)
    seats = {fmt: n for n, fmt in FORMATS.items()}
    found = []
    for fmt, d in champions(registry).items():
        evaluations = []
        for e in sorted(d["evaluations"], key=lambda e: e["candidate"] != "bundle"):
            report = _read_report(docs / e["report"])
            gate_opponents = {(c["opponent"], c["stack_bb"]) for c in e["checks"]}
            rows = []
            for r in report["results"]:
                described = report["opponents"][r["opponent"]]
                model = described["spec"] in ("blueprint", "bundle")
                name = _model_name(registry, described) if model else None
                opponent = "champion" if model else r["opponent"]
                gated = ("incumbent" if name == d["incumbent"] and model else r["opponent"], r["stack_bb"]) in gate_opponents
                rows.append(
                    {
                        "opponent": opponent,
                        "name": name,
                        "stack_bb": r["stack_bb"],
                        "hands": r["hands"],
                        "bb_per_100": r["bb_per_100"],
                        "ci95": r["ci95_bb_per_100"],
                        "gate": gated,
                    }
                )
            evaluations.append(
                {
                    "candidate": e["candidate"],
                    "report": e["report"].removesuffix(".json"),
                    "deals": report["deals_per_matchup"],
                    "seed": report["seed"],
                    "blinds": report["game"]["blinds"],
                    "evaluated_at": report["software"]["commit"],
                    "results": rows,
                }
            )
        c, b = d["checkpoint"], d["bundle"]
        site_levels: dict[str, Any] = {}
        medium = level_of(registry, d["name"])
        if medium is not None:
            report = _read_report(docs / medium["report"])
            hard = _hard_spec(report, d)
            rows = []
            for r in report["results"]:
                described = report["opponents"][r["opponent"]]
                model = described["spec"] in ("blueprint", "bundle")
                name = _model_name(registry, described) if model else None
                rows.append(
                    {
                        "opponent": "hard" if r["opponent"] == hard else "champion" if model else r["opponent"],
                        "name": name,
                        "stack_bb": r["stack_bb"],
                        "hands": r["hands"],
                        "bb_per_100": r["bb_per_100"],
                        "ci95": r["ci95_bb_per_100"],
                        "gate": False,
                    }
                )
            site_levels["medium"] = {
                "share": medium["share"],
                "recorded": medium["date"],
                "evaluation": {
                    "candidate": "medium",
                    "report": medium["report"].removesuffix(".json"),
                    "deals": report["deals_per_matchup"],
                    "seed": report["seed"],
                    "blinds": report["game"]["blinds"],
                    "evaluated_at": report["software"]["commit"],
                    "results": rows,
                },
            }
        found.append(
            {
                "format": fmt,
                "seats": seats[fmt],
                "name": d["name"],
                "abstraction": c["abstraction"],
                "iterations": c["iteration"],
                "promoted": d["date"],
                "replaced": d["incumbent"],
                "checkpoint": {"manifest_sha256": c["manifest_sha256"], "files": c["files"]},
                "bundle": {"levels": b["levels"], "table_set": b["table_set"], "files": b["files"]},
                "evaluations": evaluations,
                **({"levels": site_levels} if site_levels else {}),
            }
        )
    return {"format": FORMAT, "kind": SITE_KIND, "champions": found}


def write(
    registry: dict[str, Any],
    registry_path: str | Path = REGISTRY,
    page_path: str | Path = PAGE,
    site_path: str | Path | None = None,
) -> None:
    """Write the registry, its page and, given ``site_path``, the site's extract, each through a temporary file."""
    registry_path, page_path = Path(registry_path), Path(page_path)
    page = page_path.read_text() if page_path.exists() else f"# Models\n\n{START}\n{END}\n"
    texts = [(page_path, page_text(page, registry)), (registry_path, dumps(registry))]
    if site_path is not None:
        texts.append((Path(site_path), dumps(site_data(registry, registry_path.parent))))
    for path, text in texts:
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".partial")
        partial.write_text(text)
        os.replace(partial, path)


# Keeping a champion's files


def _keep(source: Path, target: Path) -> None:
    """Hard-link ``source``'s files into ``target``, or copy them where a link is not possible.

    Checkpoint and bundle files are written once and never changed, so a link
    keeps them at no cost in space when the run later prunes its checkpoint.
    """
    partial = target.with_name(target.name + ".partial")
    if partial.exists():
        shutil.rmtree(partial)
    partial.mkdir(parents=True)
    for path in sorted(source.iterdir()):
        if not path.is_file():
            continue
        try:
            os.link(path, partial / path.name)
        except OSError:
            shutil.copy2(path, partial / path.name)
    os.replace(partial, target)


def keep(decision: dict[str, Any], checkpoint: Path, bundle: Path, store: str | Path = STORE) -> Path:
    """Keep a promoted run's checkpoint and bundle under ``store/<name>/``; returns that directory."""
    home = Path(store) / decision["name"]
    for source, name in ((checkpoint, "checkpoint"), (bundle, "bundle")):
        target = home / name
        if not target.exists():
            _keep(source, target)
    problems = verify_kept(decision, home)
    if problems:
        raise RegistryError(f"{home} does not hold what was promoted: {'; '.join(problems)}")
    return home


def verify_kept(decision: dict[str, Any], home: str | Path) -> list[str]:
    """What is wrong with the files kept for a promoted decision in ``home``; empty when every hash matches."""
    home = Path(home)
    problems = []
    wanted: Sequence[tuple[str, dict[str, str]]] = (
        ("checkpoint", {"manifest.json": decision["checkpoint"]["manifest_sha256"], **decision["checkpoint"]["files"]}),
        ("bundle", dict(decision["bundle"]["files"])),
    )
    for part, files in wanted:
        directory = home / part
        if not directory.is_dir():
            problems.append(f"{directory} is missing")
            continue
        for name, expected in files.items():
            path = directory / name
            if not path.is_file():
                problems.append(f"{path} is missing")
            elif _sha256(path) != expected:
                problems.append(f"{path} differs from the registry")
        if part == "bundle" and not (directory / "manifest.json").is_file():
            problems.append(f"{directory / 'manifest.json'} is missing")
    return problems


__all__ = [
    "END",
    "FORMATS",
    "PAGE",
    "REGISTRY",
    "SITE",
    "START",
    "STORE",
    "RegistryError",
    "assess",
    "champion",
    "champions",
    "decide",
    "describe_bundle",
    "describe_checkpoint",
    "dumps",
    "keep",
    "level_of",
    "levels",
    "load",
    "page_text",
    "record_level",
    "render",
    "site_data",
    "verify_kept",
    "write",
]
