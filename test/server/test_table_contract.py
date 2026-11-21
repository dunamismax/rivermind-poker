"""The TypeScript server's copies of the table fixtures are current (P4B.5b)."""

from __future__ import annotations

from . import export_table_contract, table_differential


def test_table_contract_json_matches_the_python_server() -> None:
    assert export_table_contract.OUTPUT.read_text(encoding="utf-8") == export_table_contract.export(), (
        "web/src/lib/server/api/table-contract.json is stale: "
        "run `uv run --locked python -m test.server.export_table_contract`"
    )


def test_table_parity_json_matches_the_python_table() -> None:
    assert table_differential.FIXTURE.read_text(encoding="utf-8") == table_differential.fixture_text(), (
        "web/src/lib/server/table/parity.json is stale: "
        "run `uv run --locked python -m test.server.table_differential --fixture`"
    )
