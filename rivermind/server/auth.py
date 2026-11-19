"""Player tokens for the table server (P3.4).

A token is a player id signed with the server's secret (HMAC-SHA256), so the
server needs no token store and tokens survive restarts. Keep the secret
private and stable; changing it signs everyone out. Phase 4 replaces bearer
tokens with a signed session cookie (P4.1).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

_PREFIX = "p_"


def new_player_id() -> str:
    return _PREFIX + secrets.token_urlsafe(12)


def _signature(secret: bytes, player_id: str) -> str:
    return hmac.new(secret, player_id.encode(), hashlib.sha256).hexdigest()[:43]


def issue(secret: bytes, player_id: str) -> str:
    return f"{player_id}.{_signature(secret, player_id)}"


def verify(secret: bytes, token: object) -> str | None:
    """The player id a token was issued for, or ``None`` if it is not genuine."""
    if not isinstance(token, str) or len(token) > 200 or "." not in token:
        return None
    player_id, signature = token.rsplit(".", 1)
    if not player_id.startswith(_PREFIX):
        return None
    if not hmac.compare_digest(signature, _signature(secret, player_id)):
        return None
    return player_id


def guest_name(player_id: str) -> str:
    """A display handle derived from the id, such as ``Guest 4821``."""
    number = int(hashlib.sha256(player_id.encode()).hexdigest()[:8], 16) % 9000 + 1000
    return f"Guest {number}"
