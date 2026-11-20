// Caller-supplied randomness for the engine (rule 1.1, D-8). Live tables deal
// from `cryptoRandom`; seeded generators are only for tests, evaluation and
// training.

import { randomInt } from 'node:crypto';

/** A source of uniform whole numbers. */
export interface Random {
	/** A uniform whole number from 0 to `bound - 1`. */
	below(bound: number): number;
}

/** The operating system's cryptographic randomness, for live tables (D-8). */
export const cryptoRandom: Random = {
	below: (bound) => randomInt(bound)
};

/**
 * A seeded generator for tests (SplitMix32 on a 32-bit state). It is not the
 * Python engine's Mersenne Twister, so seeded deals differ between the two;
 * differential tests pass whole deck orders instead.
 */
export function seededRandom(seed: number): Random {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x9e3779b9) >>> 0;
		let z = state;
		z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
		z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
		return (z ^ (z >>> 15)) >>> 0;
	};
	return {
		below(bound) {
			if (!Number.isInteger(bound) || bound < 1 || bound > 2 ** 32) {
				throw new RangeError('bound must be a whole number from 1 to 2^32');
			}
			// Rejection sampling keeps every result equally likely.
			const limit = 2 ** 32 - (2 ** 32 % bound);
			for (;;) {
				const value = next();
				if (value < limit) return value % bound;
			}
		}
	};
}

/** Shuffle in place the way Python's `random.shuffle` does (Fisher-Yates from the end). */
export function shuffle<T>(items: T[], rng: Random): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = rng.below(i + 1);
		[items[i], items[j]] = [items[j], items[i]];
	}
	return items;
}
