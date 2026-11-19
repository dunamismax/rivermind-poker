"""Anonymous players and their display handles (P4.1).

A first visit makes a player with a random handle such as ``Quiet Heron 42``.
``MemoryPlayers`` keeps them for a server without a database, and
``DatabasePlayers`` stores them in the ``players`` table. Both are
synchronous; the app calls the database store in a worker thread.
"""

from __future__ import annotations

import secrets
import threading
from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import Engine, func, select, update
from sqlalchemy.dialects.postgresql import insert

from rivermind.db import Player

from . import auth
from .safety import handle_allowed

ADJECTIVES = (
    "Amber", "Arctic", "Bold", "Brave", "Bright", "Calm", "Clever", "Cosmic", "Crimson", "Daring",
    "Dusky", "Eager", "Fabled", "Fierce", "Gentle", "Gilded", "Golden", "Grand", "Happy", "Hidden",
    "Humble", "Iron", "Jade", "Jolly", "Keen", "Lucky", "Lunar", "Mellow", "Merry", "Misty",
    "Noble", "Nimble", "Patient", "Plucky", "Proud", "Quick", "Quiet", "Rapid", "Royal", "Rustic",
    "Sharp", "Silent", "Silver", "Sly", "Solar", "Steady", "Stormy", "Sunny", "Swift", "Tidy",
    "Valiant", "Velvet", "Vivid", "Wandering", "Wild", "Wily", "Wise", "Witty", "Young", "Zesty",
)  # fmt: skip
ANIMALS = (
    "Badger", "Bear", "Bison", "Cobra", "Condor", "Coyote", "Crane", "Dolphin", "Eagle", "Falcon",
    "Ferret", "Finch", "Fox", "Gecko", "Gull", "Hare", "Hawk", "Heron", "Ibis", "Jackal",
    "Jaguar", "Kestrel", "Koala", "Lark", "Lemur", "Leopard", "Lion", "Lynx", "Magpie", "Marten",
    "Mink", "Moose", "Newt", "Ocelot", "Orca", "Osprey", "Otter", "Owl", "Panda", "Panther",
    "Pelican", "Puffin", "Puma", "Raven", "Robin", "Salmon", "Seal", "Shark", "Sparrow", "Stag",
    "Stoat", "Swan", "Tiger", "Toucan", "Trout", "Turtle", "Viper", "Walrus", "Wolf", "Wren",
)  # fmt: skip
HANDLE_ATTEMPTS = 8


def random_handle() -> str:
    """A handle like ``Quiet Heron 42``: one of 360,000, chosen with ``secrets``, never a blocked word (P4.5)."""
    while True:
        handle = f"{secrets.choice(ADJECTIVES)} {secrets.choice(ANIMALS)} {secrets.randbelow(100)}"
        if handle_allowed(handle):
            return handle


@dataclass(frozen=True, slots=True)
class PlayerRecord:
    player_id: str
    handle: str


class PlayerStore(Protocol):
    def create(self) -> PlayerRecord:
        """A new player with a handle no one else has."""
        ...

    def claim(self, player_id: str) -> PlayerRecord:
        """The player with this id, made with their Phase 3 guest handle if missing."""
        ...

    def get(self, player_id: str) -> PlayerRecord | None: ...

    def seen(self, player_id: str) -> None:
        """Record a visit."""
        ...

    def rename(self, player_id: str) -> PlayerRecord:
        """Give a player a new random handle, as moderation does for a reported one (P4.5)."""
        ...


class HandleTaken(Exception):
    pass


class MemoryPlayers:
    """Players for a server without a database: they last as long as the process."""

    def __init__(self) -> None:
        self._players: dict[str, PlayerRecord] = {}
        self._handles: set[str] = set()
        self._lock = threading.Lock()

    def _add(self, player_id: str, handle: str) -> PlayerRecord:
        if handle in self._handles:
            raise HandleTaken(handle)
        record = PlayerRecord(player_id, handle)
        self._players[player_id] = record
        self._handles.add(handle)
        return record

    def create(self) -> PlayerRecord:
        with self._lock:
            for _ in range(HANDLE_ATTEMPTS):
                try:
                    return self._add(auth.new_player_id(), random_handle())
                except HandleTaken:
                    continue
        raise RuntimeError("could not find a free handle")

    def claim(self, player_id: str) -> PlayerRecord:
        with self._lock:
            existing = self._players.get(player_id)
            if existing is not None:
                return existing
            handle = auth.guest_name(player_id)
            if handle in self._handles:
                handle = f"{handle} {player_id[2:6]}"
            return self._add(player_id, handle)

    def get(self, player_id: str) -> PlayerRecord | None:
        return self._players.get(player_id)

    def seen(self, player_id: str) -> None:
        return None

    def rename(self, player_id: str) -> PlayerRecord:
        with self._lock:
            old = self._players[player_id]
            for _ in range(HANDLE_ATTEMPTS):
                handle = random_handle()
                if handle not in self._handles:
                    self._handles.discard(old.handle)
                    self._handles.add(handle)
                    record = self._players[player_id] = PlayerRecord(player_id, handle)
                    return record
        raise RuntimeError("could not find a free handle")


class DatabasePlayers:
    """Players in the ``players`` table."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def _insert(self, player_id: str, handle: str) -> bool:
        with self.engine.begin() as conn:
            inserted = conn.execute(
                insert(Player).values(id=player_id, handle=handle).on_conflict_do_nothing().returning(Player.id)
            ).scalar_one_or_none()
            return inserted is not None

    def create(self) -> PlayerRecord:
        for _ in range(HANDLE_ATTEMPTS):
            player_id, handle = auth.new_player_id(), random_handle()
            if self._insert(player_id, handle):
                return PlayerRecord(player_id, handle)
        raise RuntimeError("could not find a free handle")

    def claim(self, player_id: str) -> PlayerRecord:
        existing = self.get(player_id)
        if existing is not None:
            return existing
        handle = auth.guest_name(player_id)
        if not self._insert(player_id, handle):
            self._insert(player_id, f"{handle} {player_id[2:6]}")
        record = self.get(player_id)
        if record is None:
            raise RuntimeError(f"could not store player {player_id}")
        return record

    def get(self, player_id: str) -> PlayerRecord | None:
        with self.engine.connect() as conn:
            handle = conn.execute(select(Player.handle).where(Player.id == player_id)).scalar_one_or_none()
        return None if handle is None else PlayerRecord(player_id, handle)

    def seen(self, player_id: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(update(Player).where(Player.id == player_id).values(last_seen_at=func.now()))

    def rename(self, player_id: str) -> PlayerRecord:
        if self.get(player_id) is None:
            raise KeyError(player_id)
        for _ in range(HANDLE_ATTEMPTS):
            handle = random_handle()
            with self.engine.begin() as conn:
                taken = conn.execute(select(Player.id).where(Player.handle == handle)).first()
                if taken is None:
                    conn.execute(update(Player).where(Player.id == player_id).values(handle=handle))
                    return PlayerRecord(player_id, handle)
        raise RuntimeError("could not find a free handle")
