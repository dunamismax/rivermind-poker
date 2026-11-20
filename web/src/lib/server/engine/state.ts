// The no-limit hold'em hand as an immutable state machine: a port of
// rivermind/engine/state.py, which stays the reference (P4B.4).
//
// `startHand` posts antes and blinds, deals hole cards and returns the first
// `HandState`. `legalActions` describes what the player to act may do and
// `apply` returns the next state. States are never changed in place, so any
// state can be kept, compared, serialized or explored further. Every rule
// number refers to docs/rules.md.
//
// The engine takes randomness only from its caller (rule 1.1): pass either a
// complete deck order or a random generator to `startHand`.

import { DECK_SIZE } from '../../engine/cards.ts';
import { evaluate } from '../../engine/evaluator.ts';
import { buildPots, split, uncalledBet, type Pot } from './pots.ts';
import { shuffle, type Random } from './random.ts';
import { blindSeats, dealOrder } from './seating.ts';

export type Street = 0 | 1 | 2 | 3;
export const PREFLOP = 0;
export const FLOP = 1;
export const TURN = 2;
export const RIVER = 3;
export const STREET_LABELS = ['pre-flop', 'flop', 'turn', 'river'] as const;

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise';
export type RaiseKind = 'bet' | 'raise';
export const ACTION_KINDS: readonly ActionKind[] = ['fold', 'check', 'call', 'bet', 'raise'];

export type PostKind = 'ante' | 'small_blind' | 'big_blind';
export const POST_KINDS: readonly PostKind[] = ['ante', 'small_blind', 'big_blind'];

/** The action is not one of the legal actions for the player to act. */
export class IllegalActionError extends Error {
	override name = 'IllegalActionError';
}

/** Stakes for one hand. Chips are whole numbers (Conventions). */
export interface HandConfig {
	readonly smallBlind: number;
	readonly bigBlind: number;
	readonly ante: number;
}

export function handConfig(smallBlind: number, bigBlind: number, ante = 0): HandConfig {
	for (const [name, value] of [
		['small_blind', smallBlind],
		['big_blind', bigBlind],
		['ante', ante]
	] as const) {
		if (!Number.isInteger(value)) throw new TypeError(`${name} must be an int`);
	}
	if (!(0 < smallBlind && smallBlind <= bigBlind)) {
		throw new RangeError('blinds must satisfy 0 < small blind <= big blind');
	}
	if (ante < 0) throw new RangeError('ante must not be negative');
	return Object.freeze({ smallBlind, bigBlind, ante });
}

/** A decision. For a bet or raise, `amount` is the new street total (Conventions). */
export interface Action {
	readonly kind: ActionKind;
	readonly amount: number | null;
}

export const Action = {
	fold: (): Action => ({ kind: 'fold', amount: null }),
	check: (): Action => ({ kind: 'check', amount: null }),
	call: (): Action => ({ kind: 'call', amount: null }),
	bet: (to: number): Action => ({ kind: 'bet', amount: to }),
	raiseTo: (to: number): Action => ({ kind: 'raise', amount: to }),
	of: (kind: ActionKind, amount: number | null = null): Action => ({ kind, amount })
};

/** An ante or blind posted before the cards are dealt. */
export interface Post {
	readonly seat: number;
	readonly kind: PostKind;
	readonly amount: number;
	readonly allIn: boolean;
}

/** An applied action. `to` is the seat's street bet afterwards. */
export interface ActionRecord {
	readonly seat: number;
	readonly street: Street;
	readonly kind: ActionKind;
	readonly to: number;
	readonly added: number;
	readonly allIn: boolean;
}

/**
 * What the player to act may do (rule 7.7).
 *
 * `call` is the number of chips a call adds, which is less than the amount
 * owed when calling puts the player all-in; it is 0 when there is nothing to
 * call. `raiseKind` is "bet" or "raise" when the player may bet or raise, with
 * `minTo` and `maxTo` the allowed street totals.
 */
export interface LegalActions {
	readonly seat: number;
	readonly canFold: boolean;
	readonly canCheck: boolean;
	readonly call: number;
	readonly raiseKind: RaiseKind | null;
	readonly minTo: number;
	readonly maxTo: number;
}

/** Whether `legal` allows `action`. */
export function allows(legal: LegalActions, action: Action): boolean {
	const kind = action.kind;
	const amount = action.amount ?? null;
	if (kind === 'fold') return legal.canFold && amount === null;
	if (kind === 'check') return legal.canCheck && amount === null;
	if (kind === 'call') return legal.call > 0 && amount === null;
	return (
		kind === legal.raiseKind &&
		Number.isInteger(amount) &&
		legal.minTo <= (amount as number) &&
		(amount as number) <= legal.maxTo
	);
}

/** The legal actions, with a bet or raise at its minimum and maximum. */
export function options(legal: LegalActions): Action[] {
	const found: Action[] = [];
	if (legal.canFold) found.push(Action.fold());
	if (legal.canCheck) found.push(Action.check());
	if (legal.call) found.push(Action.call());
	if (legal.raiseKind !== null) {
		found.push(Action.of(legal.raiseKind, legal.minTo));
		if (legal.maxTo !== legal.minTo) found.push(Action.of(legal.raiseKind, legal.maxTo));
	}
	return found;
}

/** How a finished hand was settled (rules 9, 11 and 12). */
export interface HandResult {
	/** Seat and amount of an uncalled bet returned before the pots were formed. */
	readonly uncalled: readonly [number, number] | null;
	readonly pots: readonly Pot[];
	/** Whether two or more players reached showdown. */
	readonly showdown: boolean;
	/** Whether every hand was turned face up at once (rule 12.1). */
	readonly tabled: boolean;
	/** Seats whose hands were shown, in showing order. */
	readonly shown: readonly number[];
	/** Seats whose hands were mucked unseen (rule 12.3), in showing order. */
	readonly mucked: readonly number[];
	/** Evaluator rank per seat for players at showdown, otherwise null. */
	readonly handRanks: readonly (number | null)[];
	/** Chips won from the pots per seat, not counting a returned uncalled bet. */
	readonly winnings: readonly number[];
}

export type HoleCards = readonly [number, number];

/** One moment of a hand. Per-seat arrays are indexed by seat number. */
export interface HandState {
	readonly config: HandConfig;
	readonly button: number;
	readonly smallBlindSeat: number;
	readonly bigBlindSeat: number;
	readonly startingStacks: readonly (number | null)[];
	readonly deck: readonly number[];
	readonly dealtIn: readonly boolean[];
	readonly holeCards: readonly (HoleCards | null)[];
	/** Chips behind for players dealt in, and 0 for every other seat. */
	readonly stacks: readonly number[];
	readonly streetBets: readonly number[];
	readonly contributions: readonly number[];
	readonly folded: readonly boolean[];
	/** The current bet just after each seat last acted on this street (rule 8.1). */
	readonly actedAt: readonly (number | null)[];
	readonly street: Street;
	readonly board: readonly number[];
	readonly currentBet: number;
	/** The minimum raise increment on this street (rule 7.4). */
	readonly minRaise: number;
	readonly toAct: number | null;
	readonly posts: readonly Post[];
	readonly actions: readonly ActionRecord[];
	readonly result: HandResult | null;
}

export function numSeats(state: HandState): number {
	return state.startingStacks.length;
}

export function isOver(state: HandState): boolean {
	return state.result !== null;
}

/** Everything put in so far, including the current street's bets. */
export function potTotal(state: HandState): number {
	let total = 0;
	for (const amount of state.contributions) total += amount;
	return total;
}

/** Players dealt in, clockwise from the player left of the button. */
export function seatOrder(state: HandState): number[] {
	return dealOrder(state.button, trueSeats(state.dealtIn), numSeats(state));
}

/** Stacks for the seats dealt in, null elsewhere; final once the hand is over. */
export function finalStacks(state: HandState): (number | null)[] {
	return state.stacks.map((stack, seat) => (state.dealtIn[seat] ? stack : null));
}

function trueSeats(flags: readonly boolean[]): Set<number> {
	const seats = new Set<number>();
	flags.forEach((flag, seat) => {
		if (flag) seats.add(seat);
	});
	return seats;
}

export interface Deal {
	/** A complete 52-card order. */
	readonly deck?: readonly number[];
	/** A generator that shuffles one. */
	readonly rng?: Random;
}

/**
 * Post antes and blinds and deal hole cards for a new hand.
 *
 * `stacks` has one entry per seat (2 to 9 seats). A seat with null or 0 chips
 * is not dealt in (rule 2.1); the table leaves sitting-out players as null.
 * `button` must be a seat dealt in; the table chooses it with `initialButton`
 * and `nextButton`. Supply exactly one of `deck` and `rng`.
 */
export function startHand(
	config: HandConfig,
	stacks: readonly (number | null)[],
	button: number,
	{ deck, rng }: Deal
): HandState {
	const seats = stacks.length;
	if (seats < 2 || seats > 9) throw new RangeError('a table has 2 to 9 seats');
	for (const stack of stacks) {
		if (stack !== null && (!Number.isInteger(stack) || stack < 0)) {
			throw new RangeError('stacks must be None or whole numbers of chips');
		}
	}
	const dealt = stacks.map((stack) => Boolean(stack));
	const inHand = trueSeats(dealt);
	if (inHand.size < 2) throw new RangeError('a hand needs at least two players dealt in');
	if (!(Number.isInteger(button) && button >= 0 && button < seats && dealt[button])) {
		throw new RangeError('the button must be a player dealt in');
	}
	if ((deck === undefined) === (rng === undefined)) {
		throw new RangeError('pass exactly one of deck and rng');
	}
	let deckOrder: number[];
	if (deck === undefined) {
		deckOrder = shuffle(
			Array.from({ length: DECK_SIZE }, (_, c) => c),
			rng as Random
		);
	} else {
		deckOrder = [...deck];
		const distinct = new Set(deckOrder);
		if (
			deckOrder.length !== DECK_SIZE ||
			distinct.size !== DECK_SIZE ||
			!deckOrder.every((c) => Number.isInteger(c) && c >= 0 && c < DECK_SIZE)
		) {
			throw new RangeError('deck must be an order of all 52 cards');
		}
	}

	const [smallSeat, bigSeat] = blindSeats(button, inHand, seats);
	const order = dealOrder(button, inHand, seats);
	const chips = stacks.map((stack) => stack ?? 0);
	const bets: number[] = new Array(seats).fill(0);
	const contributed: number[] = new Array(seats).fill(0);
	const posts: Post[] = [];

	const post = (seat: number, kind: PostKind, amount: number, streetBet: boolean) => {
		const paid = Math.min(amount, chips[seat]);
		chips[seat] -= paid;
		contributed[seat] += paid;
		if (streetBet) bets[seat] += paid;
		posts.push({ seat, kind, amount: paid, allIn: chips[seat] === 0 });
	};

	if (config.ante) for (const seat of order) post(seat, 'ante', config.ante, false);
	post(smallSeat, 'small_blind', config.smallBlind, true);
	post(bigSeat, 'big_blind', config.bigBlind, true);

	const n = order.length;
	const holes: (HoleCards | null)[] = new Array(seats).fill(null);
	order.forEach((seat, i) => (holes[seat] = [deckOrder[i], deckOrder[n + i]]));

	const state: HandState = {
		config,
		button,
		smallBlindSeat: smallSeat,
		bigBlindSeat: bigSeat,
		startingStacks: [...stacks],
		deck: deckOrder,
		dealtIn: dealt,
		holeCards: holes,
		stacks: chips,
		streetBets: bets,
		contributions: contributed,
		folded: new Array(seats).fill(false),
		actedAt: new Array(seats).fill(null),
		street: PREFLOP,
		board: [],
		currentBet: config.bigBlind,
		minRaise: config.bigBlind,
		toAct: null,
		posts,
		actions: [],
		result: null
	};
	// Rule 6.2: pre-flop the first to act is left of the big blind, or the
	// button heads-up.
	const first = n === 2 ? button : order[2 % n];
	return new Builder(state).advance(first);
}

/** The legal actions for the player to act (rules 7 and 8). */
export function legalActions(state: HandState): LegalActions {
	const seat = state.toAct;
	if (seat === null) throw new IllegalActionError('the hand is over');
	const stack = state.stacks[seat];
	const streetBet = state.streetBets[seat];
	const current = state.currentBet;
	const owed = current - streetBet;
	const canFold = owed > 0;
	const canCheck = !canFold;
	const call = canFold ? Math.min(owed, stack) : 0;
	if (stack > owed) {
		const acted = state.actedAt[seat];
		// Rule 8: a player who has acted may raise again only after a full raise
		// in total. Rule 7.8: there must be someone left to call it.
		const reopened = acted === null || current - acted >= state.minRaise;
		if (reopened && anyoneElseHasChips(state, seat)) {
			const most = streetBet + stack;
			const least = Math.min(current + state.minRaise, most);
			const raiseKind = current === 0 ? 'bet' : 'raise';
			return { seat, canFold, canCheck, call, raiseKind, minTo: least, maxTo: most };
		}
	}
	return { seat, canFold, canCheck, call, raiseKind: null, minTo: 0, maxTo: 0 };
}

/** Rule 13.1: when the clock runs out, check if possible, otherwise fold. */
export function timeoutAction(state: HandState): Action {
	return legalActions(state).canCheck ? Action.check() : Action.fold();
}

function anyoneElseHasChips(state: HandState, seat: number): boolean {
	const { stacks, folded, dealtIn } = state;
	for (let other = 0; other < stacks.length; other++) {
		if (other !== seat && dealtIn[other] && !folded[other] && stacks[other] > 0) return true;
	}
	return false;
}

function describeAction(action: unknown): string {
	try {
		return JSON.stringify(action) ?? String(action);
	} catch {
		return String(action);
	}
}

/**
 * Apply a legal action and return the next state.
 *
 * Throws `IllegalActionError` (leaving `state` untouched) for anything that
 * `legalActions` does not allow.
 */
export function apply(state: HandState, action: Action): HandState {
	const legal = legalActions(state);
	if (
		typeof action !== 'object' ||
		action === null ||
		!ACTION_KINDS.includes(action.kind) ||
		!allows(legal, action)
	) {
		throw new IllegalActionError(
			`${describeAction(action)} is not legal; legal actions are ${JSON.stringify(legal)}`
		);
	}
	const seat = legal.seat;
	const builder = new Builder(state);
	const kind = action.kind;
	let added: number;
	if (kind === 'fold') {
		builder.folded[seat] = true;
		added = 0;
	} else if (kind === 'check') {
		added = 0;
	} else if (kind === 'call') {
		added = legal.call;
	} else {
		const to = action.amount as number;
		added = to - state.streetBets[seat];
		const increment = to - state.currentBet;
		if (increment >= state.minRaise) builder.minRaise = increment;
		builder.currentBet = to;
	}
	builder.stacks[seat] -= added;
	builder.streetBets[seat] += added;
	builder.contributions[seat] += added;
	builder.actedAt[seat] = builder.currentBet;
	builder.actions.push({
		seat,
		street: state.street,
		kind,
		to: builder.streetBets[seat],
		added,
		allIn: builder.stacks[seat] === 0 && kind !== 'fold'
	});
	return builder.advance((seat + 1) % numSeats(state));
}

/** Mutable working copy of a state, used inside one transition. */
class Builder {
	readonly base: HandState;
	stacks: number[];
	streetBets: number[];
	contributions: number[];
	folded: boolean[];
	actedAt: (number | null)[];
	street: Street;
	board: readonly number[];
	currentBet: number;
	minRaise: number;
	actions: ActionRecord[];
	toAct: number | null = null;
	result: HandResult | null = null;

	constructor(state: HandState) {
		this.base = state;
		this.stacks = [...state.stacks];
		this.streetBets = [...state.streetBets];
		this.contributions = [...state.contributions];
		this.folded = [...state.folded];
		this.actedAt = [...state.actedAt];
		this.street = state.street;
		this.board = state.board;
		this.currentBet = state.currentBet;
		this.minRaise = state.minRaise;
		this.actions = [...state.actions];
	}

	build(): HandState {
		const base = this.base;
		return {
			config: base.config,
			button: base.button,
			smallBlindSeat: base.smallBlindSeat,
			bigBlindSeat: base.bigBlindSeat,
			startingStacks: base.startingStacks,
			deck: base.deck,
			dealtIn: base.dealtIn,
			holeCards: base.holeCards,
			stacks: this.stacks,
			streetBets: this.streetBets,
			contributions: this.contributions,
			folded: this.folded,
			actedAt: this.actedAt,
			street: this.street,
			board: this.board,
			currentBet: this.currentBet,
			minRaise: this.minRaise,
			toAct: this.toAct,
			posts: base.posts,
			actions: this.actions,
			result: this.result
		};
	}

	/** Find the next player to act from `start` clockwise, or move the hand on. */
	advance(start: number): HandState {
		const dealt = this.base.dealtIn;
		const seats = dealt.length;
		for (;;) {
			const live: number[] = [];
			for (let s = 0; s < seats; s++) if (dealt[s] && !this.folded[s]) live.push(s);
			if (live.length === 1) {
				this.settle(live, false, false);
				return this.build();
			}
			const active = live.filter((s) => this.stacks[s] > 0);
			const current = this.currentBet;
			// Rule 6.4: no more betting once at most one player still in has chips
			// and has matched the current bet.
			if (active.length === 0 || (active.length === 1 && this.streetBets[active[0]] >= current)) {
				this.dealThrough(RIVER);
				this.settle(live, true, true);
				return this.build();
			}
			for (let step = 0; step < seats; step++) {
				const seat = (start + step) % seats;
				if (this.stacks[seat] > 0 && dealt[seat] && !this.folded[seat]) {
					if (this.actedAt[seat] === null || this.streetBets[seat] < current) {
						this.toAct = seat;
						return this.build();
					}
				}
			}
			// Rule 6.3: the betting round is complete.
			if (this.street === RIVER) {
				this.settle(live, true, false);
				return this.build();
			}
			this.dealThrough((this.street + 1) as Street);
			this.streetBets = new Array(seats).fill(0);
			this.actedAt = new Array(seats).fill(null);
			this.currentBet = 0;
			this.minRaise = this.base.config.bigBlind;
			start = (this.base.button + 1) % seats;
		}
	}

	/** Deal board cards up to `street` (rules 1.3 and 1.4). */
	dealThrough(street: Street): void {
		let n = 0;
		for (const flag of this.base.dealtIn) if (flag) n++;
		const deck = this.base.deck;
		const board = [...this.board];
		if (street >= FLOP && board.length < 3) board.push(...deck.slice(2 * n + 1, 2 * n + 4));
		if (street >= TURN && board.length < 4) board.push(deck[2 * n + 5]);
		if (street >= RIVER && board.length < 5) board.push(deck[2 * n + 7]);
		this.board = board;
		this.street = Math.max(this.street, street) as Street;
	}

	settle(live: number[], showdown: boolean, tabled: boolean): void {
		const base = this.base;
		const seats = base.dealtIn.length;
		const contributions = [...this.contributions];
		const uncalled = uncalledBet(contributions);
		if (uncalled !== null) {
			const [seat, amount] = uncalled;
			contributions[seat] -= amount;
			this.stacks[seat] += amount;
			this.contributions[seat] -= amount;
		}
		const pots = buildPots(contributions, live);
		const ranks: (number | null)[] = new Array(seats).fill(null);
		let shown: number[] = [];
		let mucked: number[] = [];
		if (showdown) {
			for (const seat of live) {
				const hole = base.holeCards[seat] as HoleCards;
				ranks[seat] = evaluate([...hole, ...this.board]);
			}
			[shown, mucked] = showOrder(base, this.actions, live, pots, ranks, tabled);
		}
		const winnings: number[] = new Array(seats).fill(0);
		const awarded: Pot[] = [];
		for (const pot of pots) {
			let winners: number[];
			if (showdown) {
				let best = Infinity;
				for (const s of pot.eligible) best = Math.min(best, ranks[s] as number);
				winners = pot.eligible.filter((s) => ranks[s] === best);
			} else {
				winners = [...pot.eligible];
			}
			const [ordered, shares] = split(pot.amount, winners, base.button, seats);
			ordered.forEach((seat, i) => {
				winnings[seat] += shares[i];
				this.stacks[seat] += shares[i];
			});
			awarded.push({ amount: pot.amount, eligible: pot.eligible, winners: ordered, shares });
		}
		this.toAct = null;
		this.result = {
			uncalled,
			pots: awarded,
			showdown,
			tabled,
			shown,
			mucked,
			handRanks: ranks,
			winnings
		};
	}
}

/** Rule 12: which hands are shown, in order, and which are mucked. */
function showOrder(
	base: HandState,
	actions: readonly ActionRecord[],
	live: readonly number[],
	pots: readonly Pot[],
	ranks: readonly (number | null)[],
	tabled: boolean
): [number[], number[]] {
	const seats = base.dealtIn.length;
	let first = (base.button + 1) % seats;
	if (!tabled) {
		for (let i = actions.length - 1; i >= 0; i--) {
			const record = actions[i];
			if (record.street !== RIVER) break;
			if (record.kind === 'bet' || record.kind === 'raise') {
				first = record.seat;
				break;
			}
		}
	}
	const distance = (seat: number) => (((seat - first) % seats) + seats) % seats;
	const order = [...live].sort((a, b) => distance(a) - distance(b));
	if (tabled) return [order, []];
	const best: (number | null)[] = new Array(pots.length).fill(null);
	const shown: number[] = [];
	const mucked: number[] = [];
	for (const seat of order) {
		const rank = ranks[seat] as number;
		const eligible: number[] = [];
		pots.forEach((pot, i) => {
			if (pot.eligible.includes(seat)) eligible.push(i);
		});
		if (eligible.some((i) => best[i] === null || rank <= (best[i] as number))) {
			shown.push(seat);
			for (const i of eligible) {
				if (best[i] === null || rank < (best[i] as number)) best[i] = rank;
			}
		} else {
			mucked.push(seat);
		}
	}
	return [shown, mucked];
}
