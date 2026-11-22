"""The promotion gate and the model registry (P5.5, ``docs/models.md``).

The candidates are small fake checkpoints and the bundles exported from
them, as in ``test_bundle``. Reports are written by hand around the real
description of each candidate, so the results can be whatever a case needs.
The last tests check the published registry against its page and reports.
"""

from __future__ import annotations

import functools
import json
from pathlib import Path
from test.engine.test_bundle import fake_checkpoint, fake_tables
from typing import Any

import pytest
from click.testing import CliRunner

from poker_ai.cli.runner import cli
from rivermind.bots import registry as reg
from rivermind.bots.match import describe_policy, gate

ROOT = Path(__file__).resolve().parents[2]
GOOD = {"heuristic": (10.0, 30.0), "calling_station": (50.0, 90.0)}


class Candidate:
    def __init__(self, root: Path, name: str, seed: int, tables: Any) -> None:
        self.name = name
        self.checkpoint = root / name / "checkpoint"
        self.bundle = root / name / "bundle"
        fake_checkpoint(self.checkpoint, tables, seed=seed)
        result = CliRunner().invoke(cli, ["blueprint", "export", str(self.checkpoint), "--out", str(self.bundle)])
        assert result.exit_code == 0, result.output


@pytest.fixture(scope="module", autouse=True)
def compiled_once() -> Any:
    """Compile each tree once for this module: every promotion reads a checkpoint and a bundle, and each compiles both."""
    from rivermind.bots.blueprint import blueprint, bundle, tree

    cached = functools.cache(tree.compile_tree)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(blueprint, "compile_tree", cached)
        patch.setattr(bundle, "compile_tree", cached)
        yield


@pytest.fixture(scope="module")
def candidates(tmp_path_factory: pytest.TempPathFactory) -> tuple[Candidate, Candidate]:
    root = tmp_path_factory.mktemp("registry")
    tables = fake_tables(root / "tables")
    return Candidate(root, "first", 0, tables), Candidate(root, "second", 1, tables)


class Site:
    """A registry, its page, its reports and its store in a temporary directory."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.registry = root / "docs" / "models.json"
        self.page = root / "docs" / "models.md"
        self.site = root / "web" / "champions.json"
        self.store = root / "models"
        self.reports = root / "docs" / "evaluations"
        self.reports.mkdir(parents=True)
        self.count = 0

    def report(self, candidate: str, results: dict[str, tuple[float, float]], *, seats: int = 2) -> Path:
        """Write a report for ``candidate`` (a policy spec) with a 95% interval for each opponent at 100 big blinds."""
        rows = [
            {"opponent": o, "stack_bb": 100, "hands": 2000, "bb_per_100": round((lo + hi) / 2, 2), "ci95_bb_per_100": [lo, hi]}
            for o, (lo, hi) in results.items()
        ]
        self.count += 1
        report = {
            "format": 1,
            "kind": "rivermind-evaluation",
            "game": {"seats": seats, "blinds": [50, 100]},
            "software": {"commit": "0" * 40, "dirty": False},
            "seed": self.count,
            "deals_per_matchup": 1_000,
            "candidate": describe_policy(candidate),
            "opponents": {o: describe_policy(o) for o in results},
            "results": rows,
        }
        path = self.reports / f"report-{self.count}.json"
        path.write_text(json.dumps(report, indent=2) + "\n")
        return path

    def promote(self, report: Path, *args: str) -> Any:
        base = ["blueprint", "promote", str(report), "--registry", str(self.registry), "--page", str(self.page), "--store", str(self.store)]
        base += ["--site", str(self.site)]
        return CliRunner().invoke(cli, [*base, "--date", "2026-11-21", *args])

    def promote_both(self, c: Candidate, results: dict[str, tuple[float, float]], served: dict[str, tuple[float, float]] | None = None) -> Any:
        report = self.report(f"blueprint:{c.checkpoint}", results)
        served_report = self.report(f"bundle:{c.bundle}", served or results)
        return self.promote(report, "--served", str(served_report), "--name", c.name)

    def decisions(self) -> list[dict[str, Any]]:
        return list(reg.load(self.registry)["decisions"])

    def champion(self) -> str | None:
        found = reg.champion(reg.load(self.registry), "heads-up")
        return found["name"] if found else None


@pytest.fixture
def site(tmp_path: Path) -> Site:
    return Site(tmp_path)


def test_the_gate_tells_a_failed_run_from_an_inconclusive_one() -> None:
    def report(**bounds: tuple[float, float]) -> dict[str, Any]:
        return {"results": [{"opponent": o, "stack_bb": 100, "bb_per_100": (lo + hi) / 2, "ci95_bb_per_100": [lo, hi]} for o, (lo, hi) in bounds.items()]}

    assert gate(report(heuristic=(1, 9), calling_station=(2, 8)))["outcome"] == "passed"
    assert gate(report(heuristic=(-1, 9), calling_station=(2, 8)))["outcome"] == "inconclusive"
    assert gate(report(heuristic=(0, 9), calling_station=(2, 8)))["outcome"] == "inconclusive"  # the bound must be above zero
    assert gate(report(heuristic=(-1, 9), calling_station=(-8, -2)))["outcome"] == "failed"
    missing = gate(report(heuristic=(1, 9)))
    assert missing["outcome"] == "missing" and not missing["passed"]


def test_a_first_champion_needs_the_gate_on_the_checkpoint_and_on_its_bundle(site: Site, candidates: tuple[Candidate, Candidate]) -> None:
    first, _ = candidates
    report = site.report(f"blueprint:{first.checkpoint}", GOOD)
    alone = site.promote(report, "--name", "first")
    assert alone.exit_code == 1 and "--served" in alone.output
    assert not site.registry.exists() and not site.page.exists()

    served = site.report(f"bundle:{first.bundle}", GOOD)
    result = site.promote(report, "--served", str(served), "--name", "first")
    assert result.exit_code == 0, result.output
    shown = json.loads(result.output)
    assert shown["outcome"] == "promoted" and shown["incumbent"] is None and shown["kept"] == str(site.store / "first")

    (decision,) = site.decisions()
    manifest = json.loads((first.checkpoint / "manifest.json").read_text())
    assert decision["format"] == "heads-up" and decision["name"] == "first" and decision["date"] == "2026-11-21"
    assert decision["checkpoint"]["files"] == {k: v["sha256"] for k, v in manifest["files"].items()}
    assert decision["checkpoint"]["settings"] == manifest["settings"] and decision["checkpoint"]["iteration"] == 1000
    assert decision["checkpoint"]["cards"]["sha256"] == manifest["cards"]["sha256"]
    assert decision["checkpoint"]["cards"]["table_set"] == decision["bundle"]["table_set"]
    assert [e["candidate"] for e in decision["evaluations"]] == ["checkpoint", "bundle"]
    assert [e["report"] for e in decision["evaluations"]] == ["evaluations/report-1.json", "evaluations/report-2.json"]
    assert all(e["outcome"] == "passed" for e in decision["evaluations"])

    page = site.page.read_text()
    assert "### Heads-up: `first`" in page and "as the first heads-up champion" in page
    for value in (*decision["checkpoint"]["files"].values(), decision["checkpoint"]["manifest_sha256"], decision["bundle"]["files"]["strategy.u8"]):
        assert value in page
    assert "(evaluations/report-1.md)" in page and "(evaluations/report-2.md)" in page
    assert reg.page_text(page, reg.load(site.registry)) == page

    # The kept files are the promoted ones, and survive the run pruning its checkpoint.
    kept = site.store / "first"
    assert reg.verify_kept(decision, kept) == []
    assert (kept / "checkpoint" / "strategy.npy").read_bytes() == (first.checkpoint / "strategy.npy").read_bytes()
    listed = CliRunner().invoke(cli, ["blueprint", "champions", "--registry", str(site.registry), "--verify", str(site.store)])
    assert listed.exit_code == 0 and json.loads(listed.output)[0]["problems"] == []
    strategy = kept / "bundle" / "strategy.u8"
    data = bytearray(strategy.read_bytes())
    data[0] ^= 1
    strategy.unlink()  # a hard link: replace the file, do not write through to the original
    strategy.write_bytes(bytes(data))
    listed = CliRunner().invoke(cli, ["blueprint", "champions", "--registry", str(site.registry), "--verify", str(site.store)])
    assert listed.exit_code == 1 and "differs from the registry" in listed.output


def test_runs_that_miss_the_gate_are_recorded_and_leave_the_format_open(site: Site, candidates: tuple[Candidate, Candidate]) -> None:
    first, second = candidates
    inconclusive = site.promote(site.report(f"blueprint:{first.checkpoint}", {**GOOD, "heuristic": (-4.0, 16.0)}), "--name", "first", "--note", "Too few deals.")
    assert inconclusive.exit_code == 1 and json.loads(inconclusive.output)["outcome"] == "inconclusive"
    failed = site.promote(site.report(f"blueprint:{second.checkpoint}", {**GOOD, "calling_station": (-30.0, -2.0)}), "--name", "second")
    assert failed.exit_code == 1 and json.loads(failed.output)["outcome"] == "failed"
    # The checkpoint passes and its served rounding does not.
    rounded = site.promote_both(second, GOOD, {**GOOD, "heuristic": (-1.0, 19.0)})
    assert rounded.exit_code == 1 and json.loads(rounded.output)["outcome"] == "inconclusive"

    assert [(d["name"], d["outcome"]) for d in site.decisions()] == [("first", "inconclusive"), ("second", "failed"), ("second", "inconclusive")]
    assert site.champion() is None and not site.store.exists()
    page = site.page.read_text()
    assert "No champion has been promoted yet." in page
    assert "| `first`, 1,000 iterations | Inconclusive |" in page and "| `second`, 1,000 iterations | Failed |" in page
    assert "- `first` (2026-11-21, inconclusive): Too few deals." in page
    # A later run of the same candidate can still be promoted.
    assert site.promote_both(first, GOOD).exit_code == 0 and site.champion() == "first"


def test_a_replacement_must_also_beat_the_champion(site: Site, candidates: tuple[Candidate, Candidate]) -> None:
    first, second = candidates
    assert site.promote_both(first, GOOD).exit_code == 0

    unplayed = site.promote_both(second, GOOD)
    assert unplayed.exit_code == 1 and "against the champion, first" in unplayed.output
    assert len(site.decisions()) == 1

    old_checkpoint, old_bundle = f"blueprint:{first.checkpoint}", f"bundle:{first.bundle}"
    close = site.promote_both(second, {**GOOD, old_checkpoint: (-2.0, 12.0)})
    assert close.exit_code == 1 and json.loads(close.output)["outcome"] == "inconclusive"
    worse = site.promote_both(second, {**GOOD, old_checkpoint: (-12.0, -2.0)})
    assert worse.exit_code == 1 and json.loads(worse.output)["outcome"] == "failed"
    assert site.champion() == "first"

    # The champion may be met as its checkpoint or as its bundle.
    better = site.promote_both(second, {**GOOD, old_checkpoint: (2.0, 12.0)}, {**GOOD, old_bundle: (1.0, 11.0)})
    assert better.exit_code == 0, better.output
    assert site.champion() == "second"
    decision = site.decisions()[-1]
    assert decision["incumbent"] == "first"
    assert [c["opponent"] for c in decision["evaluations"][0]["checks"]] == ["heuristic", "calling_station", "incumbent"]
    assert decision["evaluations"][1]["checks"][2]["incumbent"] == "first"
    page = site.page.read_text()
    assert "### Heads-up: `second`" in page and "replacing `first`" in page and "### Heads-up: `first`" not in page
    assert "against `first`, the champion at the time" in page
    assert reg.verify_kept(decision, site.store / "second") == [] and (site.store / "first").is_dir()

    # The site's extract: the champion alone, its bundle's hashes, and the served results first.
    extract = json.loads(site.site.read_text())
    assert extract["kind"] == "rivermind-site-champions"
    (model,) = extract["champions"]
    assert (model["format"], model["seats"], model["name"], model["replaced"]) == ("heads-up", 2, "second", "first")
    assert model["bundle"]["files"] == decision["bundle"]["files"] and model["bundle"]["table_set"] == decision["bundle"]["table_set"]
    assert [e["candidate"] for e in model["evaluations"]] == ["bundle", "checkpoint"]
    served = model["evaluations"][0]
    assert served["report"] == "evaluations/report-10" and served["deals"] == 1000
    assert [(r["opponent"], r["name"], r["gate"]) for r in served["results"]] == [
        ("heuristic", None, True),
        ("calling_station", None, True),
        ("champion", "first", True),
    ]
    assert served["results"][2]["ci95"] == [1.0, 11.0] and served["results"][0]["hands"] == 2000


def test_it_refuses_inputs_that_do_not_belong_together(site: Site, candidates: tuple[Candidate, Candidate], tmp_path: Path) -> None:
    first, second = candidates
    report = site.report(f"blueprint:{first.checkpoint}", GOOD)
    served = site.report(f"bundle:{first.bundle}", GOOD)

    def refused(*args: str) -> str:
        result = site.promote(*args)  # type: ignore[arg-type]
        assert result.exit_code == 1 and result.output.startswith("Error:"), result.output
        return str(result.output)

    assert "did not evaluate this checkpoint" in refused(report, "--checkpoint", str(second.checkpoint))
    assert "was not exported from" in refused(report, "--served", str(served), "--bundle", str(second.bundle))
    other_served = site.report(f"bundle:{second.bundle}", GOOD)
    assert "was not exported from" in refused(report, "--served", str(other_served))
    assert "has no match against calling_station" in refused(site.report(f"blueprint:{first.checkpoint}", {"heuristic": (1.0, 2.0)}))
    assert "no format is defined for 4 seats" in refused(site.report(f"blueprint:{first.checkpoint}", GOOD, seats=4))
    outside = tmp_path / "elsewhere.json"
    outside.write_text(report.read_text())
    assert "must be published beside the registry" in refused(outside, "--served", str(served))

    # A checkpoint whose file changed since its manifest was written.
    import shutil

    damaged = tmp_path / "damaged"
    shutil.copytree(first.checkpoint, damaged)
    with (damaged / "regrets.npy").open("r+b") as f:
        f.seek(200)
        f.write(b"\x01")
    assert "files differ from the manifest" in refused(report, "--served", str(served), "--checkpoint", str(damaged))
    assert not site.registry.exists()

    close = site.report(f"blueprint:{first.checkpoint}", {**GOOD, "heuristic": (-1.0, 5.0)})
    assert site.promote(close).exit_code == 1 and len(site.decisions()) == 1
    assert "already been recorded" in refused(close)
    assert site.promote(report, "--served", str(served), "--name", "first").exit_code == 0
    again = site.report(f"blueprint:{first.checkpoint}", GOOD)
    assert "already the heads-up champion, first" in refused(again, "--served", str(site.report(f"bundle:{first.bundle}", GOOD)))
    assert len(site.decisions()) == 2


def test_a_bundle_can_be_evaluated_and_be_an_opponent(candidates: tuple[Candidate, Candidate], tmp_path: Path) -> None:
    first, second = candidates
    args = ["--deals", "6", "--workers", "1", "--out", str(tmp_path), "--against", "calling_station@100", "--against", f"bundle:{second.bundle}@100"]
    result = CliRunner().invoke(cli, ["blueprint", "evaluate", str(first.bundle), "--name", "served", *args])
    assert result.exit_code == 0, result.output
    report = json.loads((tmp_path / "served.json").read_text())
    manifest = json.loads((first.bundle / "manifest.json").read_text())
    c = report["candidate"]
    assert c["spec"] == "bundle" and c["bundle"] == str(first.bundle) and c["levels"] == 255
    assert c["files"] == {k: v["sha256"] for k, v in manifest["files"].items()}
    assert c["table_set"] == manifest["cards"]["table_set"]
    assert c["exported_from"]["strategy_sha256"] == manifest["checkpoint"]["strategy_sha256"]
    assert report["opponents"][f"bundle:{second.bundle}"]["files"]["strategy.u8"] != c["files"]["strategy.u8"]
    assert [r["opponent"] for r in report["results"]] == ["calling_station", f"bundle:{second.bundle}"]
    assert all(r["candidate_decisions"]["decisions"] > 0 for r in report["results"])
    assert report["command"].split()[:6] == ["uv", "run", "--locked", "rivermind-poker", "blueprint", "evaluate"]
    page = (tmp_path / "served.md").read_text()
    assert "the serving bundle" in page and "multiples of 1/255" in page
    # The same deals from the checkpoint differ only by the rounding, so the report is of the same shape.
    result = CliRunner().invoke(cli, ["blueprint", "evaluate", str(first.checkpoint), "--name", "float", *args])
    assert result.exit_code == 0, result.output
    exact = json.loads((tmp_path / "float.json").read_text())
    assert exact["candidate"]["spec"] == "blueprint" and exact["candidate"]["files"]["strategy.npy"] == c["exported_from"]["strategy_sha256"]


# Difficulty levels (P5.7)


def test_medium_is_recorded_for_the_champion_it_was_made_from(site: Site, candidates: tuple[Candidate, Candidate]) -> None:
    first, second = candidates
    level = ["blueprint", "level", "--registry", str(site.registry), "--page", str(site.page), "--site", str(site.site), "--date", "2026-11-23"]
    medium = {"heuristic": (5.0, 25.0), "calling_station": (40.0, 80.0), f"bundle:{first.bundle}": (-40.0, -10.0)}
    report = site.report(f"medium:bundle:{first.bundle}", medium)
    refused = CliRunner().invoke(cli, [*level, str(report)])
    assert refused.exit_code != 0 and "no champion" in refused.output
    assert site.promote_both(first, GOOD).exit_code == 0
    recorded = CliRunner().invoke(cli, [*level, str(report)])
    assert recorded.exit_code == 0, recorded.output
    registry = reg.load(site.registry)
    entry = reg.level_of(registry, "first")
    assert entry is not None and entry["champion"] == "first" and entry["share"] == 0.5
    assert [r["opponent"] for r in entry["results"]] == ["heuristic", "calling_station", "hard"]
    assert entry["results"][2]["ci95_bb_per_100"] == [-40.0, -10.0]
    assert "**RiverMind Medium:**" in site.page.read_text()
    champion = json.loads(site.site.read_text())["champions"][0]
    rows = champion["levels"]["medium"]["evaluation"]["results"]
    assert [(r["opponent"], r["name"], r["gate"]) for r in rows] == [("heuristic", None, False), ("calling_station", None, False), ("hard", "first", False)]
    again = CliRunner().invoke(cli, [*level, str(report)])
    assert again.exit_code != 0 and "already been recorded" in again.output
    # A Medium of another model, a plain report or one that never played the champion is refused.
    for wrong, why in (
        (site.report(f"medium:bundle:{second.bundle}", {**medium, f"bundle:{second.bundle}": (1.0, 2.0)}), "not made from"),
        (site.report(f"bundle:{first.bundle}", GOOD), "difficulty level"),
        (site.report(f"medium:bundle:{first.bundle}", GOOD), "bundle:<first's bundle>"),
    ):
        result = CliRunner().invoke(cli, [*level, str(wrong)])
        assert result.exit_code != 0 and why in result.output, result.output
    # A new champion has no Medium until its own is recorded.
    replace = {**GOOD, f"blueprint:{first.checkpoint}": (1.0, 9.0)}
    assert site.promote_both(second, replace, {**GOOD, f"bundle:{first.bundle}": (1.0, 9.0)}).exit_code == 0
    assert "levels" not in json.loads(site.site.read_text())["champions"][0]
    assert "**RiverMind Medium:**" not in site.page.read_text()


def test_a_medium_report_describes_both_bots(candidates: tuple[Candidate, Candidate], tmp_path: Path) -> None:
    first, _ = candidates
    args = ["--deals", "4", "--workers", "1", "--out", str(tmp_path), "--against", "heuristic@100", "--level", "medium"]
    result = CliRunner().invoke(cli, ["blueprint", "evaluate", str(first.bundle), "--name", "medium", *args])
    assert result.exit_code == 0, result.output
    report = json.loads((tmp_path / "medium.json").read_text())
    c = report["candidate"]
    assert c["spec"] == "medium" and c["share"] == 0.5 and c["source"] == "rivermind/bots/levels.py"
    assert c["strong"] == describe_policy(f"bundle:{first.bundle}") and c["weak"] == describe_policy("heuristic")
    stats = report["results"][0]["candidate_decisions"]
    assert stats["hands_strong"] + stats["hands_weak"] > 0
    assert report["command"].endswith("--level medium")
    assert "RiverMind Medium" in (tmp_path / "medium.md").read_text()


# The published registry


def test_the_site_extract_is_the_registry() -> None:
    registry = reg.load(ROOT / reg.REGISTRY)
    assert (ROOT / reg.SITE).read_text() == reg.dumps(reg.site_data(registry, ROOT / "docs")), (
        "web/src/lib/champions.json is stale: it is written by `rivermind-poker blueprint promote`"
    )


def test_the_published_page_is_the_registry_rendered() -> None:
    registry = reg.load(ROOT / reg.REGISTRY)
    page = (ROOT / reg.PAGE).read_text()
    assert reg.page_text(page, registry) == page, "docs/models.md is stale: it is written by `rivermind-poker blueprint promote`"


def test_the_published_decisions_follow_from_their_reports() -> None:
    registry = reg.load(ROOT / reg.REGISTRY)
    replayed = reg.empty()
    for decision in registry["decisions"]:
        assert decision["outcome"] in reg.OUTCOMES and decision["format"] in reg.FORMATS.values()
        incumbent = reg.champion(replayed, decision["format"])
        assert decision["incumbent"] == (incumbent["name"] if incumbent else None)
        for evaluation in decision["evaluations"]:
            path = ROOT / "docs" / evaluation["report"]
            assert reg._sha256(path) == evaluation["sha256"], f"{path} changed after it was recorded"
            assert path.with_suffix(".md").exists()
            report = json.loads(path.read_text())
            found = reg.assess(report, incumbent)
            assert {k: evaluation[k] for k in found} == found
            expected = decision["checkpoint"]["files"] if evaluation["candidate"] == "checkpoint" else decision["bundle"]["files"]
            assert report["candidate"]["files"] == expected
        outcomes = {e["outcome"] for e in decision["evaluations"]}
        if decision["outcome"] == "promoted":
            assert outcomes == {"passed"} and [e["candidate"] for e in decision["evaluations"]] == ["checkpoint", "bundle"]
        else:
            assert ("failed" if "failed" in outcomes else "inconclusive") == decision["outcome"]
        replayed["decisions"].append(decision)


def test_the_published_levels_follow_from_their_reports() -> None:
    registry = reg.load(ROOT / reg.REGISTRY)
    by_name = {d["name"]: d for d in registry["decisions"] if d["outcome"] == "promoted"}
    for entry in reg.levels(registry):
        path = ROOT / "docs" / entry["report"]
        assert reg._sha256(path) == entry["sha256"], f"{path} changed after it was recorded"
        assert path.with_suffix(".md").exists()
        report = json.loads(path.read_text())
        decision = by_name[entry["champion"]]
        replayed = {**reg.empty(), "decisions": [decision]}
        found = reg.record_level(replayed, date=entry["date"], report=report, report_path=entry["report"], report_sha256=entry["sha256"])
        assert found == entry
    for fmt, current in reg.champions(registry).items():
        assert current["format"] == fmt and current["bundle"]["table_set"] == current["checkpoint"]["cards"]["table_set"]
