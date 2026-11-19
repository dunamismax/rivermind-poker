"""Safety and abuse controls for the table server (P4.5).

- **Rate limits.** ``RateLimiter`` is a token bucket per key. ``Limits``
  holds the app's limits: unsafe HTTP requests per player (or per network
  address without a session), new players per address, socket messages per
  connection, reactions and reports per player. Caddy limits the same
  endpoints per address in front of the app; these limits also hold when the
  app is reached some other way and per player behind one address.
- **Handles.** Handles are made from fixed word lists, so none can be
  offensive, but ``handle_allowed`` checks every handle the server makes or
  gives out against a list of blocked words (with common letter swaps
  undone and spaced-out letters read together), so a future word or a renamed handle cannot slip through.
- **Reactions.** There is no free-text chat (Q-4): seated people can send one
  of ``REACTIONS``, shown beside their seat. Reactions are not table events
  and are not stored.
- **Reports, mutes and blocks.** A player can report another for their
  handle, abuse or collusion, for later review (``rivermind-poker
  moderation``). Muting hides someone's reactions; blocking also hides them
  and keeps quick seat from putting the two at one table. Players are named
  to each other by a public reference (``auth.public_ref``), never their id.
- **Collusion signals.** When two people sit at one table from the same
  network address, a ``same_address`` signal is stored for review. Addresses
  are stored only as keyed hashes (``address_tag``), never in the clear.

``MemorySafety`` keeps reports, relations and signals for a server without a
database, and ``DatabaseSafety`` keeps them in PostgreSQL (migration 0004).
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re
import threading
import time
import unicodedata
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any, Protocol

from sqlalchemy import Engine, delete, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from rivermind.db import Player, PlayerRelation, PlayerReport, SafetySignal


class RateLimiter:
    """Token buckets: each key may spend ``burst`` at once, refilled at ``rate`` per second."""

    def __init__(self, rate: float, burst: float, clock: Callable[[], float] = time.monotonic) -> None:
        if rate <= 0 or burst < 1:
            raise ValueError("a rate limit needs a positive rate and a burst of at least 1")
        self.rate = rate
        self.burst = burst
        self.clock = clock
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()
        self._next_prune = clock() + 60

    def allow(self, key: str, cost: float = 1.0) -> bool:
        """Spend ``cost`` from ``key``'s bucket if it holds that much."""
        now = self.clock()
        with self._lock:
            tokens, then = self._buckets.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - then) * self.rate)
            allowed = tokens >= cost
            if allowed:
                tokens -= cost
            self._buckets[key] = (tokens, now)
            if now >= self._next_prune:
                self._prune(now)
            return allowed

    def retry_after(self, key: str) -> float:
        """Seconds until ``key`` may spend one token."""
        with self._lock:
            tokens, then = self._buckets.get(key, (self.burst, self.clock()))
        tokens = min(self.burst, tokens + (self.clock() - then) * self.rate)
        return max(0.0, (1 - tokens) / self.rate)

    def _prune(self, now: float) -> None:
        # A bucket that would be full again is the same as no bucket.
        full = self.burst / self.rate
        self._buckets = {k: v for k, v in self._buckets.items() if now - v[1] < full}
        self._next_prune = now + 60


@dataclass(frozen=True)
class Limits:
    """The app's rate limits. Rates are per second."""

    http_rate: float = 2.0
    """Unsafe HTTP requests per player, or per address without a session."""
    http_burst: float = 60
    new_player_rate: float = 0.5
    """Players made (``POST /api/session`` without a session) per address."""
    new_player_burst: float = 30
    socket_rate: float = 10.0
    """Messages per socket after the hello."""
    socket_burst: float = 60
    socket_strikes: int = 50
    """Refused messages in a row before the socket is closed."""
    reaction_rate: float = 1 / 3
    """Reactions per player."""
    reaction_burst: float = 3
    report_rate: float = 1 / 60
    """Reports per player."""
    report_burst: float = 5
    clock: Callable[[], float] = field(default=time.monotonic, compare=False)


UNLIMITED = Limits(
    http_rate=1e9,
    http_burst=1e9,
    new_player_rate=1e9,
    new_player_burst=1e9,
    socket_rate=1e9,
    socket_burst=1e9,
    reaction_rate=1e9,
    reaction_burst=1e9,
    report_rate=1e9,
    report_burst=1e9,
)
"""No limits, for tests that send requests faster than people could."""


class Limiters:
    """One ``RateLimiter`` per limit in ``Limits``."""

    def __init__(self, limits: Limits) -> None:
        self.limits = limits
        clock = limits.clock
        self.http = RateLimiter(limits.http_rate, limits.http_burst, clock)
        self.new_player = RateLimiter(limits.new_player_rate, limits.new_player_burst, clock)
        self.reaction = RateLimiter(limits.reaction_rate, limits.reaction_burst, clock)
        self.report = RateLimiter(limits.report_rate, limits.report_burst, clock)

    def socket(self) -> RateLimiter:
        """A bucket for one socket."""
        return RateLimiter(self.limits.socket_rate, self.limits.socket_burst, self.limits.clock)


# Network addresses


def client_address(peer: str | None, forwarded_for: str | None) -> str:
    """The address a request came from.

    Caddy, on the same machine, puts the client's address last in
    ``X-Forwarded-For`` (it replaces whatever the client sent). The header is
    trusted only from a loopback peer, so a client reaching the app directly
    cannot choose its own address.
    """
    peer = peer or "unknown"
    if forwarded_for:
        try:
            trusted = ipaddress.ip_address(peer).is_loopback
        except ValueError:
            trusted = False
        if trusted:
            last = forwarded_for.rsplit(",", 1)[-1].strip()
            if last:
                return last
    return peer


def address_tag(secret: bytes, address: str) -> str:
    """A keyed hash of an address: equal addresses match, but the address is not stored."""
    return hmac.new(secret, f"address:{address}".encode(), hashlib.sha256).hexdigest()[:24]


# Handles

_BLOCKED_WORDS = (
    "anal", "anus", "arse", "bastard", "bitch", "bollock", "boner", "boob", "cock", "coon",
    "crap", "cunt", "dick", "dildo", "dyke", "fag", "fuck", "gook", "homo", "jizz", "kike",
    "nazi", "nigg", "nigr", "penis", "piss", "porn", "pussy", "rape", "retard", "shit", "slut",
    "spic", "tits", "twat", "vagina", "wank", "whore", "hitler", "kkk",
)  # fmt: skip
"""Fragments no word of a handle may contain once letter swaps are undone."""
_ALLOWED_WORDS = ("peacock", "cockatoo", "woodcock", "scunthorpe", "grape", "drape", "therapist", "cocktail")
"""Ordinary words that contain a blocked fragment."""
_SWAPS = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i"})


def _words(text: str) -> list[str]:
    """The handle's words with accents dropped and letter swaps undone, and letters spelled out one by one joined."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower().translate(_SWAPS)
    words: list[str] = []
    spelled = ""
    for token in re.split(r"[^a-z]+", text):
        if len(token) == 1:
            spelled += token
            continue
        if spelled:
            words.append(spelled)
            spelled = ""
        if token:
            words.append(token)
    if spelled:
        words.append(spelled)
    return words


def handle_allowed(handle: str) -> bool:
    """Whether a handle is free of blocked words.

    Each word is checked on its own (so ``Lunar Seal`` is not read as
    ``lunarseal``), and letters spaced or dotted apart (``f.u.c.k``) are read
    as one word.
    """
    if not handle.strip() or len(handle) > 32:
        return False
    for word in _words(handle):
        for allowed in _ALLOWED_WORDS:
            word = word.replace(allowed, "")
        if any(blocked in word for blocked in _BLOCKED_WORDS):
            return False
    return True


# Reactions, reports and relations


class Reaction(StrEnum):
    """Preset reactions (Q-4: no free-text chat in 1.0)."""

    HELLO = "hello"
    NICE_HAND = "nice_hand"
    WELL_PLAYED = "well_played"
    GOOD_GAME = "good_game"
    UNLUCKY = "unlucky"
    THANKS = "thanks"
    WOW = "wow"
    THINKING = "thinking"


REACTIONS: Mapping[Reaction, str] = {
    Reaction.HELLO: "Hi!",
    Reaction.NICE_HAND: "Nice hand",
    Reaction.WELL_PLAYED: "Well played",
    Reaction.GOOD_GAME: "Good game",
    Reaction.UNLUCKY: "Unlucky",
    Reaction.THANKS: "Thanks",
    Reaction.WOW: "Wow",
    Reaction.THINKING: "Thinking…",
}


class ReportReason(StrEnum):
    HANDLE = "handle"
    """An offensive handle."""
    ABUSE = "abuse"
    """Spamming reactions or other abuse."""
    COLLUSION = "collusion"
    """Playing together against the others at the table."""
    OTHER = "other"


class RelationKind(StrEnum):
    MUTE = "mute"
    """Hide their reactions."""
    BLOCK = "block"
    """Hide their reactions and keep quick seat from seating the two together."""


REPORT_REPEAT_SECONDS = 24 * 3600
"""A player's report of the same person for the same reason counts once a day."""


@dataclass(frozen=True, slots=True)
class Report:
    reporter_id: str
    target_id: str
    target_handle: str
    reason: str
    table_id: str | None
    hand_no: int | None
    at: float


@dataclass(frozen=True, slots=True)
class Relation:
    target_id: str
    handle: str
    kind: str


@dataclass(frozen=True, slots=True)
class Signal:
    kind: str
    table_id: str | None
    player_ids: tuple[str, ...]
    detail: dict[str, Any]
    at: float


class SafetyStore(Protocol):
    def report(self, report: Report) -> bool:
        """Record a report. False if the same one was made within a day."""
        ...

    def relations(self, player_id: str) -> list[Relation]:
        """Everyone ``player_id`` has muted or blocked."""
        ...

    def set_relation(self, player_id: str, target_id: str, kind: str) -> None: ...

    def remove_relation(self, player_id: str, target_id: str) -> None: ...

    def blocks_involving(self, player_id: str) -> set[str]:
        """Players ``player_id`` blocked or was blocked by."""
        ...

    def signal(self, signal: Signal) -> None: ...

    def reports(self, limit: int) -> list[Report]:
        """The newest reports first."""
        ...

    def signals(self, limit: int) -> list[Signal]:
        """The newest signals first."""
        ...


class MemorySafety:
    """Reports, relations and signals for a server without a database."""

    def __init__(self, handles: Callable[[str], str | None] = lambda _: None) -> None:
        self._handles = handles
        self._reports: list[Report] = []
        self._relations: dict[str, dict[str, str]] = {}
        self._signals: list[Signal] = []
        self._lock = threading.Lock()

    def report(self, report: Report) -> bool:
        with self._lock:
            for old in self._reports:
                if (
                    (old.reporter_id, old.target_id, old.reason) == (report.reporter_id, report.target_id, report.reason)
                    and report.at - old.at < REPORT_REPEAT_SECONDS
                ):
                    return False
            self._reports.append(report)
            return True

    def relations(self, player_id: str) -> list[Relation]:
        with self._lock:
            mine = dict(self._relations.get(player_id, {}))
        return [Relation(target, self._handles(target) or "", kind) for target, kind in mine.items()]

    def set_relation(self, player_id: str, target_id: str, kind: str) -> None:
        with self._lock:
            self._relations.setdefault(player_id, {})[target_id] = kind

    def remove_relation(self, player_id: str, target_id: str) -> None:
        with self._lock:
            self._relations.get(player_id, {}).pop(target_id, None)

    def blocks_involving(self, player_id: str) -> set[str]:
        with self._lock:
            mine = {t for t, k in self._relations.get(player_id, {}).items() if k == RelationKind.BLOCK}
            theirs = {p for p, r in self._relations.items() if r.get(player_id) == RelationKind.BLOCK}
        return mine | theirs

    def signal(self, signal: Signal) -> None:
        with self._lock:
            self._signals.append(signal)

    def reports(self, limit: int) -> list[Report]:
        with self._lock:
            return list(reversed(self._reports))[:limit]

    def signals(self, limit: int) -> list[Signal]:
        with self._lock:
            return list(reversed(self._signals))[:limit]


def _epoch(moment: datetime) -> float:
    return moment.timestamp()


class DatabaseSafety:
    """Reports, relations and signals in PostgreSQL."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def report(self, report: Report) -> bool:
        since = datetime.fromtimestamp(report.at, UTC) - timedelta(seconds=REPORT_REPEAT_SECONDS)
        with self.engine.begin() as conn:
            # One report a day per reporter, target and reason; the lock keeps two at once from both counting.
            conn.execute(select(Player.id).where(Player.id == report.reporter_id).with_for_update())
            repeat = conn.execute(
                select(PlayerReport.id).where(
                    PlayerReport.reporter_id == report.reporter_id,
                    PlayerReport.target_id == report.target_id,
                    PlayerReport.reason == report.reason,
                    PlayerReport.created_at > since,
                )
            ).first()
            if repeat is not None:
                return False
            conn.execute(
                insert(PlayerReport).values(
                    reporter_id=report.reporter_id,
                    target_id=report.target_id,
                    target_handle=report.target_handle,
                    reason=report.reason,
                    table_id=report.table_id,
                    hand_no=report.hand_no,
                    created_at=datetime.fromtimestamp(report.at, UTC),
                )
            )
        return True

    def relations(self, player_id: str) -> list[Relation]:
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(PlayerRelation.target_id, Player.handle, PlayerRelation.kind)
                .join(Player, Player.id == PlayerRelation.target_id)
                .where(PlayerRelation.player_id == player_id)
                .order_by(PlayerRelation.created_at)
            ).all()
        return [Relation(target, handle, kind) for target, handle, kind in rows]

    def set_relation(self, player_id: str, target_id: str, kind: str) -> None:
        statement = insert(PlayerRelation).values(player_id=player_id, target_id=target_id, kind=kind)
        with self.engine.begin() as conn:
            conn.execute(
                statement.on_conflict_do_update(
                    index_elements=[PlayerRelation.player_id, PlayerRelation.target_id], set_={"kind": kind}
                )
            )

    def remove_relation(self, player_id: str, target_id: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                delete(PlayerRelation).where(PlayerRelation.player_id == player_id, PlayerRelation.target_id == target_id)
            )

    def blocks_involving(self, player_id: str) -> set[str]:
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(PlayerRelation.player_id, PlayerRelation.target_id).where(
                    PlayerRelation.kind == RelationKind.BLOCK.value,
                    or_(PlayerRelation.player_id == player_id, PlayerRelation.target_id == player_id),
                )
            ).all()
        return {target if owner == player_id else owner for owner, target in rows}

    def signal(self, signal: Signal) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                insert(SafetySignal).values(
                    kind=signal.kind,
                    table_id=signal.table_id,
                    player_ids=list(signal.player_ids),
                    detail=signal.detail,
                    created_at=datetime.fromtimestamp(signal.at, UTC),
                )
            )

    def reports(self, limit: int) -> list[Report]:
        with Session(self.engine) as session:
            rows = session.scalars(select(PlayerReport).order_by(PlayerReport.id.desc()).limit(limit)).all()
        return [
            Report(r.reporter_id, r.target_id, r.target_handle, r.reason, r.table_id, r.hand_no, _epoch(r.created_at))
            for r in rows
        ]

    def signals(self, limit: int) -> list[Signal]:
        with Session(self.engine) as session:
            rows = session.scalars(select(SafetySignal).order_by(SafetySignal.id.desc()).limit(limit)).all()
        return [Signal(s.kind, s.table_id, tuple(s.player_ids), dict(s.detail), _epoch(s.created_at)) for s in rows]


def pairs(ids: Iterable[str]) -> list[tuple[str, str]]:
    """Every unordered pair of distinct ids, each sorted."""
    unique = sorted(set(ids))
    return [(a, b) for i, a in enumerate(unique) for b in unique[i + 1 :]]
