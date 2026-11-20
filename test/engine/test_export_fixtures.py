"""The TypeScript engine's copy of the rule hands is current (P4B.4)."""

from __future__ import annotations

from .export_fixtures import OUTPUT, export


def test_rules_json_matches_the_fixtures() -> None:
    assert OUTPUT.read_text(encoding="utf-8") == export(), (
        "web/src/lib/server/engine/rules.json is stale: "
        "run `uv run --locked python -m test.engine.export_fixtures`"
    )
