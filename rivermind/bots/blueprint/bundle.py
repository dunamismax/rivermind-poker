"""Serving bundles: what the Node server reads to play a blueprint (P4B.6, ``docs/bots.md``).

``export_bundle`` turns a checkpoint and its card tables into a directory of
flat little-endian files that need no NumPy to read:

``strategy.u8``
    The average strategy as ``uint8``, one byte a slot in the checkpoint's
    layout (``Game``): each info set's probabilities rounded to multiples of
    1/255, so a bot renormalizes them over the node's actions. An info set
    training never reached stays all zero.
``trees.json``
    Each depth class's compiled tree: player, street, offset, history,
    tokens, children, terminals, width, and the measures and stack-to-pot
    ratios the action mapping uses. A reader recomputes each tree's SHA-256
    from it.
``preflop.u16``, ``<street>_board_class.i32``, ``<street>_board_perm.u8``, ``<street>.u16``
    The card-table arrays a bucket lookup needs, as in ``CardTables``.
``manifest.json``
    The checkpoint (path, iteration, manifest hash, settings), the game
    layout, the table set (its path, seed, files' SHA-256s and their
    digest, ``table_set``), each array's dtype and shape, and every file's
    SHA-256 and size.

``ServingBundle`` reads a bundle back for Python, so the reference
``BlueprintPolicy`` can play exactly what Node serves; the TypeScript
reader is ``web/src/lib/server/bots/bundle.ts``.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import numpy as np

from rivermind.bots.cards import CardTables
from rivermind.bots.cards.build import STREETS
from rivermind.bots.cards.equity import INVALID
from rivermind.bots.cards.iso import PERMS, pair_index, set_rank
from rivermind.bots.cards.tables import STREET_OF_BOARD, TableError

from .blueprint import Blueprint
from .game import Game
from .tree import Tree, compile_tree

FORMAT = 1
KIND = "rivermind-serving-bundle"
LEVELS = 255
"""A served probability is a multiple of 1/255."""

ARRAYS: dict[str, str] = {
    "preflop.u16": "<u2",
    **{f"{s}_board_class.i32": "<i4" for s in STREETS},
    **{f"{s}_board_perm.u8": "u1" for s in STREETS},
    **{f"{s}.u16": "<u2" for s in STREETS},
}
"""Card-table arrays: bundle file name and little-endian dtype."""
STRATEGY = "strategy.u8"
TREES = "trees.json"


class BundleError(ValueError):
    """The bundle is missing, damaged or does not match what it is checked against."""


def table_set_digest(sha256: Mapping[str, str]) -> str:
    """One SHA-256 naming a table set: over its files' SHA-256s, as sorted compact JSON."""
    return hashlib.sha256(json.dumps(dict(sha256), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def tree_document(tree: Tree) -> dict[str, Any]:
    """A tree as ``trees.json`` stores it."""
    return {
        "abstraction": tree.abstraction,
        "depth": tree.depth,
        "small_blind": tree.small_blind,
        "big_blind": tree.big_blind,
        "sha256": tree.sha256,
        "width": list(tree.width),
        "history": tree.history,
        "player": tree.player,
        "street": tree.street,
        "offset": tree.offset,
        "tokens": [list(t) for t in tree.tokens],
        "children": [list(c) for c in tree.children],
        "terminal_kind": tree.terminal_kind,
        "terminal_value": tree.terminal_value,
        "measure": [list(m) for m in tree.measure],
        "spr": tree.spr,
    }


def quantize(game: Game, sums: np.ndarray) -> np.ndarray:
    """Average-strategy sums as ``uint8`` probabilities, one info set at a time."""
    out = np.zeros(game.size, dtype=np.uint8)
    for d, s, start, stop in game.slices():
        tree = game.trees[d]
        width = tree.width[s]
        if width == 0:
            continue
        nodes = [v for v in range(len(tree)) if tree.street[v] == s]
        offsets = np.array([tree.offset[v] for v in nodes], dtype=np.int64)
        counts = np.array([len(tree.children[v]) for v in nodes], dtype=np.int64)
        order = np.argsort(offsets, kind="stable")
        offsets, counts = offsets[order], counts[order]
        block = np.asarray(sums[start:stop], dtype=np.float64).reshape(game.buckets[s], width)
        totals = np.repeat(np.add.reduceat(block, offsets, axis=1), counts, axis=1)
        with np.errstate(invalid="ignore", divide="ignore"):
            q = np.where(totals > 0, np.rint(LEVELS * block / totals), 0)
        out[start:stop] = q.astype(np.uint8).reshape(-1)
    return out


def _file_entry(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 22), b""):
            digest.update(block)
    return {"sha256": digest.hexdigest(), "bytes": path.stat().st_size}


def _git_commit() -> str | None:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True, cwd=Path(__file__).parent)
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.stdout.strip() or None


def _write(out: Path, game: Game, strategy: np.ndarray, arrays: Mapping[str, np.ndarray], meta: dict[str, Any]) -> dict[str, Any]:
    """Write a bundle to ``out`` through ``out.partial`` and return its manifest."""
    if out.exists():
        raise FileExistsError(f"{out} already exists")
    partial = out.with_name(out.name + ".partial")
    if partial.exists():
        shutil.rmtree(partial)
    partial.mkdir(parents=True)
    try:
        strategy.astype(np.uint8).tofile(partial / STRATEGY)
        (partial / TREES).write_text(json.dumps([tree_document(t) for t in game.trees], separators=(",", ":")))
        shapes: dict[str, Any] = {}
        for name, dtype in ARRAYS.items():
            array = np.ascontiguousarray(arrays[name], dtype=dtype)
            array.tofile(partial / name)
            shapes[name] = {"dtype": dtype, "shape": list(array.shape)}
        manifest = {
            "format": FORMAT,
            "kind": KIND,
            "abstraction": game.trees[0].abstraction,
            **meta,
            "game": game.describe(),
            "strategy": {"file": STRATEGY, "levels": LEVELS},
            "arrays": shapes,
            "software": {"python": platform.python_version(), "numpy": np.__version__, "git_commit": _git_commit()},
            "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "files": {p.name: _file_entry(p) for p in sorted(partial.iterdir()) if p.is_file()},
        }
        (partial / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        os.replace(partial, out)
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise
    return manifest


def _table_arrays(tables: CardTables) -> dict[str, np.ndarray]:
    arrays: dict[str, np.ndarray] = {"preflop.u16": np.asarray(tables.preflop)}
    for s in STREETS:
        arrays[f"{s}_board_class.i32"] = np.asarray(tables.board_class[s])
        arrays[f"{s}_board_perm.u8"] = np.asarray(tables.board_perm[s])
        arrays[f"{s}.u16"] = np.asarray(tables.buckets[s])
    return arrays


def export_bundle(checkpoint: str | Path, out: str | Path, *, tables: str | Path | None = None) -> dict[str, Any]:
    """Export a checkpoint and the card tables it was trained with as a serving bundle."""
    checkpoint = Path(checkpoint)
    bp = Blueprint(checkpoint, verify=True)
    cards = bp.manifest["cards"]
    table_set = CardTables(tables or cards["path"], verify=True)
    if table_set.sha256 != cards["sha256"]:
        raise BundleError("these card tables are not the ones the checkpoint was trained with")
    for s in range(4):
        expected = table_set.bucket_count(("preflop", *STREETS)[s])
        if expected != bp.game.buckets[s]:
            raise BundleError("the card tables' bucket counts differ from the checkpoint's")
    strategy = quantize(bp.game, bp.strategy)
    meta = {
        "checkpoint": {
            "path": str(checkpoint),
            "iteration": bp.iteration,
            "batch": bp.manifest["batch"],
            "manifest_sha256": _file_entry(checkpoint / "manifest.json")["sha256"],
            "strategy_sha256": bp.manifest["files"]["strategy.npy"]["sha256"],
            "settings": bp.manifest["settings"],
            "engine": bp.manifest["engine"],
        },
        "cards": {
            "path": str(table_set.path),
            "seed": cards.get("seed"),
            "table_set": table_set_digest(cards["sha256"]),
            "sha256": cards["sha256"],
            "settings": table_set.manifest["settings"],
            "classes": table_set.manifest["classes"],
        },
    }
    return _write(Path(out), bp.game, strategy, _table_arrays(table_set), meta)


def synthetic_bundle(
    out: str | Path,
    *,
    seed: int = 0,
    buckets: tuple[int, int, int] = (12, 12, 12),
    classes: int = 7,
    untrained: float = 0.1,
    untrained_nodes: float = 0.02,
) -> dict[str, Any]:
    """A bundle with the real hu-m1 trees and random strategies and card tables, for tests and CI.

    Every board falls into one of ``classes`` random classes with a random
    suit permutation, and every info set gets random byte weights, except a
    share ``untrained`` of info sets and ``untrained_nodes`` of whole nodes,
    which stay zero so borrowing and the untrained fallback are exercised.
    """
    rng = np.random.default_rng(seed)
    trees = tuple(compile_tree(d) for d in (50, 100))
    game = Game(trees, (169, *buckets))  # type: ignore[arg-type]
    strategy = rng.integers(0, LEVELS + 1, game.size, dtype=np.int64).astype(np.uint8)
    for d, tree in enumerate(trees):
        for v in range(len(tree)):
            s = tree.street[v]
            n = len(tree.children[v])
            first = game.base[d][s] + tree.offset[v]
            rows = first + np.arange(game.buckets[s])[:, None] * tree.width[s] + np.arange(n)[None, :]
            if rng.random() < untrained_nodes:
                strategy[rows] = 0
                continue
            strategy[rows[rng.random(game.buckets[s]) < untrained]] = 0
    arrays: dict[str, np.ndarray] = {"preflop.u16": rng.integers(0, 169, 1326).astype(np.uint16)}
    for s, size, count in zip(STREETS, (3, 4, 5), buckets):
        boards = {3: 22_100, 4: 270_725, 5: 2_598_960}[size]
        arrays[f"{s}_board_class.i32"] = rng.integers(0, classes, boards).astype(np.int32)
        arrays[f"{s}_board_perm.u8"] = rng.integers(0, len(PERMS), boards).astype(np.uint8)
        arrays[f"{s}.u16"] = rng.integers(0, count, (classes, 1326)).astype(np.uint16)
    fake = {"synthetic": hashlib.sha256(f"synthetic:{seed}".encode()).hexdigest()}
    meta = {
        "checkpoint": {"synthetic": True, "seed": seed},
        "cards": {"synthetic": True, "seed": seed, "table_set": table_set_digest(fake), "sha256": fake},
    }
    return _write(Path(out), game, strategy, arrays, meta)


class BundleTables:
    """A bundle's card-table arrays, looked up as ``CardTables.bucket`` does."""

    def __init__(self, path: Path, manifest: Mapping[str, Any]) -> None:
        self.manifest = manifest
        self.sha256: dict[str, str] = dict(manifest["cards"]["sha256"])

        def load(name: str) -> np.ndarray:
            spec = manifest["arrays"][name]
            return np.memmap(path / name, dtype=spec["dtype"], mode="r", shape=tuple(spec["shape"]))

        self.preflop = load("preflop.u16")
        self.board_class = {s: load(f"{s}_board_class.i32") for s in STREETS}
        self.board_perm = {s: load(f"{s}_board_perm.u8") for s in STREETS}
        self.buckets = {s: load(f"{s}.u16") for s in STREETS}

    def bucket(self, hole: Sequence[int], board: Sequence[int] = ()) -> int:
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
            raise TableError(f"this table set lacks {street} board class {cls}")
        value = int(table[cls, pair_index((a & ~3) | perm[a & 3], (b & ~3) | perm[b & 3])])
        if value == int(INVALID):
            raise TableError("the hand collides with the board")
        return value


class ServingBundle:
    """A serving bundle read back: the ``Blueprint`` and ``CardTables`` a ``BlueprintPolicy`` needs."""

    def __init__(self, path: str | Path, *, verify: bool = True, table_set: str | None = None) -> None:
        self.path = Path(path)
        try:
            self.manifest: dict[str, Any] = json.loads((self.path / "manifest.json").read_text())
        except (OSError, ValueError) as e:
            raise BundleError(f"{self.path} has no readable manifest.json") from e
        if self.manifest.get("kind") != KIND or self.manifest.get("format") != FORMAT:
            raise BundleError(f"{self.path} is not a format {FORMAT} serving bundle")
        if verify:
            expected = {n: e["sha256"] for n, e in self.manifest["files"].items()}
            found = {p.name: _file_entry(p)["sha256"] for p in self.path.iterdir() if p.is_file() and p.name != "manifest.json"}
            bad = sorted(n for n in expected.keys() | found.keys() if expected.get(n) != found.get(n))
            if bad:
                raise BundleError(f"files differ from the manifest: {', '.join(bad)}")
        if table_set is not None and self.manifest["cards"]["table_set"] != table_set:
            raise BundleError("this bundle was not built from the expected card table set")
        layout = self.manifest["game"]
        trees = tuple(compile_tree(t["depth"]) for t in layout["trees"])
        if [t.sha256 for t in trees] != [t["sha256"] for t in layout["trees"]]:
            raise BundleError("this software compiles different trees from the bundle's")
        self.game = Game(trees, tuple(layout["buckets"]))  # type: ignore[arg-type]
        if self.game.size != layout["size"]:
            raise BundleError("the bundle's layout does not match its trees")
        self.strategy = np.memmap(self.path / STRATEGY, dtype=np.uint8, mode="r", shape=(self.game.size,))
        self.tables = BundleTables(self.path, self.manifest)

    def policy(self, **kwargs: Any) -> Any:
        from .policy import BlueprintPolicy

        return BlueprintPolicy(self, self.tables, **kwargs)  # type: ignore[arg-type]


__all__ = [
    "BundleError",
    "BundleTables",
    "ServingBundle",
    "export_bundle",
    "quantize",
    "synthetic_bundle",
    "table_set_digest",
    "tree_document",
]
