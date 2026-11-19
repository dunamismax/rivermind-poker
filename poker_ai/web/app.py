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

The token travels inside the socket, never in a URL, so it stays out of
access logs. After every change each connected seat receives its own view.
Reconnecting is joining again with the same token. Tables live in memory;
idle ones are evicted when the server needs room.
"""
from __future__ import annotations

import asyncio
import json
import random
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from poker_ai.games.short_deck.state import InfoSetLookupTable
from poker_ai.policies import CheckpointPolicy, RandomPolicy, Strategy
from poker_ai.table import SeatConfig, Table, TableError

STATIC_DIR = Path(__file__).parent / "static"
OPPONENTS = {"random": "Random", "checkpoint": "RiverMind"}


class NewTable(BaseModel):
    opponents: str = "random"


@dataclass
class _Entry:
    table: Table
    opponents: str
    last_active: float = field(default_factory=time.monotonic)
    # Open sockets -> the seat token each one joined with.
    sockets: Dict[WebSocket, str] = field(default_factory=dict)


class TableRegistry:
    """In-memory tables with idle eviction."""

    def __init__(
        self,
        card_info_lut: Optional[InfoSetLookupTable],
        strategy: Optional[Strategy],
        max_tables: int,
        idle_seconds: float,
    ):
        self._card_info_lut = card_info_lut
        self._strategy = strategy
        self._max_tables = max_tables
        self._idle_seconds = idle_seconds
        self._tables: Dict[str, _Entry] = {}

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
        if opponents == "checkpoint":
            bots = [CheckpointPolicy(self._strategy, random.Random()) for _ in range(2)]
            lut = self._card_info_lut
        else:
            bots = [RandomPolicy(random.Random()) for _ in range(2)]
            lut = None
        table = Table(
            [SeatConfig("You"), SeatConfig(f"{label} 1", bots[0]),
             SeatConfig(f"{label} 2", bots[1])],
            card_info_lut=lut,
        )
        table_id = secrets.token_urlsafe(9)
        self._tables[table_id] = _Entry(table, opponents)
        return table_id, table.tokens[0]

    def get(self, table_id: Any) -> Optional[_Entry]:
        entry = self._tables.get(table_id) if isinstance(table_id, str) else None
        if entry:
            entry.last_active = time.monotonic()
        return entry

    def _evict(self):
        now = time.monotonic()
        idle = [k for k, e in self._tables.items()
                if not e.sockets and now - e.last_active > self._idle_seconds]
        for key in idle:
            del self._tables[key]
        if len(self._tables) >= self._max_tables:
            unused = sorted(
                (e.last_active, k) for k, e in self._tables.items() if not e.sockets
            )
            for _, key in unused[: len(self._tables) - self._max_tables + 1]:
                del self._tables[key]


def create_app(
    card_info_lut: Optional[InfoSetLookupTable] = None,
    strategy: Optional[Strategy] = None,
    max_tables: int = 500,
    idle_seconds: float = 3600,
) -> FastAPI:
    """Build the app. Checkpoint opponents need both `strategy` and tables."""
    if (strategy is None) != (not card_info_lut):
        raise ValueError("Checkpoint opponents need both a strategy and card tables.")
    registry = TableRegistry(card_info_lut, strategy, max_tables, idle_seconds)
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

    @app.get("/api/config")
    async def config():
        return {"opponents": registry.opponents}

    @app.post("/api/tables", status_code=201)
    async def new_table(body: NewTable):
        table_id, token = registry.create(body.opponents)
        return {"table_id": table_id, "token": token}

    async def send(ws: WebSocket, message: Dict[str, Any]):
        await ws.send_text(json.dumps(message, separators=(",", ":")))

    async def error(ws, code, message, view=None):
        await send(ws, {"type": "error", "code": code, "message": message, "view": view})

    async def broadcast(entry: _Entry):
        for ws, token in list(entry.sockets.items()):
            try:
                await send(ws, {"type": "view", "view": entry.table.view(token)})
            except Exception:  # a socket closed mid-broadcast
                entry.sockets.pop(ws, None)

    @app.websocket("/ws")
    async def play(ws: WebSocket):
        await ws.accept()
        entry: Optional[_Entry] = None
        try:
            try:
                join = json.loads(await asyncio.wait_for(ws.receive_text(), 30))
            except (asyncio.TimeoutError, ValueError):
                await error(ws, "bad_request", "Send a join message first.")
                await ws.close(code=1008)
                return
            entry = registry.get(join.get("table_id")) if isinstance(join, dict) else None
            if entry is None or join.get("type") != "join":
                await error(ws, "unknown_table", "That table no longer exists.")
                await ws.close(code=1008)
                return
            token = join.get("token")
            try:
                view = entry.table.view(token)
            except TableError as e:
                await error(ws, e.code, str(e))
                await ws.close(code=1008)
                return
            entry.sockets[ws] = token
            await send(ws, {"type": "view", "view": view})
            while True:
                try:
                    message = json.loads(await ws.receive_text())
                    kind = message["type"]
                except (ValueError, KeyError, TypeError):
                    await error(ws, "bad_request", "Messages are JSON objects with a type.",
                                entry.table.view(token))
                    continue
                registry.get(join["table_id"])  # mark active
                try:
                    if kind == "act":
                        await run_in_threadpool(
                            entry.table.act, token, message.get("action"), message.get("seq"))
                    elif kind == "next_hand":
                        await run_in_threadpool(
                            entry.table.next_hand, token, message.get("seq"))
                    elif kind == "refresh":
                        await send(ws, {"type": "view", "view": entry.table.view(token)})
                        continue
                    else:
                        await error(ws, "bad_request", f"Unknown message type {kind!r}.",
                                    entry.table.view(token))
                        continue
                except TableError as e:
                    await error(ws, e.code, str(e), entry.table.view(token))
                    continue
                await broadcast(entry)
        except WebSocketDisconnect:
            pass
        finally:
            if entry is not None:
                entry.sockets.pop(ws, None)

    return app
