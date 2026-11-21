"""The Python table model, kept as the reference for the TypeScript table.

``table`` holds the synchronous table core: seats, buy-ins, sitting out and
hands; ``snapshot`` saves and restores a table. ``pnpm table:parity`` (from
``web/``) replays ``test.server.table_differential``'s requests against
``web/src/lib/server/table`` and compares every answer and snapshot with these.
The table server that ran them, ``serve-nl``, was retired at P4B.8: the site's
tables are served by the Node server. ``typescript`` turns the short-deck
protocol's JSON Schema into ``web/src/lib/protocol.ts``.
"""

from .table import Departure, ErrorCode, Event, Player, Table, TableConfig, TableError, Turn

__all__ = [
    "Departure",
    "ErrorCode",
    "Event",
    "Player",
    "Table",
    "TableConfig",
    "TableError",
    "Turn",
]
