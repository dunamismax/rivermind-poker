"""Browser play: a FastAPI app that serves the client and wraps `Table`.

HTTP creates a table (`POST /api/tables`) and returns its id and the
human seat's secret token. Play happens over one WebSocket (`/ws`):

client -> server (JSON text frames)
    {"type": "join", "table_id": ..., "token": ...}   must come first
    {"type": "act", "action": "call", "seq": 7}
    {"type": "next_hand", "seq": 9}
    {"type": "refresh"}

server -> client
    {"type": "view", "view": {...}}                    the seat's view
    {"type": "error", "code": ..., "message": ..., "view": {...} | null}

Every body and message is a model in `poker_ai.web.protocol`: incoming
messages are validated with them and outgoing ones are built from them.

The token travels inside the socket, never in a URL, so it stays out of
access logs. After every change each connected seat receives its own view.
Reconnecting is joining again with the same token. Tables live in memory;
idle ones are evicted when the server needs room. With a `TableStore`, every
change is also saved, and saved tables are loaded at startup, so a restart
mid-hand is invisible to players apart from a brief reconnect.
"""
from __future__ import annotations

import asyncio
import json
import logging
import pickle
import random
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from poker_ai.games.short_deck.state import InfoSetLookupTable
from poker_ai.policies import CheckpointPolicy, RandomPolicy, Strategy
from poker_ai.table import SeatConfig, Table, TableError
from poker_ai.web.protocol import (
    ActMessage, ClientMessage, ConfigResponse, ErrorMessage, HttpError, JoinMessage,
    NewTableRequest, NewTableResponse, NextHandMessage, SeatView, ViewMessage,
)
from poker_ai.web.store import TableStore

log = logging.getLogger("poker_ai.web")

STATIC_DIR = Path(__file__).parent / "static"
OPPONENTS = {"random": "Random", "checkpoint": "RiverMind"}


@dataclass
class _Entry:
    table: Table
    opponents: str
    last_active: float = field(default_factory=time.time)
    # Open sockets -> the seat token each one joined with.
    sockets: Dict[WebSocket, str] = field(default_factory=dict)


class TableRegistry:
    """Tables in memory with idle eviction, optionally saved to a store."""

    def __init__(
        self,
        card_info_lut: Optional[InfoSetLookupTable],
        strategy: Optional[Strategy],
        max_tables: int,
        idle_seconds: float,
        store: Optional[TableStore] = None,
    ):
        self._card_info_lut = card_info_lut
        self._strategy = strategy
        self._max_tables = max_tables
        self._idle_seconds = idle_seconds
        self._store = store
        self._tables: Dict[str, _Entry] = {}
        if store is not None:
            self._load()

    def _bots(self, opponents: str) -> list:
        if opponents == "checkpoint":
            return [CheckpointPolicy(self._strategy, random.Random()) for _ in range(2)]
        return [RandomPolicy(random.Random()) for _ in range(2)]

    def _load(self):
        """Restore saved tables, dropping expired or unreadable ones."""
        now, restored = time.time(), 0
        for table_id, opponents, last_active, blob in self._store.rows():
            if now - last_active > self._idle_seconds:
                self._store.delete(table_id)
                continue
            if opponents not in self.opponents:
                # e.g. started without the checkpoint: keep it for a later start.
                log.warning("Not restoring %s table %s", opponents, table_id)
                continue
            try:
                bots = self._bots(opponents)
                table = Table.restore(
                    pickle.loads(blob), {1: bots[0], 2: bots[1]},
                    self._card_info_lut if opponents == "checkpoint" else None,
                )
            except Exception:
                log.exception("Dropping table %s: its snapshot cannot be restored",
                              table_id)
                self._store.delete(table_id)
                continue
            self._tables[table_id] = _Entry(table, opponents, last_active)
            restored += 1
        log.info("Restored %d saved tables", restored)

    def save(self, table_id: str):
        """Persist a table after it changed (no-op without a store)."""
        entry = self._tables.get(table_id)
        if entry is not None and self._store is not None:
            entry.last_active = time.time()
            self._store.save(table_id, entry.opponents, entry.last_active,
                             entry.table.snapshot())

    @property
    def opponents(self):
        return ["random"] + (["checkpoint"] if self._strategy is not None else [])

    def create(self, opponents: str) -> tuple[str, str]:
        if opponents not in self.opponents:
            raise HTTPException(400, f"Opponents must be one of {self.opponents}.")
        self._evict()
        if len(self._tables) >= self._max_tables:
            raise HTTPException(503, "Every table is in use; try again later.")
        label = OPPONENTS[opponents]
        bots = self._bots(opponents)
        lut = self._card_info_lut if opponents == "checkpoint" else None
        table = Table(
            [SeatConfig("You"), SeatConfig(f"{label} 1", bots[0]),
             SeatConfig(f"{label} 2", bots[1])],
            card_info_lut=lut,
        )
        table_id = secrets.token_urlsafe(9)
        self._tables[table_id] = _Entry(table, opponents)
        self.save(table_id)
        return table_id, table.tokens[0]

    def get(self, table_id: Any) -> Optional[_Entry]:
        entry = self._tables.get(table_id) if isinstance(table_id, str) else None
        if entry:
            entry.last_active = time.time()
        return entry

    def _drop(self, table_id: str):
        del self._tables[table_id]
        if self._store is not None:
            self._store.delete(table_id)

    def _evict(self):
        now = time.time()
        idle = [k for k, e in self._tables.items()
                if not e.sockets and now - e.last_active > self._idle_seconds]
        for key in idle:
            self._drop(key)
        if len(self._tables) >= self._max_tables:
            unused = sorted(
                (e.last_active, k) for k, e in self._tables.items() if not e.sockets
            )
            for _, key in unused[: len(self._tables) - self._max_tables + 1]:
                self._drop(key)


def create_app(
    card_info_lut: Optional[InfoSetLookupTable] = None,
    strategy: Optional[Strategy] = None,
    max_tables: int = 500,
    idle_seconds: float = 7 * 24 * 3600,
    state_path: Optional[str] = None,
) -> FastAPI:
    """Build the app. Checkpoint opponents need both `strategy` and tables.

    With `state_path`, tables are saved to that SQLite file after every
    change and restored from it at startup. Idle tables expire after
    `idle_seconds` (a week by default).
    """
    if (strategy is None) != (not card_info_lut):
        raise ValueError("Checkpoint opponents need both a strategy and card tables.")
    store = TableStore(state_path) if state_path else None
    registry = TableRegistry(card_info_lut, strategy, max_tables, idle_seconds, store)
    app = FastAPI(title="RiverMind Poker", docs_url=None, redoc_url=None)
    app.state.registry = registry
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.middleware("http")
    async def revalidate_client_files(request, call_next):
        # Browsers would otherwise keep a stale client after an upgrade;
        # no-cache still lets them reuse it when the ETag matches.
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.exception_handler(RequestValidationError)
    async def bad_body(request: Request, exc: RequestValidationError):
        # Keep every HTTP error in the protocol's HttpError shape.
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        detail = f"Invalid request body: {where or 'body'}: {first.get('msg', 'invalid')}"
        return JSONResponse(HttpError(detail=detail).model_dump(), status_code=400)

    @app.get("/api/config", response_model=ConfigResponse)
    async def config():
        return ConfigResponse(opponents=registry.opponents)

    @app.post("/api/tables", status_code=201, response_model=NewTableResponse,
              responses={400: {"model": HttpError}, 503: {"model": HttpError}})
    async def new_table(body: NewTableRequest):
        table_id, token = registry.create(body.opponents)
        return NewTableResponse(table_id=table_id, token=token)

    def seat_view(entry: _Entry, token: str) -> SeatView:
        return SeatView.model_validate(entry.table.view(token))

    async def send(ws: WebSocket, message: ViewMessage | ErrorMessage):
        await ws.send_text(message.model_dump_json())

    async def view(ws: WebSocket, seat: SeatView):
        await send(ws, ViewMessage(type="view", view=seat))

    async def error(ws, code, message, seat: Optional[SeatView] = None):
        await send(ws, ErrorMessage(type="error", code=code, message=message, view=seat))

    async def broadcast(entry: _Entry):
        for ws, token in list(entry.sockets.items()):
            try:
                await view(ws, seat_view(entry, token))
            except Exception:  # a socket closed mid-broadcast
                entry.sockets.pop(ws, None)

    @app.websocket("/ws")
    async def play(ws: WebSocket):
        await ws.accept()
        entry: Optional[_Entry] = None
        try:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), 30)
                json.loads(raw)
            except (asyncio.TimeoutError, ValueError):
                await error(ws, "bad_request", "Send a join message first.")
                await ws.close(code=1008)
                return
            try:
                join = JoinMessage.model_validate_json(raw)
            except ValidationError:
                join = None
            entry = registry.get(join.table_id) if join else None
            if entry is None:
                await error(ws, "unknown_table", "That table no longer exists.")
                await ws.close(code=1008)
                return
            token = join.token
            try:
                seat = seat_view(entry, token)
            except TableError as e:
                await error(ws, e.code, str(e))
                await ws.close(code=1008)
                return
            entry.sockets[ws] = token
            await view(ws, seat)

            def change(method, *args):
                # Save before anyone sees the new state, so a restart can
                # never take back something a player was shown.
                method(*args)
                registry.save(join.table_id)
            while True:
                text = await ws.receive_text()
                try:
                    message = ClientMessage.model_validate_json(text).root
                except ValidationError:
                    await error(ws, "bad_request", _describe_invalid(text),
                                seat_view(entry, token))
                    continue
                registry.get(join.table_id)  # mark active
                try:
                    if isinstance(message, ActMessage):
                        await run_in_threadpool(
                            change, entry.table.act, token, message.action, message.seq)
                    elif isinstance(message, NextHandMessage):
                        await run_in_threadpool(
                            change, entry.table.next_hand, token, message.seq)
                    else:  # refresh
                        await view(ws, seat_view(entry, token))
                        continue
                except TableError as e:
                    await error(ws, e.code, str(e), seat_view(entry, token))
                    continue
                await broadcast(entry)
        except WebSocketDisconnect:
            pass
        finally:
            if entry is not None:
                entry.sockets.pop(ws, None)

    return app


_MESSAGE_TYPES = {"act", "next_hand", "refresh"}


def _describe_invalid(text: str) -> str:
    """A short reason for a client message that failed validation."""
    try:
        message = json.loads(text)
    except ValueError:
        return "Messages are JSON objects with a type."
    if not isinstance(message, dict) or "type" not in message:
        return "Messages are JSON objects with a type."
    if message["type"] not in _MESSAGE_TYPES:
        return f"Unknown message type {message['type']!r}."
    return f"Invalid {message['type']} message."
