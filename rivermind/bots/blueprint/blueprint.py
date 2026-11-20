"""Read a trained blueprint's strategies from a checkpoint (P5.3)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .game import Game
from .train import CheckpointError, Settings, read_manifest
from .tree import compile_tree


class Blueprint:
    """A checkpoint's average and current strategies, memory-mapped."""

    def __init__(self, checkpoint: str | Path, *, verify: bool = False) -> None:
        self.path = Path(checkpoint)
        self.manifest: dict[str, Any] = read_manifest(self.path, verify=verify)
        self.settings = Settings.from_dict(self.manifest["settings"])
        trees = tuple(compile_tree(d) for d in self.settings.depths)
        recorded = [t["sha256"] for t in self.manifest["game"]["trees"]]
        if [t.sha256 for t in trees] != recorded:
            raise CheckpointError("this software compiles different trees from the checkpoint's")
        self.game = Game(trees, tuple(self.manifest["game"]["buckets"]))  # type: ignore[arg-type]
        self.strategy = np.load(self.path / "strategy.npy", mmap_mode="r")
        self.regrets = np.load(self.path / "regrets.npy", mmap_mode="r")

    @property
    def iteration(self) -> int:
        return int(self.manifest["iteration"])

    def _slots(self, depth: int, history: str, bucket: int) -> tuple[tuple[str, ...], int]:
        d = self.game.depth_index(depth)
        tree = self.game.trees[d]
        node = tree.node(history)
        return tree.tokens[node], self.game.slot(d, node, bucket)

    def average(self, depth: int, history: str, bucket: int) -> dict[str, float] | None:
        """The average strategy at an info set, or ``None`` if training never reached it."""
        tokens, slot = self._slots(depth, history, bucket)
        sums = np.asarray(self.strategy[slot : slot + len(tokens)], dtype=np.float64)
        total = float(sums.sum())
        if total <= 0:
            return None
        return {t: float(x) / total for t, x in zip(tokens, sums)}

    def current(self, depth: int, history: str, bucket: int) -> dict[str, float]:
        """Regret matching on the info set's regrets: what the trainer plays now."""
        tokens, slot = self._slots(depth, history, bucket)
        r = np.maximum(np.asarray(self.regrets[slot : slot + len(tokens)], dtype=np.float64), 0)
        total = float(r.sum())
        if total <= 0:
            return {t: 1 / len(tokens) for t in tokens}
        return {t: float(x) / total for t, x in zip(tokens, r)}
