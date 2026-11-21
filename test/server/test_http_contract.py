"""The TypeScript server's copy of the HTTP contract is current (P4B.5a)."""

from __future__ import annotations

from .export_http_contract import OUTPUT, export


def test_contract_json_matches_the_python_server() -> None:
    assert OUTPUT.read_text(encoding="utf-8") == export(), (
        "web/src/lib/server/api/contract.json is stale: "
        "run `uv run --locked python -m test.server.export_http_contract`"
    )
