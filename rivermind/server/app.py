"""The no-limit table server: FastAPI over HTTP and one WebSocket (P3.4).

``create_app`` serves protocol v2 (``rivermind.server.protocol``): players,
tables with bots, and a socket per client that can follow several tables.
Each table runs as a ``TableRunner`` task. After every change at a table, a
listener builds each subscribed player's own view and queues it on that
player's socket, so a slow client never holds up a table.

A player's seat is marked disconnected when their last socket following
that table closes, and connected again when one follows it; the table's
clock then sits them out if they stay away (P3.3). A table closes when no
person holds a seat, and idle tables are evicted when the server needs room.

Players are anonymous (P4.1). ``POST /api/session`` makes one on the first
visit and sets a signed session cookie (``auth``), which authenticates every
later request and socket. Requests and sockets from pages on other origins
are refused, so another site cannot act with a visitor's cookie.

Each player has a play-chip wallet (P4.2, ``wallet``). Buy-ins and rebuys are
paid from it before they reach the table and refunded if the table refuses
them; chips come back when the player leaves or a waiting rebuy no longer
fits, and when a table closes with them still seated.

With a ``TableStore`` (P3.5) every table is saved to PostgreSQL after each
change and before any socket hears of it, and the open tables are restored
when the app starts. Nobody is connected to a restored table yet, so its
people are marked disconnected until they rejoin.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import time
from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ValidationError

from rivermind.bots import Policy
from rivermind.engine import Action, ActionKind

from . import auth
from . import protocol as p
from rivermind.engine.history import FormatError

from .players import DatabasePlayers, MemoryPlayers, PlayerRecord, PlayerStore
from .wallet import PLAY_MONEY_NOTICE, Credit, DatabaseWallet, InsufficientChips, MemoryWallet, Wallet, credits_for
from .runner import BOT_LABELS, RunnerOptions, TableManager, TableRunner, default_bots
from .snapshot import table_from_dict
from .store import TableSaver, TableStore
from .table import Event, TableConfig, TableError
from .views import table_events, table_view

log = logging.getLogger("rivermind.server")

STAKES = ((25, 50), (50, 100), (100, 200), (500, 1000))
MAX_SUBSCRIPTIONS = 8
QUEUE_LIMIT = 512

# Mirrors deploy/rivermindpoker.com.caddy, so the built client is tested
# locally under the policy it gets in production.
CLIENT_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}
CSP = (
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
    "connect-src 'self' {ws}; object-src 'none'; frame-ancestors 'none'; "
    "base-uri 'self'; form-action 'self'"
)


class RequestError(Exception):
    """A socket request refused before it reached a table."""

    def __init__(self, code: p.ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(eq=False)
class Connection:
    """One client socket, authenticated as one player."""

    ws: WebSocket
    player_id: str
    name: str
    queue: asyncio.Queue[BaseModel | None] = field(default_factory=lambda: asyncio.Queue(QUEUE_LIMIT))
    tables: dict[str, object] = field(default_factory=dict)
    """Table id -> the listener registered on that table's runner."""
    closed: bool = False

    def send(self, message: BaseModel) -> None:
        if self.closed:
            return
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            log.warning("Dropping a client of %s that is not reading", self.player_id)
            self.closed = True
            with contextlib.suppress(asyncio.QueueFull):
                self.queue.get_nowait()
                self.queue.put_nowait(None)


class Server:
    """The app's tables and sockets."""

    def __init__(
        self,
        secret: bytes,
        bots: Mapping[str, Policy],
        options: RunnerOptions,
        max_tables: int,
        idle_seconds: float,
        store: TableStore | None = None,
        players: PlayerStore | None = None,
        wallet: Wallet | None = None,
    ) -> None:
        self.secret = secret
        self.store = store
        if players is None:
            players = DatabasePlayers(store.engine) if store is not None else MemoryPlayers()
        self.players = players
        if wallet is None:
            wallet = DatabaseWallet(store.engine) if store is not None else MemoryWallet()
        self.wallet = wallet
        self._known: dict[str, PlayerRecord] = {}
        self.bots = dict(bots)
        self.options = options
        self.max_tables = max_tables
        self.idle_seconds = idle_seconds
        self.manager: TableManager | None = None
        self.watchers: dict[tuple[str, str], int] = {}
        """(table id, player id) -> open sockets following that table."""
        self.connections: set[Connection] = set()
        self._closing: set[str] = set()

    @property
    def tables(self) -> TableManager:
        assert self.manager is not None, "the app is not running"
        return self.manager

    async def start(self) -> None:
        self.manager = TableManager(self.bots, self.options, setup=self._setup)
        if self.store is not None:
            await self._restore(self.store)

    def _setup(self, runner: TableRunner) -> None:
        if self.store is not None:
            # Pays departing chips in the same transaction as the save.
            runner.before_publish.append(TableSaver(self.store))
        else:
            runner.before_publish.append(self._cash_out)
        runner.listeners.append(self._watch_table)

    async def _cash_out(self, runner: TableRunner, events: Sequence[Event]) -> None:
        """Without a database: pay departing chips back to the wallets."""
        for credit in credits_for(runner.table_id, runner.table.drain_departures()):
            await asyncio.to_thread(self.wallet.credit, credit.player_id, credit.amount, credit.kind, credit.table_id)

    # Wallets

    async def pay_in(self, player_id: str, amount: int, kind: str, table_id: str | None) -> None:
        """Take a buy-in or rebuy from the wallet before it reaches the table."""
        if type(amount) is not int or amount <= 0:
            raise RequestError(p.ErrorCode.BAD_BUY_IN, "a buy-in is a positive whole number of chips")
        try:
            await asyncio.to_thread(self.wallet.debit, player_id, amount, kind, table_id)
        except InsufficientChips as error:
            raise RequestError(p.ErrorCode.INSUFFICIENT_CHIPS, str(error)) from None

    async def refund(self, player_id: str, amount: int, table_id: str | None) -> None:
        """Give back chips the table refused."""
        await asyncio.to_thread(self.wallet.credit, player_id, amount, "refund", table_id)

    async def _restore(self, store: TableStore) -> None:
        """Run every open table saved in the database again."""
        restored = 0
        for saved in await asyncio.to_thread(store.load_open):
            try:
                table = table_from_dict(saved.state, self.options.clock.now)
                runner = self.tables.restore(saved.table_id, table, name=saved.name)
            except (FormatError, ValueError):
                log.exception("Could not restore table %s; closing it", saved.table_id)
                await asyncio.to_thread(store.close, saved.table_id)
                continue
            restored += 1
            if not runner.has_people():
                self._schedule_close(saved.table_id, "Everyone has left the table.")
                continue
            for _, player in list(table.players()):
                if not player.is_bot and player.connected:
                    await runner.set_connected(player.player_id, False)
        if restored:
            log.info("Restored %d table(s) from the database", restored)

    # Players

    async def player(self, player_id: str) -> PlayerRecord | None:
        """The stored player with this id. Handles never change, so they are cached."""
        record = self._known.get(player_id)
        if record is None:
            record = await asyncio.to_thread(self.players.get, player_id)
            if record is not None:
                self._known[player_id] = record
        return record

    async def session_player(self, cookie: str | None) -> tuple[PlayerRecord, int] | None:
        """The player a genuine, unexpired session cookie belongs to, and when it was issued."""
        session = auth.read_session(self.secret, cookie, time.time())
        if session is None:
            return None
        record = await self.player(session[0])
        return None if record is None else (record, session[1])

    async def stop(self) -> None:
        if self.manager is not None:
            await self.manager.shutdown()

    # Tables

    def _evict(self) -> None:
        now = self.options.clock.now()
        for table_id, runner in list(self.tables.tables.items()):
            watched = any(key[0] == table_id for key in self.watchers)
            if not watched and now - runner.last_active > self.idle_seconds:
                self._schedule_close(table_id, "The table closed after being idle.")

    async def create_table(self, player: PlayerRecord, request: p.NewTableRequest) -> tuple[str, int]:
        if request.bots not in self.bots:
            raise HTTPException(400, f"bots must be one of {sorted(self.bots)}")
        stakes = dict((big, small) for small, big in STAKES)
        if request.big_blind not in stakes:
            raise HTTPException(400, f"big_blind must be one of {sorted(stakes)}")
        config = TableConfig(request.seats, stakes[request.big_blind], request.big_blind)
        if request.buy_in is None:
            # As much of the maximum as the wallet holds.
            balance = await asyncio.to_thread(self.wallet.balance, player.player_id)
            buy_in = min(config.max_buy_in, balance)
            if buy_in < config.min_buy_in:
                raise HTTPException(400, f"You have {balance:,} chips; this table needs at least {config.min_buy_in:,}.")
        else:
            buy_in = request.buy_in
        if not config.min_buy_in <= buy_in <= config.max_buy_in:
            raise HTTPException(400, f"buy_in must be {config.min_buy_in} to {config.max_buy_in}")
        self._evict()
        if len(self.tables.tables) >= self.max_tables:
            raise HTTPException(503, "Every table is in use; try again later.")
        label = BOT_LABELS.get(request.bots, request.bots)
        runner = self.tables.create(config, name=f"{request.seats}-seat table with {label}s")
        try:
            await self.pay_in(player.player_id, buy_in, "buy_in", runner.table_id)
        except RequestError as error:
            self._schedule_close(runner.table_id, "The table was not needed.")
            raise HTTPException(400, str(error)) from None
        try:
            # Bots first: with require_person, nothing is dealt until the person sits.
            for seat in range(1, request.seats):
                await runner.seat_bot(seat, request.bots)
            await runner.sit(0, player.player_id, player.handle, buy_in)
        except BaseException:
            await self.refund(player.player_id, buy_in, runner.table_id)
            self._schedule_close(runner.table_id, "The table could not be set up.")
            raise
        return runner.table_id, 0

    async def _watch_table(self, runner: TableRunner, events: Sequence[Event]) -> None:
        """Close a table once no person holds a seat."""
        if any(event.kind == "left" for event in events) and not runner.has_people():
            self._schedule_close(runner.table_id, "Everyone has left the table.")

    def _schedule_close(self, table_id: str, message: str) -> None:
        if table_id in self._closing:
            return
        self._closing.add(table_id)
        asyncio.get_running_loop().create_task(self._close_table(table_id, message))

    async def _close_table(self, table_id: str, message: str) -> None:
        try:
            runner = self.tables.get(table_id)
            await self.tables.close(table_id)
            # Anyone still seated (an idle table is evicted) gets their chips back.
            credits = [] if runner is None else self._seated_chips(runner)
            if self.store is not None:
                try:
                    await asyncio.to_thread(self.store.close, table_id, credits)
                except Exception:
                    log.exception("Could not mark table %s closed in the database", table_id)
            else:
                for credit in credits:
                    await asyncio.to_thread(self.wallet.credit, credit.player_id, credit.amount, "cash_out", table_id)
            for connection in list(self.connections):
                if connection.tables.pop(table_id, None) is not None:
                    connection.send(p.TableClosedMessage(type="table_closed", table_id=table_id, message=message))
            for key in [key for key in self.watchers if key[0] == table_id]:
                del self.watchers[key]
        finally:
            self._closing.discard(table_id)

    @staticmethod
    def _seated_chips(runner: TableRunner) -> list[Credit]:
        table = runner.table
        credits = credits_for(runner.table_id, table.drain_departures())
        for seat, player in table.players():
            chips = table.stack_of(seat) + player.pending_rebuy
            if not player.is_bot and chips > 0:
                credits.append(Credit(player.player_id, chips, "cash_out", runner.table_id))
        return credits

    # Sockets

    def _runner(self, table_id: str) -> TableRunner:
        runner = self.tables.get(table_id)
        if runner is None or table_id in self._closing:
            raise RequestError(p.ErrorCode.UNKNOWN_TABLE, "That table no longer exists.")
        return runner

    async def join(self, connection: Connection, table_id: str) -> None:
        runner = self._runner(table_id)
        if table_id not in connection.tables and len(connection.tables) >= MAX_SUBSCRIPTIONS:
            raise RequestError(p.ErrorCode.BAD_REQUEST, f"follow at most {MAX_SUBSCRIPTIONS} tables")
        player_id = connection.player_id
        async with runner.lock:
            if table_id not in connection.tables:

                async def listener(r: TableRunner, events: Sequence[Event]) -> None:
                    connection.send(
                        p.TableMessage(
                            type="table", table_id=r.table_id, view=table_view(r, player_id), events=table_events(events)
                        )
                    )

                runner.listeners.append(listener)
                connection.tables[table_id] = listener
                key = (table_id, player_id)
                self.watchers[key] = self.watchers.get(key, 0) + 1
            connection.send(p.TableMessage(type="table", table_id=table_id, view=table_view(runner, player_id), events=[]))
        if runner.table.seat_of(player_id) is not None:
            await runner.set_connected(player_id, True)

    async def unfollow(self, connection: Connection, table_id: str) -> None:
        listener = connection.tables.pop(table_id, None)
        if listener is None:
            return
        runner = self.tables.get(table_id)
        if runner is not None and listener in runner.listeners:
            runner.listeners.remove(listener)  # type: ignore[arg-type]
        key = (table_id, connection.player_id)
        count = self.watchers.get(key, 0) - 1
        if count > 0:
            self.watchers[key] = count
            return
        self.watchers.pop(key, None)
        if runner is not None and table_id not in self._closing and runner.table.seat_of(connection.player_id) is not None:
            with contextlib.suppress(TableError):
                await runner.set_connected(connection.player_id, False)

    async def handle(self, connection: Connection, message: BaseModel) -> None:
        player_id = connection.player_id
        table_id: str = message.table_id  # type: ignore[attr-defined]
        if isinstance(message, p.JoinTableMessage):
            await self.join(connection, table_id)
            return
        runner = self._runner(table_id)
        if table_id not in connection.tables:
            raise RequestError(p.ErrorCode.NOT_SUBSCRIBED, "join the table first")
        if isinstance(message, p.RefreshMessage):
            async with runner.lock:
                connection.send(p.TableMessage(type="table", table_id=table_id, view=table_view(runner, player_id), events=[]))
        elif isinstance(message, p.LeaveTableMessage):
            if runner.table.seat_of(player_id) is not None:
                await runner.leave(player_id)
            await self.unfollow(connection, table_id)
            connection.send(p.LeftTableMessage(type="left_table", table_id=table_id))
        elif isinstance(message, p.SitMessage):
            await self.pay_in(player_id, message.buy_in, "buy_in", table_id)
            try:
                await runner.sit(message.seat, player_id, connection.name, message.buy_in)
            except BaseException:
                await self.refund(player_id, message.buy_in, table_id)
                raise
        elif isinstance(message, p.SitOutMessage):
            await runner.sit_out(player_id)
        elif isinstance(message, p.SitInMessage):
            await runner.sit_in(player_id)
        elif isinstance(message, p.RebuyMessage):
            await self.pay_in(player_id, message.amount, "rebuy", table_id)
            try:
                await runner.rebuy(player_id, message.amount)
            except BaseException:
                await self.refund(player_id, message.amount, table_id)
                raise
        elif isinstance(message, p.ActMessage):
            kind = ActionKind(message.action.value)
            if (kind in (ActionKind.BET, ActionKind.RAISE)) != (message.amount is not None):
                raise RequestError(p.ErrorCode.BAD_REQUEST, "bets and raises need an amount, other actions none")
            await runner.act(player_id, Action(kind, message.amount), message.seq)

    async def close_connection(self, connection: Connection) -> None:
        connection.closed = True
        self.connections.discard(connection)
        for table_id in list(connection.tables):
            await self.unfollow(connection, table_id)


def _error(code: object, message: str, table_id: str | None = None) -> p.ErrorMessage:
    return p.ErrorMessage(type="error", code=p.ErrorCode(str(code)), message=message, table_id=table_id)


RELOAD_MESSAGE = "RiverMind Poker was updated. Reload the page to keep playing."
NO_SESSION_MESSAGE = "Your session has ended. Reload the page to start a new one."
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

LEGACY_CLOSED = (
    "The short-deck tables have closed: RiverMind Poker now plays no-limit hold'em. Reload the page to play."
)


def _message_type(text: str) -> object:
    try:
        message = json.loads(text)
    except ValueError:
        return None
    return message.get("type") if isinstance(message, dict) else None


def _is_token_hello(text: str) -> bool:
    """A hello from a Phase 3 page, which sent its bearer token instead of a cookie."""
    try:
        message = json.loads(text)
    except ValueError:
        return False
    return isinstance(message, dict) and message.get("type") == "hello" and "token" in message


def _cookie_is_secure(scheme: str, host: str | None) -> bool:
    """Secure everywhere except plain HTTP on this machine, where browsers would drop it."""
    return not (scheme in ("http", "ws") and auth.is_loopback(host or ""))


def _describe_invalid(text: str) -> str:
    try:
        message = json.loads(text)
    except ValueError:
        return "Messages are JSON objects with a type."
    if not isinstance(message, dict) or "type" not in message:
        return "Messages are JSON objects with a type."
    return f"Invalid {message['type']} message."


def create_app(
    *,
    secret: bytes | None = None,
    bots: Mapping[str, Policy] | None = None,
    options: RunnerOptions | None = None,
    max_tables: int = 200,
    idle_seconds: float = 24 * 3600,
    client_dir: str | None = None,
    store: TableStore | None = None,
    players: PlayerStore | None = None,
    wallet: Wallet | None = None,
    allowed_origins: Iterable[str] = (),
) -> FastAPI:
    """Build the no-limit table server.

    ``secret`` signs session cookies; without one a random secret is made,
    so sessions last only as long as the process. With ``client_dir`` (the
    SvelteKit build) the app also serves the client, as Caddy does live.
    With ``store`` tables are saved to PostgreSQL and restored at startup,
    and players are stored there too, unless ``players`` says otherwise;
    without one both live only in memory. Pages on ``allowed_origins``
    (such as ``https://example.com``) may use the API besides the server's
    own origin.
    """
    if secret is None:
        log.warning("No secret given: sessions will not survive a restart")
        secret = secrets.token_bytes(32)
    if options is None:
        options = RunnerOptions(require_person=True)
    server = Server(
        secret, bots if bots is not None else default_bots(), options, max_tables, idle_seconds, store, players, wallet
    )
    origins = frozenset(origin.rstrip("/") for origin in allowed_origins)

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await server.start()
        yield
        await server.stop()

    app = FastAPI(title="RiverMind Poker", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.server = server
    client = Path(client_dir).resolve() if client_dir else None
    if client is not None and not (client / "200.html").is_file():
        raise ValueError(f"{client} has no 200.html; build the web client first.")

    @app.middleware("http")
    async def client_headers(request: Request, call_next):  # type: ignore[no-untyped-def]
        if request.method not in SAFE_METHODS and not auth.origin_allowed(
            request.headers.get("origin"), request.headers.get("host"), origins
        ):
            return JSONResponse(p.HttpError(detail="Requests from other sites are not allowed.").model_dump(), status_code=403)
        response = await call_next(request)
        path = request.url.path
        if client is not None and not path.startswith("/api/"):
            for name, value in CLIENT_HEADERS.items():
                response.headers[name] = value
            ws = ("wss://" if request.url.scheme == "https" else "ws://") + request.url.netloc
            response.headers["Content-Security-Policy"] = CSP.format(ws=ws)
            response.headers["Cache-Control"] = (
                "public, max-age=31536000, immutable"
                if path.startswith("/_app/immutable/") and response.status_code == 200
                else "no-cache"
            )
        return response

    @app.exception_handler(RequestValidationError)
    async def bad_body(request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(part) for part in first.get("loc", ()) if part != "body")
        detail = f"Invalid request body: {where or 'body'}: {first.get('msg', 'invalid')}"
        return JSONResponse(p.HttpError(detail=detail).model_dump(), status_code=400)

    async def player_of(request: Request) -> PlayerRecord:
        session = await server.session_player(request.cookies.get(auth.COOKIE_NAME))
        if session is None:
            raise HTTPException(401, NO_SESSION_MESSAGE)
        return session[0]

    @app.get("/api/config", response_model=p.ConfigResponse)
    async def config() -> p.ConfigResponse:
        return p.ConfigResponse(
            protocol=p.PROTOCOL_VERSION,
            bots=[p.BotOption(kind=kind, label=BOT_LABELS.get(kind, kind)) for kind in server.bots],
            seat_counts=list(range(2, 10)),
            stakes=[p.Stakes(small_blind=small, big_blind=big) for small, big in STAKES],
        )

    @app.post("/api/session", response_model=p.SessionResponse, responses={403: {"model": p.HttpError}})
    async def session(request: Request, response: Response, body: p.SessionRequest | None = None) -> p.SessionResponse:
        """The player this browser is, made on the first visit, with a fresh session cookie."""
        now = time.time()
        current = await server.session_player(request.cookies.get(auth.COOKIE_NAME))
        record, issued = current if current is not None else (None, 0)
        created = False
        if record is None and body is not None and body.legacy_token:
            legacy_id = auth.verify(server.secret, body.legacy_token)
            if legacy_id is not None:
                record = await asyncio.to_thread(server.players.claim, legacy_id)
        if record is None:
            record = await asyncio.to_thread(server.players.create)
            created = True
        if current is None or now - issued > auth.RENEW_AFTER_SECONDS:
            response.set_cookie(
                auth.COOKIE_NAME,
                auth.issue_session(server.secret, record.player_id, now),
                max_age=auth.SESSION_SECONDS,
                path="/",
                httponly=True,
                secure=_cookie_is_secure(request.url.scheme, request.headers.get("host")),
                samesite="lax",
            )
        await asyncio.to_thread(server.players.seen, record.player_id)
        balance = await asyncio.to_thread(server.wallet.visit, record.player_id, now)
        return p.SessionResponse(player_id=record.player_id, name=record.handle, created=created, balance=balance)

    @app.get("/api/wallet", response_model=p.WalletResponse, responses={401: {"model": p.HttpError}})
    async def wallet(request: Request) -> p.WalletResponse:
        player = await player_of(request)
        balance = await asyncio.to_thread(server.wallet.balance, player.player_id)
        entries = await asyncio.to_thread(server.wallet.entries, player.player_id, 50)
        return p.WalletResponse(
            balance=balance,
            notice=PLAY_MONEY_NOTICE,
            entries=[
                p.LedgerItem(
                    kind=p.LedgerKind(e.kind), amount=e.amount, balance_after=e.balance_after, table_id=e.table_id, at=e.at
                )
                for e in entries
            ],
        )

    @app.post(
        "/api/tables",
        status_code=201,
        response_model=p.NewTableResponse,
        responses={400: {"model": p.HttpError}, 401: {"model": p.HttpError}, 503: {"model": p.HttpError}},
    )
    async def new_table(body: p.NewTableRequest, request: Request) -> p.NewTableResponse:
        player = await player_of(request)
        table_id, seat = await server.create_table(player, body)
        return p.NewTableResponse(table_id=table_id, seat=seat)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(p.HttpError(detail=str(exc.detail)).model_dump(), status_code=exc.status_code)

    @app.websocket("/ws")
    async def socket(ws: WebSocket) -> None:
        # Browsers always send Origin on a handshake; refusing before accepting answers 403.
        if not auth.origin_allowed(ws.headers.get("origin"), ws.headers.get("host"), origins):
            await ws.close(code=1008)
            return
        await ws.accept()
        raw = ""
        try:
            raw = await asyncio.wait_for(ws.receive_text(), 30)
            if _is_token_hello(raw):
                # A page loaded before P4.1: its token no longer opens a socket.
                with contextlib.suppress(Exception):
                    await ws.send_text(_error("unauthorized", RELOAD_MESSAGE).model_dump_json())
                    await ws.close(code=1008)
                return
            p.HelloMessage.model_validate_json(raw)
        except (TimeoutError, ValidationError, WebSocketDisconnect):
            # A page of the short-deck prototype still open since the cutover
            # (P3.7) joins with v1's `join`; its client shows unknown_table
            # as a closed table and returns to its lobby.
            legacy = _message_type(raw) == "join"
            error = (
                _error("unknown_table", LEGACY_CLOSED)
                if legacy
                else _error("bad_request", "Send a hello message first.")
            )
            with contextlib.suppress(Exception):
                await ws.send_text(error.model_dump_json())
                await ws.close(code=1008)
            return
        session = await server.session_player(ws.cookies.get(auth.COOKIE_NAME))
        if session is None:
            await ws.send_text(_error("unauthorized", NO_SESSION_MESSAGE).model_dump_json())
            await ws.close(code=1008)
            return
        player = session[0]
        connection = Connection(ws, player.player_id, player.handle)
        server.connections.add(connection)
        connection.send(
            p.WelcomeMessage(type="welcome", protocol=p.PROTOCOL_VERSION, player_id=player.player_id, name=player.handle)
        )

        async def sender() -> None:
            while True:
                message = await connection.queue.get()
                if message is None:
                    await ws.close(code=1013)
                    return
                await ws.send_text(message.model_dump_json())

        sending = asyncio.create_task(sender())
        try:
            while True:
                receiving = asyncio.ensure_future(ws.receive_text())
                done, _ = await asyncio.wait({receiving, sending}, return_when=asyncio.FIRST_COMPLETED)
                if sending in done:
                    receiving.cancel()
                    break
                text = receiving.result()
                try:
                    message = p.ClientMessage.model_validate_json(text).root
                except ValidationError:
                    connection.send(_error("bad_request", _describe_invalid(text)))
                    continue
                try:
                    await server.handle(connection, message)
                except (TableError, RequestError) as error:
                    connection.send(_error(error.code, str(error), message.table_id))
        except WebSocketDisconnect:
            pass
        finally:
            sending.cancel()
            await server.close_connection(connection)

    if client is not None:

        @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
        async def client_file(path: str) -> FileResponse:
            if path.startswith("api/"):
                raise HTTPException(404, "Not found.")
            target = (client / path).resolve()
            if path and target.is_file() and target.is_relative_to(client):
                return FileResponse(target)
            if path.startswith("_app/"):
                raise HTTPException(404, "Not found.")
            return FileResponse(client / "200.html", media_type="text/html")

    return app
