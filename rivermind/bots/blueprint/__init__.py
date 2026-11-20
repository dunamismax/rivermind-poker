"""Heads-up blueprint training on the ``hu-m1`` abstraction (P5.3, ``docs/bots.md``).

``tree`` compiles the abstract betting trees from the engine, ``mccfr`` runs
external-sampling Monte Carlo CFR over chunks of iterations, ``train``
batches chunks across processes deterministically and writes checkpoints,
and ``Blueprint`` reads a checkpoint's strategies.
"""

from .blueprint import Blueprint
from .deals import CardDealer
from .game import Game
from .train import CheckpointError, Settings, Trainer, latest_checkpoint, read_manifest
from .tree import Tree, compile_tree, info_set_key

__all__ = [
    "Blueprint",
    "CardDealer",
    "CheckpointError",
    "Game",
    "Settings",
    "Trainer",
    "Tree",
    "compile_tree",
    "info_set_key",
    "latest_checkpoint",
    "read_manifest",
]
