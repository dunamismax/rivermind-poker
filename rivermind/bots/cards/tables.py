"""Load a set of card tables and look up buckets (P5.2, ``docs/bots.md``)."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np

from .build import FORMAT, KIND, STREETS, file_hashes
from .equity import INVALID
from .iso import PERMS, pair_index, ranks_of, set_rank

_PERM_ARRAY = np.array(PERMS, dtype=np.int64)

STREET_OF_BOARD = {0: "preflop", 3: "flop", 4: "turn", 5: "river"}


class TableError(ValueError):
    """The table set is missing, damaged or does not cover the hand asked for."""


class CardTables:
    """A table set opened read-only and memory-mapped, so processes share its pages."""

    def __init__(self, path: str | Path, *, verify: bool = False) -> None:
        self.path = Path(path)
        try:
            self.manifest: dict[str, Any] = json.loads((self.path / "manifest.json").read_text())
        except (OSError, ValueError) as e:
            raise TableError(f"{self.path} has no readable manifest.json") from e
        if self.manifest.get("kind") != KIND or self.manifest.get("format") != FORMAT:
            raise TableError(f"{self.path} is not a format {FORMAT} card table set")
        if verify:
            bad = verify_files(self.path, self.manifest)
            if bad:
                raise TableError(f"files differ from the manifest: {', '.join(bad)}")
        self.preflop = np.load(self.path / "preflop.npy", mmap_mode="r")
        self.board_class: dict[str, np.ndarray] = {}
        self.board_perm: dict[str, np.ndarray] = {}
        self.buckets: dict[str, np.ndarray] = {}
        for street in STREETS:
            self.board_class[street] = np.load(self.path / f"{street}_board_class.npy", mmap_mode="r")
            self.board_perm[street] = np.load(self.path / f"{street}_board_perm.npy", mmap_mode="r")
            self.buckets[street] = np.load(self.path / f"{street}.npy", mmap_mode="r")

    @property
    def sha256(self) -> dict[str, str]:
        return {name: entry["sha256"] for name, entry in self.manifest["files"].items()}

    def bucket_count(self, street: str) -> int:
        if street == "preflop":
            return 169
        return int(self.manifest["settings"][f"{street}_buckets"])

    def bucket(self, hole: Sequence[int], board: Sequence[int] = ()) -> int:
        """The bucket of the hole cards on a board of 0, 3, 4 or 5 cards."""
        street = STREET_OF_BOARD.get(len(board))
        cards = (*hole, *board)
        if street is None or len(hole) != 2 or len(set(cards)) != len(cards) or not all(0 <= c < 52 for c in cards):
            raise TableError("two hole cards and a board of 0, 3, 4 or 5 other cards are needed")
        a, b = hole
        if street == "preflop":
            return int(self.preflop[pair_index(a, b)])
        rank = set_rank(board)
        cls = int(self.board_class[street][rank])
        perm = PERMS[int(self.board_perm[street][rank])]
        table = self.buckets[street]
        if cls >= len(table):
            raise TableError(f"this table set was built with a limit and lacks {street} board class {cls}")
        mapped = pair_index((a & ~3) | perm[a & 3], (b & ~3) | perm[b & 3])
        value = int(table[cls, mapped])
        if value == int(INVALID):
            raise TableError("the hand collides with the board")
        return value


    def buckets_many(self, holes: np.ndarray, boards: np.ndarray | None = None) -> np.ndarray:
        """Buckets for rows of hole cards ``(n, 2)`` on rows of boards ``(n, 0, 3, 4 or 5)``.

        Each row must hold distinct cards; a hand colliding with its board
        gives ``INVALID``. This is ``bucket`` for many hands at once.
        """
        holes = np.asarray(holes, dtype=np.int64)
        size = 0 if boards is None else int(np.asarray(boards).shape[1])
        street = STREET_OF_BOARD.get(size)
        if street is None or holes.ndim != 2 or holes.shape[1] != 2:
            raise TableError("hole cards (n, 2) and boards of 0, 3, 4 or 5 cards are needed")
        if street == "preflop":
            lo, hi = np.minimum(holes[:, 0], holes[:, 1]), np.maximum(holes[:, 0], holes[:, 1])
            return np.asarray(self.preflop)[hi * (hi - 1) // 2 + lo].astype(np.int64)
        assert boards is not None
        ranks = ranks_of(np.sort(np.asarray(boards, dtype=np.int64), axis=1))
        cls = np.asarray(self.board_class[street][ranks]).astype(np.int64)
        perm = _PERM_ARRAY[np.asarray(self.board_perm[street][ranks]).astype(np.int64)]
        if int(cls.max(initial=0)) >= len(self.buckets[street]):
            raise TableError(f"this table set was built with a limit and lacks some {street} board classes")
        mapped = (holes & ~3) | np.take_along_axis(perm, holes & 3, axis=1)
        lo, hi = np.minimum(mapped[:, 0], mapped[:, 1]), np.maximum(mapped[:, 0], mapped[:, 1])
        return np.asarray(self.buckets[street][cls, hi * (hi - 1) // 2 + lo]).astype(np.int64)


def verify_files(path: Path, manifest: dict[str, Any] | None = None) -> list[str]:
    """Names of files that are missing, extra or differ from the manifest's SHA-256s."""
    if manifest is None:
        manifest = json.loads((Path(path) / "manifest.json").read_text())
    expected = {name: entry["sha256"] for name, entry in manifest["files"].items()}
    found = {name: entry["sha256"] for name, entry in file_hashes(Path(path)).items()}
    return sorted(name for name in expected.keys() | found.keys() if expected.get(name) != found.get(name))
