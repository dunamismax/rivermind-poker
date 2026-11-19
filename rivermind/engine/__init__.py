"""No-limit Texas hold'em engine for 2 to 9 seats (``docs/rules.md``).

The engine is pure: states are immutable, there is no global mutable state,
and randomness comes only from the caller.
"""

from .cards import build_deck, card, card_str, cards, cards_str
from .pots import Pot
from .seating import blind_seats, deal_order, initial_button, next_button, seats_dealt_in
from .state import (
    Action,
    ActionKind,
    ActionRecord,
    HandConfig,
    HandResult,
    HandState,
    IllegalActionError,
    LegalActions,
    Post,
    PostKind,
    Street,
    apply,
    legal_actions,
    start_hand,
    timeout_action,
)

__all__ = [
    "Action",
    "ActionKind",
    "ActionRecord",
    "HandConfig",
    "HandResult",
    "HandState",
    "IllegalActionError",
    "LegalActions",
    "Pot",
    "Post",
    "PostKind",
    "Street",
    "apply",
    "blind_seats",
    "build_deck",
    "card",
    "card_str",
    "cards",
    "cards_str",
    "deal_order",
    "initial_button",
    "legal_actions",
    "next_button",
    "seats_dealt_in",
    "start_hand",
    "timeout_action",
]
