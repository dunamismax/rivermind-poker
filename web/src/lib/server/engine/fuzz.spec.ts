// A short self-play fuzz run of the TypeScript engine, checking every
// invariant of rivermind/engine/fuzz.py after every action and that nearby
// illegal actions are rejected. Parity with the Python engine is checked by
// scripts/engine-parity.ts.

import { describe, expect, it } from 'vitest';
import { checkState, playRandomHand } from './fuzz.ts';
import { cryptoRandom, seededRandom } from './random.ts';
import { handConfig, startHand } from './state.ts';

describe('self-play fuzz', () => {
	it.each([2, 3, 4, 5, 6, 7, 8, 9])('%i seats: 300 hands keep every invariant', (seats) => {
		const rng = seededRandom(1_000 + seats);
		let showdowns = 0;
		for (let i = 0; i < 300; i++) {
			const state = playRandomHand(seats, rng);
			if (state.result!.showdown) showdowns++;
		}
		expect(showdowns).toBeGreaterThan(0);
	});

	it('deals live hands from the operating system’s randomness (D-8)', () => {
		const decks = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const state = startHand(handConfig(50, 100), [1_000, 1_000], 0, { rng: cryptoRandom });
			checkState(state, 2_000);
			expect([...state.deck].sort((a, b) => a - b)).toEqual(
				Array.from({ length: 52 }, (_, c) => c)
			);
			decks.add(state.deck.join());
		}
		expect(decks.size).toBe(20);
	});

	it('seeded generators repeat and stay in range', () => {
		const a = seededRandom(9);
		const b = seededRandom(9);
		const draws = Array.from({ length: 1_000 }, () => a.below(7));
		expect(draws).toEqual(Array.from({ length: 1_000 }, () => b.below(7)));
		expect(new Set(draws)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
		expect(() => a.below(0)).toThrow(RangeError);
	});
});
