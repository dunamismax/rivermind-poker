"""Player identity for the table server (P3.4, P4.1).

A player is identified by a session cookie: the player id and the time it
was issued, signed with the server's secret (HMAC-SHA256). The server needs
no session store, sessions survive restarts, and a session older than
``SESSION_SECONDS`` is refused. Keep the secret private and stable; changing
it signs everyone out.

Before P4.1 the client kept a bearer token (``issue`` and ``verify``), the
player id signed with the same secret. A token is now accepted only once, by
``POST /api/session``, to move an existing player onto a cookie.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import secrets

_PREFIX = "p_"
COOKIE_NAME = "rm_session"
SESSION_SECONDS = 180 * 24 * 3600
"""How long a session lasts after it was last issued. Each visit renews it."""
RENEW_AFTER_SECONDS = 24 * 3600
"""A session older than this is issued again when the player visits."""
_SESSION_VERSION = "s1"


def new_player_id() -> str:
    return _PREFIX + secrets.token_urlsafe(12)


def _signature(secret: bytes, player_id: str) -> str:
    return hmac.new(secret, player_id.encode(), hashlib.sha256).hexdigest()[:43]


def issue(secret: bytes, player_id: str) -> str:
    """A legacy (Phase 3) bearer token. Only tests and old clients still hold these."""
    return f"{player_id}.{_signature(secret, player_id)}"


def verify(secret: bytes, token: object) -> str | None:
    """The player id a legacy token was issued for, or ``None`` if it is not genuine."""
    if not isinstance(token, str) or len(token) > 200 or "." not in token:
        return None
    player_id, signature = token.rsplit(".", 1)
    if not player_id.startswith(_PREFIX):
        return None
    if not hmac.compare_digest(signature, _signature(secret, player_id)):
        return None
    return player_id


def _session_signature(secret: bytes, player_id: str, issued: int) -> str:
    # The version and purpose are signed too, so a legacy token can never pass as a session.
    message = f"session:{_SESSION_VERSION}:{player_id}:{issued}".encode()
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def issue_session(secret: bytes, player_id: str, now: float) -> str:
    """The session cookie value for ``player_id``, issued at ``now`` (seconds since the epoch)."""
    issued = int(now)
    return f"{_SESSION_VERSION}.{player_id}.{issued}.{_session_signature(secret, player_id, issued)}"


def read_session(secret: bytes, value: object, now: float) -> tuple[str, int] | None:
    """The player id and issue time of a genuine, unexpired session, else ``None``."""
    if not isinstance(value, str) or len(value) > 200:
        return None
    parts = value.split(".")
    if len(parts) != 4 or parts[0] != _SESSION_VERSION or not parts[1].startswith(_PREFIX):
        return None
    _, player_id, issued_text, signature = parts
    if not issued_text.isdigit() or len(issued_text) > 12:
        return None
    issued = int(issued_text)
    if not hmac.compare_digest(signature, _session_signature(secret, player_id, issued)):
        return None
    if issued > now + 300 or now - issued > SESSION_SECONDS:
        return None
    return player_id, issued


def guest_name(player_id: str) -> str:
    """The handle a Phase 3 player had, such as ``Guest 4821``, derived from the id."""
    number = int(hashlib.sha256(player_id.encode()).hexdigest()[:8], 16) % 9000 + 1000
    return f"Guest {number}"


def _host_name(netloc: str) -> str:
    host = netloc.rsplit("@", 1)[-1]
    if host.startswith("["):
        return host[1 : host.find("]")] if "]" in host else host
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def is_loopback(netloc: str) -> bool:
    """Whether a ``host[:port]`` names this machine."""
    host = _host_name(netloc).lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def origin_allowed(origin: str | None, host: str | None, allowed: frozenset[str] = frozenset()) -> bool:
    """Whether a request from ``origin`` may use the session of a request to ``host``.

    Browsers send ``Origin`` with every WebSocket handshake and every
    cross-origin or unsafe request, so a page on another site always
    shows itself. A request without one comes from a non-browser client,
    which cannot ride on a visitor's cookie. Same host is allowed, as is a
    loopback page calling a loopback server (the Vite dev proxy), and any
    origin in ``allowed``.
    """
    if origin is None:
        return True
    if origin in allowed:
        return True
    if "://" not in origin or not host:
        return False
    netloc = origin.split("://", 1)[1].rstrip("/")
    if netloc.lower() == host.lower():
        return True
    return is_loopback(netloc) and is_loopback(host)
