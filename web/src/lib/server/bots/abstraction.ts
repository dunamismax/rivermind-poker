// The hu-m1 action abstraction: a port of rivermind/bots/blueprint/abstraction.py
// (P4B.6, docs/bots.md). Sizes are exact fractions, as in Python, so the
// raise-to amounts round identically.

import {
	Action,
	PREFLOP,
	type ActionRecord,
	type LegalActions,
	type Street
} from '../engine/state.ts';

export const NAME = 'hu-m1';

/** A fraction as [numerator, denominator]. */
type Fraction = readonly [number, number];

const PREFLOP_MULTIPLES: readonly (readonly Fraction[])[] = [
	[
		[5, 2],
		[4, 1]
	],
	[
		[3, 1],
		[9, 2]
	],
	[[9, 4]]
];

const POSTFLOP_FRACTIONS: Record<1 | 2 | 3, readonly (readonly Fraction[])[]> = {
	1: [
		[
			[1, 3],
			[3, 4],
			[5, 4]
		],
		[[3, 4]],
		[[3, 4]]
	],
	2: [
		[
			[1, 2],
			[1, 1],
			[3, 2]
		],
		[[1, 1]]
	],
	3: [
		[
			[1, 2],
			[1, 1],
			[3, 2]
		],
		[[1, 1]]
	]
};

/** A size leaving less than 1/5 of the called pot behind becomes all-in. */
const ALL_IN_BEHIND: Fraction = [1, 5];

export interface AbstractAction {
	/** `f`, `k`, `c`, `b<i>` or `r<i>` (a size by its index in the row), or `a` (all-in). */
	readonly token: string;
	readonly action: Action;
}

export function sizes(street: Street, level: number): readonly Fraction[] {
	const rows = street === PREFLOP ? PREFLOP_MULTIPLES : POSTFLOP_FRACTIONS[street];
	return level < rows.length ? rows[level] : [];
}

/** Bets and raises made so far on `street`; the blinds are posts, not actions. */
export function streetLevel(actions: readonly ActionRecord[], street: Street): number {
	let n = 0;
	for (const a of actions) if (a.street === street && (a.kind === 'bet' || a.kind === 'raise')) n++;
	return n;
}

/** The raise-to total a size asks for, rounded to whole chips with halves up: floor(x + 1/2). */
function sizeTo(
	street: Street,
	[n, d]: Fraction,
	pot: number,
	currentBet: number,
	owed: number
): number {
	// x = n·cb/d pre-flop, cb + n·(pot + owed)/d after; floor(x + 1/2) = floor((2·num + den) / (2·den)).
	const num = street === PREFLOP ? n * currentBet : currentBet * d + n * (pot + owed);
	return Math.floor((2 * num + d) / (2 * d));
}

/** The node's actions in their fixed order: fold, check or call, sizes ascending, all-in. Heads-up only. */
export function abstractActions(
	legal: LegalActions,
	street: Street,
	level: number,
	pot: number,
	currentBet: number,
	streetBets: readonly number[]
): AbstractAction[] {
	const seat = legal.seat;
	const found: AbstractAction[] = [];
	if (legal.canFold) found.push({ token: 'f', action: Action.fold() });
	if (legal.canCheck) found.push({ token: 'k', action: Action.check() });
	else if (legal.call > 0) found.push({ token: 'c', action: Action.call() });
	const kind = legal.raiseKind;
	if (kind === null) return found;
	const letter = kind === 'bet' ? 'b' : 'r';
	const owed = currentBet - streetBets[seat];
	// The opponent is the other seat with chips in; empty seats bet nothing.
	const other = Math.max(...streetBets.filter((_, s) => s !== seat));
	const seen = new Set<number>();
	sizes(street, level).forEach((size, i) => {
		const to = Math.max(sizeTo(street, size, pot, currentBet, owed), legal.minTo);
		if (to >= legal.maxTo || seen.has(to)) return;
		const calledPot = pot - streetBets[seat] - other + 2 * to;
		// (max_to − to) < 1/5 × called pot, in whole numbers.
		if ((legal.maxTo - to) * ALL_IN_BEHIND[1] < ALL_IN_BEHIND[0] * calledPot) return;
		seen.add(to);
		found.push({ token: `${letter}${i}`, action: Action.of(kind, to) });
	});
	found.push({ token: 'a', action: Action.of(kind, legal.maxTo) });
	return found;
}
