"""P1.2: the typed protocol shared by the server and the web client."""
import json
import re
from pathlib import Path

import pytest
from click.testing import CliRunner
from fastapi.testclient import TestClient
from pydantic import ValidationError

from poker_ai.cli.runner import cli
from poker_ai.web import app as app_module
from poker_ai.web.app import create_app
from poker_ai.web.protocol import (
    ClientMessage, ErrorCode, SeatView, ServerMessage, json_schema,
)
from rivermind.server.typescript import to_typescript, type_of

ROOT = Path(__file__).resolve().parents[2]
GENERATED = ROOT / "web" / "src" / "lib" / "protocol.ts"


def test_generated_typescript_is_current():
    expected = to_typescript(json_schema())
    assert GENERATED.read_text() == expected, (
        "web/src/lib/protocol.ts is stale. Regenerate it with "
        "`uv run --locked rivermind-poker protocol-schema "
        "--typescript web/src/lib/protocol.ts`.")


def test_cli_exports_schema_and_typescript(tmp_path):
    runner = CliRunner()
    result = runner.invoke(cli, ["protocol-schema"])
    assert result.exit_code == 0, result.output
    schema = json.loads(result.output)
    assert schema == json_schema()
    for name in ["ConfigResponse", "NewTableRequest", "NewTableResponse", "HttpError",
                 "JoinMessage", "ClientMessage", "ServerMessage", "SeatView", "ErrorCode"]:
        assert name in schema["$defs"]
    out, ts = tmp_path / "schema.json", tmp_path / "protocol.ts"
    result = runner.invoke(cli, ["protocol-schema", "--output", str(out),
                                 "--typescript", str(ts)])
    assert result.exit_code == 0, result.output
    assert json.loads(out.read_text()) == schema
    assert ts.read_text() == GENERATED.read_text()


def test_error_codes_cover_everything_the_server_raises():
    sources = [ROOT / "poker_ai" / "table.py", Path(app_module.__file__)]
    raised = set()
    for source in sources:
        text = source.read_text()
        raised |= set(re.findall(r'TableError\(\s*"(\w+)"', text))
        raised |= set(re.findall(r'error\(\s*ws,\s*"(\w+)"', text))
    assert raised == {code.value for code in ErrorCode} == {
        "bad_request", "stale", "illegal_action", "not_your_turn", "hand_over",
        "hand_in_progress", "unknown_table", "unknown_seat"}


def _seat(client):
    return client.post("/api/tables", json={"opponents": "random"}).json()


def test_every_server_message_matches_the_schema():
    client = TestClient(create_app())
    seat = _seat(client)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "join", **seat})
        messages = [ws.receive_text()]
        for _ in range(3):  # play three hands, recording every message
            view = json.loads(messages[-1])["view"]
            while view["result"] is None:
                ws.send_json({"type": "act", "action": "call", "seq": view["seq"]})
                messages.append(ws.receive_text())
                view = json.loads(messages[-1])["view"]
            ws.send_json({"type": "act", "action": "call", "seq": view["seq"]})
            messages.append(ws.receive_text())  # hand_over error
            ws.send_json({"type": "next_hand", "seq": view["seq"]})
            messages.append(ws.receive_text())
    parsed = [ServerMessage.model_validate_json(m).root for m in messages]
    assert {m.type for m in parsed} == {"view", "error"}
    for message in parsed:
        if message.view is not None:
            hidden = [s for s in message.view.seats
                      if s.seat != message.view.seat and s.cards is not None]
            assert not hidden or message.view.result is not None


@pytest.mark.parametrize("message", [
    {"type": "act", "action": "call", "seq": "7"},  # strings are not coerced
    {"type": "act", "action": "call"},
    {"type": "act", "action": "call", "seq": 1, "extra": True},
    {"type": "next_hand", "seq": True},
    {"type": "dance"},
    [1, 2],
])
def test_invalid_client_messages_are_bad_requests(message):
    client = TestClient(create_app())
    seat = _seat(client)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "join", **seat})
        view = ws.receive_json()["view"]
        ws.send_json(message)
        reply = ws.receive_json()
        assert reply["type"] == "error" and reply["code"] == "bad_request", reply
        assert reply["view"] == view
    with pytest.raises(ValidationError):
        ClientMessage.model_validate(message)


def test_http_errors_use_the_protocol_shape():
    client = TestClient(create_app())
    for body in ({"opponents": 3}, {"opponents": "random", "x": 1}):
        response = client.post("/api/tables", json=body)
        assert response.status_code == 400
        assert set(response.json()) == {"detail"} and isinstance(response.json()["detail"], str)
    response = client.post("/api/tables", content=b"not json",
                           headers={"content-type": "application/json"})
    assert response.status_code == 400 and isinstance(response.json()["detail"], str)
    assert client.post("/api/tables", json={"opponents": "nope"}).json()["detail"]


def test_seat_view_rejects_unknown_fields():
    client = TestClient(create_app())
    seat = _seat(client)
    view = client.app.state.registry.get(seat["table_id"]).table.view(seat["token"])
    SeatView.model_validate(view)
    with pytest.raises(ValidationError):
        SeatView.model_validate({**view, "deck": []})


def test_typescript_generator_rejects_unsupported_schemas():
    with pytest.raises(ValueError):
        type_of({"type": "string", "format": "binary", "$ref": "elsewhere.json"})
    with pytest.raises(ValueError):
        type_of({"not": {}})
    assert type_of({"type": "array", "items": {"enum": ["a", "b"]}}) == "('a' | 'b')[]"
