"""The TypeScript table's copy of the table parity fixture is current (P4B.5b)."""

from __future__ import annotations

from . import table_differential


def test_table_parity_json_matches_the_python_table() -> None:
    assert table_differential.FIXTURE.read_text(encoding="utf-8") == table_differential.fixture_text(), (
        "web/src/lib/server/table/parity.json is stale: "
        "run `uv run --locked python -m test.server.table_differential --fixture`"
    )
