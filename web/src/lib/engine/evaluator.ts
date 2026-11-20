// Hand ranking for five to seven cards (rule 10): a port of
// rivermind/engine/evaluator.py, which stays the reference (P4B.4).
//
// Adapted from the Deuces evaluator by Will Drevo (MIT licence, see
// licenses/Deuces.txt), which is a variant of Cactus Kev's algorithm. Ranks
// run from 1 (a royal flush) to 7462 (7-5-4-3-2 offsuit), lower is better.
// Non-flush hands are keyed on the product of their rank primes (a unique
// number for each multiset of ranks, below 2^53 for seven cards) and the best
// five-card subset is memoized; flushes are scored on the suited cards alone,
// since a seven-card hand holding a flush cannot also hold four of a kind or a
// full house. This module is safe for browsers.

export const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41] as const;

export const MAX_STRAIGHT_FLUSH = 10;
export const MAX_FOUR_OF_A_KIND = 166;
export const MAX_FULL_HOUSE = 322;
export const MAX_FLUSH = 1599;
export const MAX_STRAIGHT = 1609;
export const MAX_THREE_OF_A_KIND = 2467;
export const MAX_TWO_PAIR = 3325;
export const MAX_PAIR = 6185;
export const MAX_HIGH_CARD = 7462;

export const CLASS_NAMES = [
	'Straight Flush',
	'Four of a Kind',
	'Full House',
	'Flush',
	'Straight',
	'Three of a Kind',
	'Two Pair',
	'Pair',
	'High Card'
] as const;

const CLASS_LIMITS = [
	MAX_STRAIGHT_FLUSH,
	MAX_FOUR_OF_A_KIND,
	MAX_FULL_HOUSE,
	MAX_FLUSH,
	MAX_STRAIGHT,
	MAX_THREE_OF_A_KIND,
	MAX_TWO_PAIR,
	MAX_PAIR,
	MAX_HIGH_CARD
];

const CARD_PRIME = Array.from({ length: 52 }, (_, c) => PRIMES[c >> 2]);

/** The r-element combinations of `items`, in the order of Python's itertools. */
export function* combinations<T>(items: readonly T[], r: number): Generator<T[]> {
	const n = items.length;
	if (r > n) return;
	const index = Array.from({ length: r }, (_, i) => i);
	yield index.map((i) => items[i]);
	for (;;) {
		let i = r - 1;
		while (i >= 0 && index[i] === i + n - r) i--;
		if (i < 0) return;
		index[i]++;
		for (let j = i + 1; j < r; j++) index[j] = index[j - 1] + 1;
		yield index.map((k) => items[k]);
	}
}

function key(ranks: readonly number[]): number {
	let product = 1;
	for (const r of ranks) product *= PRIMES[r];
	return product;
}

function buildTables(): [Map<number, number>, Map<number, number>] {
	const desc = Array.from({ length: 13 }, (_, i) => 12 - i);
	const straights: number[][] = [];
	for (let top = 12; top > 3; top--) straights.push([top, top - 1, top - 2, top - 3, top - 4]);
	straights.push([3, 2, 1, 0, 12]);
	const straightKeys = new Set(straights.map(key));
	const highs = [...combinations(desc, 5)].filter((c) => !straightKeys.has(key(c)));

	const flush = new Map<number, number>();
	const unsuited = new Map<number, number>();
	let value = 1;
	for (const s of straights) flush.set(key(s), value++);
	for (const quad of desc) {
		for (const kicker of desc) {
			if (kicker !== quad) unsuited.set(key([quad, quad, quad, quad, kicker]), value++);
		}
	}
	for (const trips of desc) {
		for (const pair of desc) {
			if (pair !== trips) unsuited.set(key([trips, trips, trips, pair, pair]), value++);
		}
	}
	for (const c of highs) flush.set(key(c), value++);
	for (const s of straights) unsuited.set(key(s), value++);
	for (const trips of desc) {
		for (const kickers of combinations(
			desc.filter((r) => r !== trips),
			2
		)) {
			unsuited.set(key([trips, trips, trips, ...kickers]), value++);
		}
	}
	for (const pairs of combinations(desc, 2)) {
		for (const kicker of desc) {
			if (!pairs.includes(kicker)) unsuited.set(key([...pairs, ...pairs, kicker]), value++);
		}
	}
	for (const pair of desc) {
		for (const kickers of combinations(
			desc.filter((r) => r !== pair),
			3
		)) {
			unsuited.set(key([pair, pair, ...kickers]), value++);
		}
	}
	for (const c of highs) unsuited.set(key(c), value++);
	if (value - 1 !== MAX_HIGH_CARD) throw new Error('evaluator tables are inconsistent');
	return [flush, unsuited];
}

const [FLUSH, UNSUITED] = buildTables();
const BEST_UNSUITED = new Map<number, number>();

function bestOfFive(primes: readonly number[], table: Map<number, number>): number {
	const n = primes.length;
	let best = MAX_HIGH_CARD;
	for (let a = 0; a < n - 4; a++) {
		for (let b = a + 1; b < n - 3; b++) {
			for (let c = b + 1; c < n - 2; c++) {
				for (let d = c + 1; d < n - 1; d++) {
					const partial = primes[a] * primes[b] * primes[c] * primes[d];
					for (let e = d + 1; e < n; e++) {
						const value = table.get(partial * primes[e]) as number;
						if (value < best) best = value;
					}
				}
			}
		}
	}
	return best;
}

/** Rank the best five-card hand from five to seven cards; lower is better. */
export function evaluate(cards: readonly number[]): number {
	const size = cards.length;
	if (size < 5 || size > 7) throw new RangeError('evaluate takes five to seven cards');
	let clubs = 0;
	let diamonds = 0;
	let hearts = 0;
	let spades = 0;
	let product = 1;
	for (let i = 0; i < size; i++) {
		const c = cards[i];
		const s = c & 3;
		if (s === 0) clubs++;
		else if (s === 1) diamonds++;
		else if (s === 2) hearts++;
		else spades++;
		product *= CARD_PRIME[c];
	}
	const flushSuit = clubs >= 5 ? 0 : diamonds >= 5 ? 1 : hearts >= 5 ? 2 : spades >= 5 ? 3 : -1;
	if (flushSuit >= 0) {
		const suited: number[] = [];
		for (let i = 0; i < size; i++)
			if ((cards[i] & 3) === flushSuit) suited.push(CARD_PRIME[cards[i]]);
		return bestOfFive(suited, FLUSH);
	}
	let value = BEST_UNSUITED.get(product);
	if (value === undefined) {
		value =
			size === 5
				? (UNSUITED.get(product) as number)
				: bestOfFive(
						cards.map((c) => CARD_PRIME[c]),
						UNSUITED
					);
		BEST_UNSUITED.set(product, value);
	}
	return value;
}

/** Hand class from 1 (straight flush) to 9 (high card). */
export function rankClass(value: number): number {
	for (let i = 0; i < CLASS_LIMITS.length; i++) if (value <= CLASS_LIMITS[i]) return i + 1;
	throw new RangeError(`not a hand rank: ${value}`);
}

/** Name of the hand class, such as "Two Pair". */
export function describe(value: number): string {
	return CLASS_NAMES[rankClass(value) - 1];
}
