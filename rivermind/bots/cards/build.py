"""Build a set of card tables (P5.2, ``docs/bots.md``).

``build`` writes a directory of NumPy files and a ``manifest.json``:

- ``preflop.npy``: the 169 lossless classes, one ``uint16`` per hole pair.
- ``{flop,turn,river}_board_class.npy`` and ``..._board_perm.npy``: for each
  board by its colexicographic rank, its class and the suit permutation that
  maps it onto the class's representative (``iso``).
- ``{flop,turn,river}.npy``: a ``uint16`` bucket for each board class and
  hole pair (``INVALID`` where a card collides). Buckets are numbered from
  the lowest mean equity up.
- ``{flop,turn,river}_centroids.npy``: the cluster centres, for reference.

The stages are: board indexes; exact river equities for every river board
class; river buckets by one-dimensional k-means over the 1,981 possible
equities; turn and flop equity histograms gathered from the river equities;
and k-means on the histograms' cumulative sums. Every random choice comes
from ``Settings.seed``, so the same settings and software give files with the
same SHA-256. Work runs in ``workers`` processes that write into memory-mapped
files, so the results do not depend on how work was shared out.

``Settings.limit`` builds only the first classes of each street, for tests;
such a set says so in its manifest and cannot look up the classes it lacks.
"""

from __future__ import annotations

import hashlib
import json
import multiprocessing as mp
import os
import platform
import resource
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from dataclasses import asdict, dataclass
from importlib import metadata
from pathlib import Path
from typing import Any

import numpy as np

from .equity import BINS, EQUITY_SCALE, INVALID, direct_rows, histograms, river_equity
from .iso import PAIRS, BoardIndex, board_index, pair_cards, pair_masks, preflop_class

FORMAT = 1
KIND = "rivermind-card-tables"
STREETS = ("flop", "turn", "river")
SIZES = {"flop": 3, "turn": 4, "river": 5}
CHUNK = 64
"""Board classes per worker task."""


@dataclass(frozen=True)
class Settings:
    abstraction: str = "hu-m1"
    flop_buckets: int = 1000
    turn_buckets: int = 1000
    river_buckets: int = 1000
    seed: int = 0
    sample: int = 500_000
    """Points (hand classes) k-means is fitted on for the flop and turn; every point is then assigned."""
    max_iter: int = 300
    tol: float = 1e-4
    limit: int | None = None
    """Only the first ``limit`` classes of each street (tests only)."""

    def buckets(self, street: str) -> int:
        return int(getattr(self, f"{street}_buckets"))

    def check(self) -> None:
        for street in STREETS:
            if not 1 <= self.buckets(street) < int(INVALID):
                raise ValueError(f"{street}_buckets must be between 1 and {int(INVALID) - 1}")
        if self.sample < 1 or self.max_iter < 1 or self.tol < 0:
            raise ValueError("sample and max_iter must be positive and tol not negative")
        if self.limit is not None and self.limit < 1:
            raise ValueError("limit must be positive")


def build(out: Path, settings: Settings = Settings(), workers: int | None = None, keep_work: bool = False) -> dict[str, Any]:
    """Build a table set in ``out`` (which must not exist) and return its manifest."""
    settings.check()
    out = Path(out)
    if out.exists():
        raise FileExistsError(f"{out} already exists")
    workers = workers or os.cpu_count() or 1
    partial = out.with_name(out.name + ".partial")
    if partial.exists():
        shutil.rmtree(partial)
    (partial / "work").mkdir(parents=True)
    started = time.time()
    seconds: dict[str, float] = {}
    with MemorySampler() as memory:
        builder = _Builder(partial, settings, workers)
        for stage in ("boards", "preflop", "river_equity", "river", "turn_histograms", "turn", "flop_histograms", "flop"):
            t = time.perf_counter()
            getattr(builder, stage)()
            seconds[stage] = round(time.perf_counter() - t, 2)
    if not keep_work:
        shutil.rmtree(partial / "work")
    manifest = {
        "format": FORMAT,
        "kind": KIND,
        "settings": asdict(settings),
        "histogram_bins": BINS,
        "equity_scale": EQUITY_SCALE,
        "classes": {street: builder.class_counts[street] for street in STREETS},
        "software": _software(),
        "build": {
            "started": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(started)),
            "machine": platform.machine(),
            "processor": platform.processor() or None,
            "cpu_count": os.cpu_count(),
            "workers": workers,
            "seconds": seconds,
            "total_seconds": round(time.time() - started, 1),
            "peak_rss_bytes_all_processes": memory.peak,
            "peak_rss_bytes_main": _max_rss(resource.RUSAGE_SELF),
            "peak_rss_bytes_largest_worker": _max_rss(resource.RUSAGE_CHILDREN),
        },
        "files": file_hashes(partial),
    }
    (partial / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    partial.rename(out)
    return manifest


def file_hashes(directory: Path) -> dict[str, dict[str, Any]]:
    """SHA-256 and size of every table file (``manifest.json`` and ``work/`` excluded)."""
    found = {}
    for path in sorted(Path(directory).iterdir()):
        if path.is_file() and path.name != "manifest.json":
            digest = hashlib.sha256()
            with path.open("rb") as f:
                for block in iter(lambda: f.read(1 << 22), b""):
                    digest.update(block)
            found[path.name] = {"sha256": digest.hexdigest(), "bytes": path.stat().st_size}
    return found


class _Builder:
    def __init__(self, out: Path, settings: Settings, workers: int) -> None:
        self.out = out
        self.work = out / "work"
        self.settings = settings
        self.workers = workers
        self.class_counts: dict[str, int] = {}
        self.orbits: dict[str, np.ndarray] = {}

    def _classes(self, street: str) -> int:
        total = len(board_index(SIZES[street]))
        return total if self.settings.limit is None else min(total, self.settings.limit)

    def boards(self) -> None:
        for street in STREETS:
            index = board_index(SIZES[street])
            np.save(self.out / f"{street}_board_class.npy", index.board_class)
            np.save(self.out / f"{street}_board_perm.npy", index.board_perm)
            np.save(self.out / f"{street}_class_keys.npy", index.class_keys)
            self.orbits[street] = index.orbit
            self.class_counts[street] = self._classes(street)

    def preflop(self) -> None:
        cards = pair_cards()
        table = np.array([preflop_class(int(a), int(b)) for a, b in cards], dtype=np.uint16)
        np.save(self.out / "preflop.npy", table)

    # River

    def river_equity(self) -> None:
        count = self.class_counts["river"]
        path = self.work / "river_equity.npy"
        np.lib.format.open_memmap(path, mode="w+", dtype=np.uint16, shape=(count, PAIRS)).flush()
        self._run(_river_task, path, count)

    def river(self) -> None:
        eq = np.load(self.work / "river_equity.npy", mmap_mode="r")
        orbit = self.orbits["river"]
        weights = np.zeros(EQUITY_SCALE + 1, dtype=np.float64)
        for lo, hi in _blocks(len(eq), 4096):
            rows = np.asarray(eq[lo:hi])
            valid = rows != INVALID
            w = np.broadcast_to(orbit[lo:hi, None], rows.shape)[valid]
            weights += np.bincount(rows[valid], weights=w, minlength=EQUITY_SCALE + 1)
        values = np.flatnonzero(weights)
        k = min(self.settings.buckets("river"), len(values))
        centers, labels = _kmeans(
            (values / EQUITY_SCALE).astype(np.float64)[:, None], weights[values], k, self.settings, salt=3
        )
        order = _renumber(centers[:, 0])
        bucket_of = np.full(EQUITY_SCALE + 1, INVALID, dtype=np.uint16)
        bucket_of[values] = order[labels]
        table = np.lib.format.open_memmap(self.out / "river.npy", mode="w+", dtype=np.uint16, shape=eq.shape)
        for lo, hi in _blocks(len(eq), 4096):
            rows = np.asarray(eq[lo:hi])
            table[lo:hi] = np.where(rows == INVALID, INVALID, bucket_of[np.minimum(rows, EQUITY_SCALE)])
        table.flush()
        np.save(self.out / "river_centroids.npy", np.sort(centers[:, 0]).astype(np.float32))

    # Turn and flop

    def turn_histograms(self) -> None:
        self._histograms("turn")

    def flop_histograms(self) -> None:
        self._histograms("flop")

    def turn(self) -> None:
        self._cluster("turn")

    def flop(self) -> None:
        self._cluster("flop")

    def _histograms(self, street: str) -> None:
        count = self.class_counts[street]
        dtype = np.uint8 if street == "turn" else np.uint16  # at most 46 or 1,081 runouts
        path = self.work / f"{street}_histograms.npy"
        np.lib.format.open_memmap(path, mode="w+", dtype=dtype, shape=(count, PAIRS, BINS)).flush()
        self._run(_histogram_task, path, count, street)

    def _cluster(self, street: str) -> None:
        hist = np.load(self.work / f"{street}_histograms.npy", mmap_mode="r")
        orbit = self.orbits[street]
        count = len(hist)
        board_masks = _class_masks(street, count)
        valid = (pair_masks()[None, :] & board_masks[:, None]) == 0  # (classes, 1326)
        points = np.flatnonzero(valid.ravel())
        rng = np.random.default_rng([self.settings.seed, 1 if street == "turn" else 2])
        if len(points) > self.settings.sample:
            chosen = np.sort(rng.choice(points, size=self.settings.sample, replace=False))
        else:
            chosen = points
        rows, cols = np.divmod(chosen, PAIRS)
        sample = _features(np.asarray(hist[rows, cols]))
        k = min(self.settings.buckets(street), len(chosen))
        centers, _ = _kmeans(sample, orbit[rows].astype(np.float64), k, self.settings, salt=1 if street == "turn" else 2)
        order = _renumber(_mean_bin(centers))
        table = np.lib.format.open_memmap(self.out / f"{street}.npy", mode="w+", dtype=np.uint16, shape=(count, PAIRS))
        for lo, hi in _blocks(count, 256):
            block = np.full((hi - lo, PAIRS), INVALID, dtype=np.uint16)
            ok = valid[lo:hi]
            feats = _features(np.asarray(hist[lo:hi])[ok])
            block[ok] = order[_nearest(feats, centers)]
            table[lo:hi] = block
        table.flush()
        np.save(self.out / f"{street}_centroids.npy", centers[np.argsort(order)].astype(np.float32))

    def _run(self, task: Any, path: Path, count: int, *extra: str) -> None:
        jobs = [(str(path), lo, hi, self.settings.limit, *extra) for lo, hi in _blocks(count, CHUNK)]
        if self.workers == 1 or len(jobs) == 1:
            for job in jobs:
                task(job)
            return
        with mp.get_context("spawn").Pool(self.workers) as pool:
            for _ in pool.imap_unordered(task, jobs):
                pass


def _blocks(count: int, size: int) -> Iterator[tuple[int, int]]:
    for lo in range(0, count, size):
        yield lo, min(count, lo + size)


def saved_index(directory: Path, street: str) -> BoardIndex:
    """A table set's board index, memory-mapped (workers use this rather than building their own)."""
    return BoardIndex(
        SIZES[street],
        np.load(directory / f"{street}_board_class.npy", mmap_mode="r"),
        np.load(directory / f"{street}_board_perm.npy", mmap_mode="r"),
        np.load(directory / f"{street}_class_keys.npy", mmap_mode="r"),
    )


def _class_masks(street: str, count: int) -> np.ndarray:
    index = board_index(SIZES[street])
    masks = np.zeros(count, dtype=np.int64)
    for cls in range(count):
        for c in index.representative(cls):
            masks[cls] |= np.int64(1) << c
    return masks


def _river_task(job: tuple[Any, ...]) -> None:
    path, lo, hi, _limit = job
    index = saved_index(Path(path).parents[1], "river")
    eq = np.load(path, mmap_mode="r+")
    for cls in range(lo, hi):
        eq[cls] = river_equity(index.representative(cls))
    eq.flush()


def _histogram_task(job: tuple[Any, ...]) -> None:
    path, lo, hi, limit, street = job
    river = saved_index(Path(path).parents[1], "river")
    if limit is None:
        eq = np.load(Path(path).parent / "river_equity.npy", mmap_mode="r")

        def rows(classes: np.ndarray) -> np.ndarray:
            return np.asarray(eq[classes])

    else:
        rows = direct_rows(river)  # a limited set lacks most river rows
    index = saved_index(Path(path).parents[1], street)
    out = np.load(path, mmap_mode="r+")
    for cls in range(lo, hi):
        out[cls] = histograms(index.representative(cls), river, rows).astype(out.dtype)
    out.flush()


def _features(hist: np.ndarray) -> np.ndarray:
    """Cumulative histograms, normalized, without the last bin (always 1)."""
    hist = np.asarray(hist, dtype=np.float32)
    totals = hist.sum(axis=-1, keepdims=True)
    return (np.cumsum(hist, axis=-1) / totals)[..., :-1]


def _mean_bin(cdf: np.ndarray) -> np.ndarray:
    """Mean bin of each cumulative histogram: the sum of 1 − CDF over the bins."""
    return (1.0 - cdf).sum(axis=1)


def _renumber(means: np.ndarray) -> np.ndarray:
    """``order[label]`` numbers clusters from the lowest mean up (ties by label)."""
    ranked = np.lexsort((np.arange(len(means)), means))
    order = np.empty(len(means), dtype=np.uint16)
    order[ranked] = np.arange(len(means), dtype=np.uint16)
    return order


def _kmeans(
    points: np.ndarray, weights: np.ndarray, k: int, settings: Settings, salt: int
) -> tuple[np.ndarray, np.ndarray]:
    """Weighted k-means: k-means++ seeding, then Lloyd's iterations, deterministic for a seed.

    Centres are updated with ``bincount`` sums in a fixed order, so the result
    does not depend on thread scheduling (scikit-learn's parallel reductions do).
    """
    rng = np.random.default_rng([settings.seed, salt])
    x = np.ascontiguousarray(points, dtype=np.float64)
    w = np.asarray(weights, dtype=np.float64)
    n = len(x)
    centers = np.empty((k, x.shape[1]), dtype=np.float64)
    centers[0] = x[rng.choice(n, p=w / w.sum())]
    nearest = ((x - centers[0]) ** 2).sum(axis=1)
    for j in range(1, k):
        mass = w * nearest
        total = mass.sum()
        pick = rng.choice(n, p=mass / total) if total > 0 else int(rng.integers(n))
        centers[j] = x[pick]
        nearest = np.minimum(nearest, ((x - centers[j]) ** 2).sum(axis=1))
    spread = float((w[:, None] * (x - np.average(x, axis=0, weights=w)) ** 2).sum() / w.sum())
    labels = _nearest(x, centers)
    for _ in range(settings.max_iter):
        mass = np.bincount(labels, weights=w, minlength=k)
        moved = np.empty_like(centers)
        for d in range(x.shape[1]):
            moved[:, d] = np.bincount(labels, weights=w * x[:, d], minlength=k)
        empty = mass == 0
        moved[~empty] /= mass[~empty, None]
        if empty.any():
            # Restart each empty cluster at the point farthest from its centre, farthest first.
            far = np.argsort(-(w * ((x - centers[labels]) ** 2).sum(axis=1)), kind="stable")
            moved[empty] = x[far[: int(empty.sum())]]
        shift = float(((moved - centers) ** 2).sum())
        centers = moved
        new_labels = _nearest(x, centers)
        if np.array_equal(new_labels, labels) or shift <= settings.tol * spread:
            labels = new_labels
            break
        labels = new_labels
    return centers, labels


def _nearest(points: np.ndarray, centers: np.ndarray) -> np.ndarray:
    """Index of the nearest centre to each point (squared Euclidean distance, first of equals)."""
    points = points.astype(np.float64)
    norms = (centers**2).sum(axis=1)
    out = np.empty(len(points), dtype=np.int64)
    for lo, hi in _blocks(len(points), 8192):
        d = norms[None, :] - 2.0 * points[lo:hi] @ centers.T
        out[lo:hi] = np.argmin(d, axis=1)
    return out


def _max_rss(who: int) -> int:
    rss = resource.getrusage(who).ru_maxrss
    return int(rss if sys.platform == "darwin" else rss * 1024)  # bytes on macOS, KiB on Linux


def _software() -> dict[str, Any]:
    try:
        package = metadata.version("rivermind-poker")
    except metadata.PackageNotFoundError:
        package = None
    root = Path(__file__).resolve().parents[3]
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain", "--", "rivermind/bots/cards", "rivermind/engine"],
                cwd=root,
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
        )
    except (OSError, subprocess.CalledProcessError):
        commit, dirty = None, None
    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "rivermind_poker": package,
        "git_commit": commit,
        "card_code_modified": dirty,
    }


class MemorySampler:
    """Polls the resident memory of this process and its descendants, keeping the peak sum."""

    def __init__(self, interval: float = 0.5) -> None:
        self.interval = interval
        self.peak = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def __enter__(self) -> MemorySampler:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._thread.join()

    def _loop(self) -> None:
        root = os.getpid()
        while not self._stop.is_set():
            try:
                listing = subprocess.run(["ps", "-axo", "pid=,ppid=,rss="], capture_output=True, text=True, check=True)
            except (OSError, subprocess.CalledProcessError):
                return
            parent: dict[int, int] = {}
            rss: dict[int, int] = {}
            for line in listing.stdout.splitlines():
                parts = line.split()
                if len(parts) == 3:
                    pid, ppid, kib = (int(x) for x in parts)
                    parent[pid], rss[pid] = ppid, kib
            total = 0
            for pid, kib in rss.items():
                p = pid
                while p and p != root and p in parent and p != parent[p]:
                    p = parent[p]
                if p == root:
                    total += kib * 1024
            self.peak = max(self.peak, total)
            self._stop.wait(self.interval)
