"""PostgreSQL persistence: connection settings, models and Alembic migrations (D-4).

The server reads its database from ``DATABASE_URL``. Plain ``postgresql://``
URLs are used through psycopg 3. Run migrations with ``alembic upgrade head``
from the repository root, or call ``upgrade`` from code.
"""

from .connection import database_url, make_engine, normalize_url
from .migrate import alembic_config, downgrade, upgrade
from .models import Base, Hand, HandHistory, Player, PokerTable, Seat

__all__ = [
    "Base",
    "Hand",
    "HandHistory",
    "Player",
    "PokerTable",
    "Seat",
    "alembic_config",
    "database_url",
    "downgrade",
    "make_engine",
    "normalize_url",
    "upgrade",
]
