"""SQLite persistence for open tables, so they survive server restarts.

One row per table holds its opponents, when it was last active and its
pickled `Table.snapshot()`. The server writes a row after every change, so
a crash or restart loses nothing a player saw. Rows contain seat tokens and
are unpickled on load: keep the file private to the service (the systemd
unit's state directory is mode 0700) and never load a file from elsewhere.
"""
from __future__ import annotations

import pickle
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, Iterator, Tuple, Union

SCHEMA = """
CREATE TABLE IF NOT EXISTS tables (
    id TEXT PRIMARY KEY,
    opponents TEXT NOT NULL,
    last_active REAL NOT NULL,
    snapshot BLOB NOT NULL
)
"""


class TableStore:
    """Thread-safe SQLite store of table snapshots."""

    def __init__(self, path: Union[str, Path]):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(
            str(path), check_same_thread=False, isolation_level=None
        )
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.execute(SCHEMA)

    def save(self, table_id: str, opponents: str, last_active: float,
             snapshot: Dict[str, Any]):
        blob = pickle.dumps(snapshot, protocol=pickle.HIGHEST_PROTOCOL)
        with self._lock:
            self._db.execute(
                "INSERT INTO tables (id, opponents, last_active, snapshot) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                "opponents=excluded.opponents, last_active=excluded.last_active, "
                "snapshot=excluded.snapshot",
                (table_id, opponents, last_active, blob),
            )

    def delete(self, table_id: str):
        with self._lock:
            self._db.execute("DELETE FROM tables WHERE id = ?", (table_id,))

    def rows(self) -> Iterator[Tuple[str, str, float, bytes]]:
        """(id, opponents, last_active, pickled snapshot) for every table."""
        with self._lock:
            rows = self._db.execute(
                "SELECT id, opponents, last_active, snapshot FROM tables"
            ).fetchall()
        yield from rows

    def close(self):
        with self._lock:
            self._db.close()
