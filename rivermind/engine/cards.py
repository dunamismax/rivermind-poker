"""Cards as small integers, with text forms and deck arrangement.

A card is an ``int`` from 0 to 51: ``rank * 4 + suit``, where rank 0 is a
deuce and 12 an ace, and suit is 0 to 3 for clubs, diamonds, hearts and
spades. The text form is a rank character and a suit letter, as in ``"As"``,
``"Td"`` or ``"2c"``.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

RANKS = "23456789TJQKA"
SUITS = "cdhs"
SUIT_SYMBOLS = "♣♦♥♠"
RANK_NAMES = (
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Jack",
    "Queen",
    "King",
    "Ace",
)

DECK_SIZE = 52
FULL_DECK: tuple[int, ...] = tuple(range(DECK_SIZE))

_TEXT = tuple(RANKS[c >> 2] + SUITS[c & 3] for c in FULL_DECK)
_FROM_TEXT = {text: c for c, text in enumerate(_TEXT)}


def rank(card: int) -> int:
    """Rank from 0 (deuce) to 12 (ace)."""
    return card >> 2


def suit(card: int) -> int:
    """Suit from 0 to 3: clubs, diamonds, hearts, spades."""
    return card & 3


def card(text: str) -> int:
    """Parse one card such as ``"As"`` or ``"td"`` (the rank may be lower case)."""
    if len(text) == 2:
        found = _FROM_TEXT.get(text[0].upper() + text[1].lower())
        if found is not None:
            return found
    raise ValueError(f"not a card: {text!r}")


def cards(text: str | Iterable[str]) -> tuple[int, ...]:
    """Parse cards from ``"As Kd 7c"``, ``"AsKd7c"`` or an iterable of strings."""
    if isinstance(text, str):
        compact = "".join(text.split())
        if len(compact) % 2:
            raise ValueError(f"not a list of cards: {text!r}")
        parts: Iterable[str] = (compact[i : i + 2] for i in range(0, len(compact), 2))
    else:
        parts = text
    return tuple(card(part) for part in parts)


def card_str(c: int) -> str:
    """Text form of a card, such as ``"As"``."""
    return _TEXT[c]


def cards_str(cs: Iterable[int]) -> str:
    """Space-separated text form, such as ``"As Kd"``."""
    return " ".join(_TEXT[c] for c in cs)


def pretty(c: int) -> str:
    """Rank and suit symbol, such as ``"A♠"``."""
    return RANKS[c >> 2] + SUIT_SYMBOLS[c & 3]


def build_deck(
    holes: Sequence[Sequence[int]],
    board: Sequence[int] = (),
    burns: Sequence[int] = (),
    rest: Sequence[int] | None = None,
) -> tuple[int, ...]:
    """Arrange a 52-card deck order that deals the given cards (rules 1.2 to 1.4).

    ``holes`` lists the two hole cards of each player dealt in, in dealing
    order: the first entry is the player left of the button. ``board`` gives up
    to five board cards in order and ``burns`` up to three burn cards. Every
    other position is filled from ``rest`` (default: the unused cards in
    ascending order).
    """
    n = len(holes)
    if not 2 <= n <= 9:
        raise ValueError("between 2 and 9 players are dealt in")
    if len(board) > 5 or len(burns) > 3:
        raise ValueError("at most five board cards and three burns")
    order: list[int | None] = [None] * DECK_SIZE
    for i, hole in enumerate(holes):
        if len(hole) != 2:
            raise ValueError("each player has two hole cards")
        order[i] = hole[0]
        order[n + i] = hole[1]
    board_positions = (2 * n + 1, 2 * n + 2, 2 * n + 3, 2 * n + 5, 2 * n + 7)
    for position, c in zip(board_positions, board):
        order[position] = c
    for position, c in zip((2 * n, 2 * n + 4, 2 * n + 6), burns):
        order[position] = c
    placed = [c for c in order if c is not None]
    if len(set(placed)) != len(placed) or not all(0 <= c < DECK_SIZE for c in placed):
        raise ValueError("cards must be distinct and between 0 and 51")
    used = set(placed)
    fill = list(rest) if rest is not None else [c for c in FULL_DECK if c not in used]
    fill = [c for c in fill if c not in used]
    if len(fill) != DECK_SIZE - len(placed):
        raise ValueError("rest must supply exactly the unused cards")
    it = iter(fill)
    return tuple(c if c is not None else next(it) for c in order)
