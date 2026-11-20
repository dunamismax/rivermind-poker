// Cards as small integers, with text forms and deck arrangement: a port of
// rivermind/engine/cards.py, which stays the reference (P4B.4).
//
// A card is an integer from 0 to 51: rank * 4 + suit, where rank 0 is a deuce
// and 12 an ace, and suit is 0 to 3 for clubs, diamonds, hearts and spades.
// The text form is a rank character and a suit letter, as in "As", "Td" or
// "2c". This module is safe for browsers.

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const SUIT_SYMBOLS = '♣♦♥♠';
export const RANK_NAMES = [
	'Two',
	'Three',
	'Four',
	'Five',
	'Six',
	'Seven',
	'Eight',
	'Nine',
	'Ten',
	'Jack',
	'Queen',
	'King',
	'Ace'
] as const;

export const DECK_SIZE = 52;
export const FULL_DECK: readonly number[] = Array.from({ length: DECK_SIZE }, (_, c) => c);

const TEXT: readonly string[] = FULL_DECK.map((c) => RANKS[c >> 2] + SUITS[c & 3]);
const FROM_TEXT = new Map(TEXT.map((text, c) => [text, c]));

/** Rank from 0 (deuce) to 12 (ace). */
export function rank(card: number): number {
	return card >> 2;
}

/** Suit from 0 to 3: clubs, diamonds, hearts, spades. */
export function suit(card: number): number {
	return card & 3;
}

/** Parse one card such as "As" or "td" (the rank may be lower case). */
export function card(text: string): number {
	if (typeof text === 'string' && text.length === 2) {
		const found = FROM_TEXT.get(text[0].toUpperCase() + text[1].toLowerCase());
		if (found !== undefined) return found;
	}
	throw new RangeError(`not a card: ${JSON.stringify(text)}`);
}

/** Parse cards from "As Kd 7c", "AsKd7c" or an array of strings. */
export function cards(text: string | readonly string[]): number[] {
	if (typeof text !== 'string') return text.map(card);
	const compact = text.split(/\s+/).join('');
	if (compact.length % 2) throw new RangeError(`not a list of cards: ${JSON.stringify(text)}`);
	const found: number[] = [];
	for (let i = 0; i < compact.length; i += 2) found.push(card(compact.slice(i, i + 2)));
	return found;
}

/** Text form of a card, such as "As". */
export function cardStr(c: number): string {
	const text = TEXT[c];
	if (text === undefined) throw new RangeError(`not a card: ${c}`);
	return text;
}

/** Space-separated text form, such as "As Kd". */
export function cardsStr(cs: readonly number[]): string {
	return cs.map(cardStr).join(' ');
}

/** Rank and suit symbol, such as "A♠". */
export function pretty(c: number): string {
	return RANKS[c >> 2] + SUIT_SYMBOLS[c & 3];
}

/**
 * Arrange a 52-card deck order that deals the given cards (rules 1.2 to 1.4).
 *
 * `holes` lists the two hole cards of each player dealt in, in dealing order:
 * the first entry is the player left of the button. `board` gives up to five
 * board cards in order and `burns` up to three burn cards. Every other
 * position is filled from `rest` (default: the unused cards in ascending
 * order).
 */
export function buildDeck(
	holes: readonly (readonly number[])[],
	board: readonly number[] = [],
	burns: readonly number[] = [],
	rest?: readonly number[]
): number[] {
	const n = holes.length;
	if (n < 2 || n > 9) throw new RangeError('between 2 and 9 players are dealt in');
	if (board.length > 5 || burns.length > 3) {
		throw new RangeError('at most five board cards and three burns');
	}
	const order: (number | null)[] = new Array(DECK_SIZE).fill(null);
	holes.forEach((hole, i) => {
		if (hole.length !== 2) throw new RangeError('each player has two hole cards');
		order[i] = hole[0];
		order[n + i] = hole[1];
	});
	const boardPositions = [2 * n + 1, 2 * n + 2, 2 * n + 3, 2 * n + 5, 2 * n + 7];
	board.forEach((c, i) => (order[boardPositions[i]] = c));
	const burnPositions = [2 * n, 2 * n + 4, 2 * n + 6];
	burns.forEach((c, i) => (order[burnPositions[i]] = c));
	const placed = order.filter((c): c is number => c !== null);
	const used = new Set(placed);
	if (
		used.size !== placed.length ||
		!placed.every((c) => Number.isInteger(c) && c >= 0 && c < 52)
	) {
		throw new RangeError('cards must be distinct and between 0 and 51');
	}
	const fill = (rest ?? FULL_DECK.filter((c) => !used.has(c))).filter((c) => !used.has(c));
	if (fill.length !== DECK_SIZE - placed.length) {
		throw new RangeError('rest must supply exactly the unused cards');
	}
	let next = 0;
	return order.map((c) => (c !== null ? c : fill[next++]));
}
