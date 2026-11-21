import { describe, expect, it } from 'vitest';
import { evaluate, rankClass } from '../engine/evaluator.ts';
import type { Card, Suit } from '../protocol-v2.ts';
import { HAND_CLASSES, nameHand } from './hand-name.ts';

const SUITS: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const RANKS = '23456789TJQKA';

/** Cards from text such as "As Kd 7c". */
function hand(text: string): Card[] {
	return text.split(' ').map((t) => ({ rank: RANKS.indexOf(t[0]) + 2, suit: SUITS[t[1]] }));
}

describe('naming a hand', () => {
	it('names every class with the ranks that decide it', () => {
		const cases: [string, string][] = [
			['Ts Js Qs Ks As 2d 3c', 'a royal flush'],
			['5h 6h 7h 8h 9h Ad Ac', 'a nine-high straight flush'],
			['Ah 2h 3h 4h 5h Kd Kc', 'a five-high straight flush'],
			['Jc Jd Jh Js 2c 2d 9h', 'four of a kind, jacks'],
			['Tc Td Th 4s 4c Ad 9h', 'a full house, tens full of fours'],
			['6c 6d 6h Ks Kc Kd 9h', 'a full house, kings full of sixes'],
			['Ah 9h 7h 4h 2h Kd Kc', 'an ace-high flush'],
			['9c Td Jh Qs Kc 2d 2h', 'a king-high straight'],
			['Ac 2d 3h 4s 5c Kd Qh', 'a five-high straight'],
			['4c 5d 6h 7s 8c 8d Ah', 'an eight-high straight'],
			['9c 9d 9h Ks 2c 5d 7h', 'three of a kind, nines'],
			['Kc Kd 7h 7s 2c 2d Ah', 'two pair, kings and sevens'],
			['Ac Ad 7h 6s 2c 9d Jh', 'a pair of aces'],
			['6c 6d 7h 9s 2c Td Jh', 'a pair of sixes'],
			['Ac Kd 7h 6s 2c 9d Jh', 'ace-high'],
			['As Kd', 'ace-high'],
			['7s 7d', 'a pair of sevens']
		];
		for (const [text, name] of cases) expect(nameHand(hand(text)).name, text).toBe(name);
	});

	it('agrees with the evaluator on the class of any seven cards', () => {
		// A seeded shuffle of the deck, dealt seven at a time.
		let x = 12345;
		const next = () => {
			x = (Math.imul(x, 1103515245) + 12345) >>> 0;
			return x / 2 ** 32;
		};
		const seen = new Set<string>();
		for (let deal = 0; deal < 20_000; deal++) {
			const deck = Array.from({ length: 52 }, (_, c) => c);
			for (let i = 0; i < 7; i++) {
				const j = i + Math.floor(next() * (52 - i));
				[deck[i], deck[j]] = [deck[j], deck[i]];
			}
			const dealt = deck.slice(0, 7);
			const named = nameHand(
				dealt.map((c) => ({ rank: (c >> 2) + 2, suit: SUITS['cdhs'[c & 3]] }))
			);
			expect(named.class, dealt.join(' ')).toBe(HAND_CLASSES[rankClass(evaluate(dealt)) - 1]);
			seen.add(named.class);
		}
		// Seven random cards make every class but a straight flush often enough to be seen.
		expect(seen.size).toBeGreaterThanOrEqual(8);
	});
});
