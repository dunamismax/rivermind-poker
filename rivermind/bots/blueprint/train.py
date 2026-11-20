"""Train a heads-up blueprint with batched, deterministic MCCFR (P5.3, ``docs/bots.md``).

Training runs in **batches** of ``chunks_per_batch`` chunks of ``chunk_size``
iterations. Every chunk of a batch reads the same regrets, the snapshot left
by the previous batch, and returns its changes (``mccfr.run_chunk``). The
main process then adds them in chunk order, applies the linear-CFR discount
when one is due, and may write a checkpoint. A run is therefore a pure
function of its ``Settings``, its trees and its cards, whatever the number
of worker processes, and it resumes exactly at any checkpoint (RM-02, RM-04).

Regrets are ``int32`` in a memory-mapped file under the run's ``live/``
directory, which workers open read-only. Average-strategy sums are
``float64`` and live only in the main process. A checkpoint is written to a
``.partial`` directory, hashed and renamed into place, then named in
``latest``: an interrupted write leaves the previous checkpoint in charge.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import multiprocessing as mp
import os
import platform
import shutil
import signal
import subprocess
import time
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass, fields
from importlib import metadata
from pathlib import Path
from typing import Any

import numpy as np

from .abstraction import NAME
from .game import Dealer, Game
from .mccfr import Chunk, ChunkResult, run_chunk
from .tree import DEPTHS, compile_tree

FORMAT = 1
KIND = "rivermind-blueprint-checkpoint"
INT32_MAX = int(np.iinfo(np.int32).max)
LIVE = "live"
CHECKPOINTS = "checkpoints"
LATEST = "latest"


@dataclass(frozen=True)
class Settings:
    """Everything that decides what a run computes. Worker counts and schedules do not."""

    abstraction: str = NAME
    depths: tuple[int, ...] = DEPTHS
    seed: int = 0
    chunk_size: int = 1_000
    chunks_per_batch: int = 64
    discount_every: int = 1_000_000
    """Iterations between linear-CFR discounts: regrets and sums are multiplied by d / (d + 1)."""
    discount_until: int = 40_000_000
    """The last iteration at which a discount is applied."""
    prune_after: int = 20_000_000
    prune_probability: float = 0.95
    prune_threshold: int = -10_000_000
    regret_floor: int = -11_000_000

    @property
    def batch(self) -> int:
        return self.chunk_size * self.chunks_per_batch

    def check(self) -> None:
        if self.chunk_size < 1 or self.chunks_per_batch < 1 or self.discount_every < 1:
            raise ValueError("chunk_size, chunks_per_batch and discount_every must be positive")
        if not 0 <= self.prune_probability <= 1:
            raise ValueError("prune_probability must be between 0 and 1")
        if not self.regret_floor <= self.prune_threshold < 0:
            raise ValueError("the regret floor must be at or below the prune threshold, which must be negative")
        if self.regret_floor < -INT32_MAX:
            raise ValueError("the regret floor must fit in int32")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Settings:
        names = {f.name for f in fields(cls)}
        unknown = set(data) - names
        if unknown:
            raise ValueError(f"unknown settings: {', '.join(sorted(unknown))}")
        values = dict(data)
        if "depths" in values:
            values["depths"] = tuple(values["depths"])
        return cls(**values)


class CheckpointError(ValueError):
    """A checkpoint is missing, damaged or does not match the run it is resumed into."""


class RunInUseError(RuntimeError):
    """Another trainer holds the run directory's lock."""


@dataclass
class Progress:
    iteration: int
    batch: int
    seconds: float
    nodes: int
    checkpoint: Path | None = None


def build_game(settings: Settings, dealer: Dealer) -> Game:
    if settings.abstraction != NAME:
        raise ValueError(f"only the {NAME} abstraction is implemented")
    return Game(tuple(compile_tree(d) for d in settings.depths), dealer.buckets)


# Workers

_worker: dict[str, Any] = {}


def _init_worker(game: Game, regrets_path: str, size: int, dealer: Dealer) -> None:
    # The main process stops at a batch boundary on Ctrl-C; workers leave it to it.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    _worker["game"] = game
    _worker["regrets"] = np.asarray(np.memmap(regrets_path, dtype=np.int32, mode="r", shape=(size,)))
    _worker["dealer"] = dealer


def _run_worker_chunk(chunk: Chunk) -> ChunkResult:
    return run_chunk(_worker["game"], _worker["regrets"], _worker["dealer"], chunk)


class Trainer:
    """A run directory: live regrets, average-strategy sums and checkpoints."""

    def __init__(
        self,
        run: str | Path,
        settings: Settings,
        dealer: Dealer,
        *,
        game: Game | None = None,
        workers: int = 1,
    ) -> None:
        settings.check()
        self.run = Path(run)
        self.settings = settings
        self.dealer = dealer
        self.game = game or build_game(settings, dealer)
        self.workers = max(1, workers)
        self.iteration = 0
        self.batch = 0
        self.seconds = 0.0
        """Training time over the whole run, across resumes."""
        (self.run / LIVE).mkdir(parents=True, exist_ok=True)
        (self.run / CHECKPOINTS).mkdir(exist_ok=True)
        self._lock = (self.run / LIVE / "lock").open("w")
        try:
            fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._lock.close()
            raise RunInUseError(f"another trainer is using {self.run}") from None
        self.regrets_path = self.run / LIVE / "regrets.i32"
        self.regrets = np.memmap(self.regrets_path, dtype=np.int32, mode="w+", shape=(self.game.size,))
        self.strategy = np.zeros(self.game.size, dtype=np.float64)
        self._pool: Any = None

    # Lifecycle

    @classmethod
    def resume(
        cls,
        run: str | Path,
        dealer: Dealer,
        *,
        workers: int = 1,
        checkpoint: str | Path | None = None,
        game: Game | None = None,
    ) -> Trainer:
        """Reopen a run at its latest checkpoint (or the one named), checking it matches the trees and cards."""
        run = Path(run)
        path = Path(checkpoint) if checkpoint is not None else latest_checkpoint(run)
        if path is None:
            raise CheckpointError(f"{run} has no checkpoint to resume from")
        manifest = read_manifest(path, verify=True)
        settings = Settings.from_dict(manifest["settings"])
        trainer = cls(run, settings, dealer, game=game, workers=workers)
        try:
            trainer._check_matches(manifest)
            trainer.regrets[:] = np.load(path / "regrets.npy", mmap_mode="r")
            trainer.regrets.flush()
            trainer.strategy[:] = np.load(path / "strategy.npy", mmap_mode="r")
        except BaseException:
            trainer.close()
            raise
        trainer.iteration = int(manifest["iteration"])
        trainer.batch = int(manifest["batch"])
        trainer.seconds = float(manifest["stats"]["seconds"])
        return trainer

    def _check_matches(self, manifest: dict[str, Any]) -> None:
        game = self.game.describe()
        if [t["sha256"] for t in manifest["game"]["trees"]] != [t["sha256"] for t in game["trees"]]:
            raise CheckpointError("the checkpoint was trained on different betting trees")
        if manifest["game"]["buckets"] != game["buckets"] or manifest["game"]["size"] != game["size"]:
            raise CheckpointError("the checkpoint's array layout differs from this game's")
        if manifest["cards"].get("sha256") != self.dealer.describe().get("sha256"):
            raise CheckpointError("the checkpoint was trained with a different card table set")

    def close(self) -> None:
        if self._pool is not None:
            self._pool.terminate()
            self._pool.join()
            self._pool = None
        if not self._lock.closed:
            self._lock.close()  # releases the run

    def __enter__(self) -> Trainer:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _map(self, chunks: list[Chunk]) -> list[ChunkResult]:
        if self.workers == 1:
            regrets = np.asarray(self.regrets)
            return [run_chunk(self.game, regrets, self.dealer, c) for c in chunks]
        if self._pool is None:
            ctx = mp.get_context("spawn")
            self._pool = ctx.Pool(
                self.workers,
                initializer=_init_worker,
                initargs=(self.game, str(self.regrets_path), self.game.size, self.dealer),
            )
        return self._pool.map(_run_worker_chunk, chunks, chunksize=1)

    # Training

    def train(
        self,
        until: int,
        *,
        checkpoint_every: int | None = None,
        on_batch: Callable[[Progress], None] | None = None,
        should_stop: Callable[[], bool] | None = None,
        keep: int = 2,
    ) -> Progress:
        """Run whole batches until at least ``until`` iterations, checkpointing every ``checkpoint_every`` and at the end.

        ``should_stop`` is asked after each batch; when it says so, training
        stops there and writes a checkpoint, so nothing is lost.
        """
        s = self.settings
        next_checkpoint = None
        if checkpoint_every:
            next_checkpoint = (self.iteration // checkpoint_every + 1) * checkpoint_every
        progress = Progress(self.iteration, self.batch, self.seconds, 0)
        while self.iteration < until:
            started = time.perf_counter()
            chunks = [
                Chunk(
                    index=self.batch * s.chunks_per_batch + k,
                    first=self.iteration + k * s.chunk_size,
                    size=s.chunk_size,
                    seed=s.seed,
                    prune_after=s.prune_after,
                    prune_probability=s.prune_probability,
                    prune_threshold=s.prune_threshold,
                )
                for k in range(s.chunks_per_batch)
            ]
            results = self._map(chunks)
            self._merge(results)
            self.iteration += s.batch
            self.batch += 1
            self._discount(self.iteration - s.batch, self.iteration)
            self.seconds += time.perf_counter() - started
            progress = Progress(self.iteration, self.batch, self.seconds, sum(r.nodes for r in results))
            if next_checkpoint is not None and self.iteration >= next_checkpoint:
                progress.checkpoint = self.checkpoint(keep)
                next_checkpoint = (self.iteration // checkpoint_every + 1) * checkpoint_every  # type: ignore[operator]
            if on_batch is not None:
                on_batch(progress)
            if should_stop is not None and should_stop():
                break
        latest = latest_checkpoint(self.run)
        if latest is None or read_manifest(latest)["iteration"] != self.iteration:
            progress.checkpoint = self.checkpoint(keep)
        return progress

    def _merge(self, results: list[ChunkResult]) -> None:
        """Add each chunk's changes in chunk order (a chunk's slots are distinct)."""
        floor = self.settings.regret_floor
        for r in sorted(results, key=lambda r: r.index):
            if len(r.regret_slots):
                current = self.regrets[r.regret_slots].astype(np.int64) + r.regret_deltas
                self.regrets[r.regret_slots] = np.clip(current, floor, INT32_MAX).astype(np.int32)
            self.strategy[r.strategy_slots] += r.strategy_deltas

    def _discount(self, before: int, after: int) -> None:
        """Apply every linear-CFR discount whose iteration lies in ``(before, after]``."""
        s = self.settings
        d = before // s.discount_every + 1
        while d * s.discount_every <= min(after, s.discount_until):
            factor = d / (d + 1)
            for lo, hi in _blocks(self.game.size, 1 << 22):
                self.regrets[lo:hi] = np.rint(self.regrets[lo:hi] * factor).astype(np.int32)
                self.strategy[lo:hi] *= factor
            d += 1

    # Checkpoints

    def checkpoint(self, keep: int = 2) -> Path:
        """Write a consistent checkpoint of the current batch boundary and make it the latest."""
        self.regrets.flush()
        root = self.run / CHECKPOINTS
        name = f"{self.iteration:012d}"
        final = root / name
        partial = root / (name + ".partial")
        if partial.exists():
            shutil.rmtree(partial)
        partial.mkdir()
        np.save(partial / "regrets.npy", np.asarray(self.regrets))
        np.save(partial / "strategy.npy", self.strategy)
        manifest = {
            "format": FORMAT,
            "kind": KIND,
            "abstraction": self.settings.abstraction,
            "iteration": self.iteration,
            "batch": self.batch,
            "settings": asdict(self.settings),
            "game": self.game.describe(),
            "cards": self.dealer.describe(),
            "engine": engine_identity(),
            "software": software(),
            "stats": {
                "seconds": round(self.seconds, 3),
                "iterations_per_second": round(self.iteration / self.seconds, 1) if self.seconds else None,
                "workers": self.workers,
                **coverage(self.game, self.regrets, self.strategy),
            },
            "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "files": file_hashes(partial),
        }
        (partial / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        _fsync_directory(partial)
        if final.exists():
            shutil.rmtree(final)
        partial.rename(final)
        _fsync_directory(root)
        _write_atomic(self.run / LATEST, name + "\n")
        self._prune_checkpoints(keep)
        return final

    def _prune_checkpoints(self, keep: int) -> None:
        found = sorted(p for p in (self.run / CHECKPOINTS).iterdir() if p.is_dir() and not p.name.endswith(".partial"))
        for old in found[: max(0, len(found) - keep)]:
            shutil.rmtree(old)


def coverage(game: Game, regrets: np.ndarray, strategy: np.ndarray) -> dict[str, Any]:
    """Share of each depth class and street's info sets that have been updated, and of their slots."""
    out: dict[str, Any] = {}
    for d, s, lo, hi in game.slices():
        tree = game.trees[d]
        if hi == lo:
            continue
        r = np.asarray(regrets[lo:hi]).reshape(game.buckets[s], tree.width[s])
        g = np.asarray(strategy[lo:hi]).reshape(game.buckets[s], tree.width[s])
        touched = (r != 0) | (g != 0)
        starts = np.array([o for o, st in zip(tree.offset, tree.street) if st == s], dtype=np.int64)
        per_node = np.logical_or.reduceat(touched, starts, axis=1)
        key = f"{tree.depth}_{('preflop', 'flop', 'turn', 'river')[s]}"
        out.setdefault("info_sets_touched", {})[key] = round(float(per_node.mean()), 6)
        out.setdefault("slots_touched", {})[key] = round(float(touched.mean()), 6)
    return out


def latest_checkpoint(run: str | Path) -> Path | None:
    run = Path(run)
    try:
        name = (run / LATEST).read_text().strip()
    except FileNotFoundError:
        return None
    path = run / CHECKPOINTS / name
    return path if path.is_dir() else None


def read_manifest(path: str | Path, *, verify: bool = False) -> dict[str, Any]:
    path = Path(path)
    try:
        manifest: dict[str, Any] = json.loads((path / "manifest.json").read_text())
    except (OSError, ValueError) as e:
        raise CheckpointError(f"{path} has no readable manifest.json") from e
    if manifest.get("kind") != KIND or manifest.get("format") != FORMAT:
        raise CheckpointError(f"{path} is not a format {FORMAT} blueprint checkpoint")
    if verify:
        found = file_hashes(path)
        expected = manifest["files"]
        bad = sorted(n for n in expected.keys() | found.keys() if expected.get(n, {}).get("sha256") != found.get(n, {}).get("sha256"))
        if bad:
            raise CheckpointError(f"files differ from the manifest: {', '.join(bad)}")
    return manifest


def file_hashes(directory: Path) -> dict[str, dict[str, Any]]:
    found = {}
    for path in sorted(Path(directory).iterdir()):
        if path.is_file() and path.name != "manifest.json":
            digest = hashlib.sha256()
            with path.open("rb") as f:
                for block in iter(lambda: f.read(1 << 22), b""):
                    digest.update(block)
            found[path.name] = {"sha256": digest.hexdigest(), "bytes": path.stat().st_size}
    return found


def engine_identity() -> dict[str, Any]:
    """The package version and a hash of the engine's source, whose rules the trees were compiled from."""
    root = Path(__file__).resolve().parents[2] / "engine"
    digest = hashlib.sha256()
    for path in sorted(root.glob("*.py")):
        digest.update(path.name.encode() + b"\0" + path.read_bytes() + b"\0")
    return {"package": _version("rivermind-poker"), "source_sha256": digest.hexdigest()}


def software() -> dict[str, Any]:
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True, cwd=Path(__file__).parent
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain", "--untracked-files=no"],
                capture_output=True,
                text=True,
                check=True,
                cwd=Path(__file__).parent,
            ).stdout.strip()
        )
    except (OSError, subprocess.CalledProcessError):
        commit, dirty = None, None
    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "machine": platform.machine(),
        "cpu_count": os.cpu_count(),
        "commit": commit,
        "dirty": dirty,
    }


def _version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    _fsync_directory(path.parent)


def _fsync_directory(directory: Path) -> None:
    """Flush a directory's files and then its entries to disk."""
    for path in directory.iterdir():
        if path.is_file():
            with path.open("rb") as f:
                os.fsync(f.fileno())
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _blocks(n: int, size: int) -> Iterator[tuple[int, int]]:
    for lo in range(0, n, size):
        yield lo, min(n, lo + size)


__all__ = [
    "CheckpointError",
    "Progress",
    "RunInUseError",
    "Settings",
    "Trainer",
    "build_game",
    "latest_checkpoint",
    "read_manifest",
]
