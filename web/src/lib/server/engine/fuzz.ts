// Self-play fuzzing, random legal play with random stacks, checking
// invariants: a port of rivermind/engine/fuzz.py. The TypeScript generator is
// not Python's, so these hands differ from the Python ones; parity with the
// reference comes from replaying Python's hands (scripts/engine-parity.ts).

import type { Random } from './random.ts';
import {
	Action,
	IllegalActionError,
	allows,
	apply,
	handConfig,
	isOver,
	legalActions,
	potTotal,
	startHand,
	type HandConfig,
	type HandState,
	type LegalActions
} from './state.ts';

export const MAX_ACTIONS = 4_000;

/** An engine invariant failed. */
export class InvariantError extends Error {
	override name = 'InvariantError';
}

/** A uniform number in [0, 1), like Python's `random()`. */
export function uniform(rng: Random): number {
	return rng.below(2 ** 32) / 2 ** 32;
}

/** A uniform whole number from `lo` to `hi` inclusive, like Python's `randint`. */
export function randint(rng: Random, lo: number, hi: number): number {
	return lo + rng.below(hi - lo + 1);
}

export function choice<T>(rng: Random, items: readonly T[]): T {
	return items[rng.below(items.length)];
}

export function randomConfig(rng: Random): HandConfig {
	if (uniform(rng) < 0.5) return handConfig(50, 100, choice(rng, [0, 0, 10, 25]));
	const small = randint(rng, 1, 50);
	const big = randint(rng, small, 2 * small);
	return handConfig(small, big, choice(rng, [0, 0, 0, randint(rng, 1, big)]));
}

/** Mostly deep stacks, with empty seats and short stacks mixed in. */
export function randomStacks(numSeats: number, config: HandConfig, rng: Random): (number | null)[] {
	for (;;) {
		const stacks: (number | null)[] = [];
		for (let i = 0; i < numSeats; i++) {
			const roll = uniform(rng);
			if (roll < 0.15) stacks.push(null);
			else if (roll < 0.35) stacks.push(randint(rng, 1, 3 * config.bigBlind));
			else stacks.push(randint(rng, config.bigBlind, 300 * config.bigBlind));
		}
		if (stacks.filter((s) => s).length >= 2) return stacks;
	}
}

/**
 * A random legal action, weighted so hands often reach later streets.
 *
 * Folds, passive and aggressive actions are weighted 2:6:2 (when legal), and
 * bet sizes mix the minimum, half pot, pot, a uniform pick and all-in.
 */
export function randomAction(state: HandState, legal: LegalActions, rng: Random): Action {
	const roll = uniform(rng);
	const passive = legal.canCheck ? Action.check() : Action.call();
	if (legal.canFold && roll < 0.2) return Action.fold();
	if (legal.raiseKind === null || roll < 0.8) return passive;
	const lo = legal.minTo;
	const hi = legal.maxTo;
	const potTo =
		state.currentBet + potTotal(state) + (state.currentBet - state.streetBets[legal.seat]);
	const sizeRoll = uniform(rng);
	let size: number;
	if (sizeRoll < 0.4) size = lo;
	else if (sizeRoll < 0.6) size = Math.floor(potTo / 2);
	else if (sizeRoll < 0.8) size = potTo;
	else if (sizeRoll < 0.95) size = randint(rng, lo, hi);
	else size = hi;
	return Action.of(legal.raiseKind, Math.min(Math.max(lo, size), hi));
}

/** Actions just outside the legal set, all of which must be rejected. */
export function illegalNear(state: HandState, legal: LegalActions): Action[] {
	const bad: Action[] = [];
	if (!legal.canFold) bad.push(Action.fold());
	if (!legal.canCheck) bad.push(Action.check());
	if (!legal.call) bad.push(Action.call());
	if (legal.raiseKind === null) {
		bad.push(Action.bet(state.currentBet + state.config.bigBlind));
		bad.push(Action.raiseTo(state.currentBet + state.config.bigBlind));
	} else {
		const other = legal.raiseKind === 'bet' ? 'raise' : 'bet';
		bad.push(Action.of(other, legal.minTo));
		bad.push(Action.of(legal.raiseKind, legal.minTo - 1));
		bad.push(Action.of(legal.raiseKind, legal.maxTo + 1));
		bad.push(Action.of(legal.raiseKind, null));
		bad.push(Action.of(legal.raiseKind, legal.minTo + 0.5));
	}
	bad.push(Action.of('call', legal.call));
	return bad;
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** Invariants that hold at every point of a hand. */
export function checkState(state: HandState, total: number): void {
	const stacks = state.stacks;
	const over = isOver(state);
	if (
		Math.min(...stacks) < 0 ||
		Math.min(...state.contributions) < 0 ||
		Math.min(...state.streetBets) < 0
	) {
		throw new InvariantError('a stack, bet or contribution went negative');
	}
	if (sum(stacks) + (over ? 0 : potTotal(state)) !== total) {
		throw new InvariantError('chips were not conserved');
	}
	state.streetBets.forEach((bet, seat) => {
		if (bet > state.contributions[seat] && !over) {
			throw new InvariantError('street bet exceeds contribution');
		}
		if (!state.dealtIn[seat] && (stacks[seat] || state.contributions[seat])) {
			throw new InvariantError('a seat not dealt in holds chips');
		}
	});
	if (!over) {
		const seat = state.toAct;
		if (seat === null || !state.dealtIn[seat] || state.folded[seat] || stacks[seat] === 0) {
			throw new InvariantError('the player to act cannot act');
		}
		return;
	}
	const result = state.result!;
	if (state.toAct !== null) throw new InvariantError('a finished hand has a player to act');
	const putIn = sum(state.contributions);
	if (sum(result.pots.map((p) => p.amount)) !== putIn) {
		throw new InvariantError('pots do not equal what was put in');
	}
	if (sum(result.winnings) !== putIn) throw new InvariantError('winnings do not equal the pots');
	state.startingStacks.forEach((start, seat) => {
		if (!state.dealtIn[seat]) return;
		if (stacks[seat] !== (start as number) - state.contributions[seat] + result.winnings[seat]) {
			throw new InvariantError('a final stack does not match its payouts');
		}
	});
	const live = stacks.map((_, s) => s).filter((s) => state.dealtIn[s] && !state.folded[s]);
	if (result.showdown) {
		if (state.board.length !== 5 || live.length < 2) {
			throw new InvariantError('a showdown needs a full board and two players');
		}
		const showed = [...result.shown, ...result.mucked].sort((a, b) => a - b);
		if (showed.join() !== live.join()) {
			throw new InvariantError('every player at showdown shows or mucks');
		}
	} else if (live.length !== 1) {
		throw new InvariantError('a hand without showdown has one player left');
	}
}

/** Play one random hand, checking invariants after every action. */
export function playRandomHand(
	numSeats: number,
	rng: Random,
	{ checkIllegal = true }: { checkIllegal?: boolean } = {}
): HandState {
	const config = randomConfig(rng);
	const stacks = randomStacks(numSeats, config, rng);
	const dealt = stacks.map((_, s) => s).filter((s) => stacks[s]);
	let state = startHand(config, stacks, choice(rng, dealt), { rng });
	const total = sum(stacks.map((s) => s ?? 0));
	checkState(state, total);
	let steps = 0;
	while (!isOver(state)) {
		const legal = legalActions(state);
		if (checkIllegal) {
			for (const bad of illegalNear(state, legal)) {
				let accepted = true;
				try {
					apply(state, bad);
				} catch (error) {
					if (!(error instanceof IllegalActionError)) throw error;
					accepted = false;
				}
				if (accepted) throw new InvariantError(`illegal action accepted: ${JSON.stringify(bad)}`);
			}
		}
		const action = randomAction(state, legal, rng);
		if (!allows(legal, action)) {
			throw new InvariantError(`chooser picked an illegal action: ${JSON.stringify(action)}`);
		}
		state = apply(state, action);
		checkState(state, total);
		if (++steps > MAX_ACTIONS) throw new InvariantError('the hand did not end');
	}
	return state;
}
