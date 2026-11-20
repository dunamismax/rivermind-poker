"""Card abstraction tables for the trained bots (P5.2, ``docs/bots.md``).

Pre-flop hands fall into 169 lossless classes. On the flop, turn and river a
hand's bucket clusters its exact equity distribution; tables are stored once
per suit-isomorphism class of board. ``build`` writes a table set with a
manifest of its settings and SHA-256s, and ``CardTables`` opens one.
"""

from .build import Settings, build
from .tables import CardTables, TableError, verify_files

__all__ = ["CardTables", "Settings", "TableError", "build", "verify_files"]
