// The name of a poker hand in words, such as “a king-high straight” or “two
// pair, aces and sevens”, for explaining who won a pot (P6.1). It names the
// best five cards among the two to seven given, by the ranking in
// docs/rules.md; a test checks its hand class against the engine's evaluator.

import type { Card } from '../protocol-v2.ts';

const WORDS: Record<number, string> = {
	2: 'two',
	3: 'three',
	4: 'four',
	5: 'five',
	6: 'six',
	7: 'seven',
	8: 'eight',
	9: 'nine',
	10: 'ten',
	11: 'jack',
	12: 'queen',
	13: 'king',
	14: 'ace'
};

const word = (rank: number): string => WORDS[rank] ?? String(rank);
const plural = (rank: number): string => (rank === 6 ? 'sixes' : `${word(rank)}s`);
/** “an ace-high”, “an eight-high”, “a king-high”. */
const high = (rank: number): string =>
	`${rank === 14 || rank === 8 ? 'an' : 'a'} ${word(rank)}-high`;

/** The classes of hand, best first, as the evaluator numbers them from 1. */
export const HAND_CLASSES = [
	'straight flush',
	'four of a kind',
	'full house',
	'flush',
	'straight',
	'three of a kind',
	'two pair',
	'pair',
	'high card'
] as const;
export type HandClass = (typeof HAND_CLASSES)[number];

/** The top card of the best straight among `ranks`, or 0. The ace also plays low, for the wheel. */
function straightHigh(ranks: ReadonlySet<number>): number {
	for (let top = 14; top >= 5; top--) {
		let run = true;
		for (let r = top; r > top - 5 && run; r--) run = ranks.has(r === 1 ? 14 : r);
		if (run) return top;
	}
	return 0;
}

export interface NamedHand {
	class: HandClass;
	/** With its article, ready to follow “with” or “shows”: “a king-high straight”. */
	name: string;
}

/** Name the best hand among `cards`: hole cards with the board, or any two to seven cards. */
export function nameHand(cards: readonly Card[]): NamedHand {
	const counts = new Map<number, number>();
	const suits = new Map<string, number[]>();
	for (const card of cards) {
		counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
		suits.set(card.suit, [...(suits.get(card.suit) ?? []), card.rank]);
	}
	// Ranks by how many there are, then by rank, highest first.
	const of = (n: number) =>
		[...counts.entries()]
			.filter(([, count]) => count >= n)
			.map(([rank]) => rank)
			.sort((a, b) => b - a);
	const flush = [...suits.values()].find((ranks) => ranks.length >= 5);
	if (flush) {
		const top = straightHigh(new Set(flush));
		if (top === 14) return { class: 'straight flush', name: 'a royal flush' };
		if (top) return { class: 'straight flush', name: `${high(top)} straight flush` };
	}
	const [quads] = of(4);
	if (quads) return { class: 'four of a kind', name: `four of a kind, ${plural(quads)}` };
	const trips = of(3);
	const pairs = of(2);
	if (trips.length && pairs.length > 1) {
		const over = pairs.find((rank) => rank !== trips[0]) as number;
		return {
			class: 'full house',
			name: `a full house, ${plural(trips[0])} full of ${plural(over)}`
		};
	}
	if (flush) return { class: 'flush', name: `${high(Math.max(...flush))} flush` };
	const top = straightHigh(new Set(counts.keys()));
	if (top) return { class: 'straight', name: `${high(top)} straight` };
	if (trips.length)
		return { class: 'three of a kind', name: `three of a kind, ${plural(trips[0])}` };
	if (pairs.length > 1) {
		return { class: 'two pair', name: `two pair, ${plural(pairs[0])} and ${plural(pairs[1])}` };
	}
	if (pairs.length) return { class: 'pair', name: `a pair of ${plural(pairs[0])}` };
	return { class: 'high card', name: `${word(Math.max(...counts.keys()))}-high` };
}
