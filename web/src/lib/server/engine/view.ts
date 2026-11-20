// SeatView v2, what one seat may know about a hand: a port of
// rivermind/engine/view.py.
//
// Bots and clients decide from a SeatView, never from a HandState. A view
// holds the seat's own hole cards and public information only: the board,
// stacks, bets, pot, positions, the action history and, once a hand is over,
// the hands shown at showdown. It never holds the deck or another seat's
// unrevealed cards.

import {
	finalStacks,
	isOver,
	legalActions,
	numSeats,
	potTotal,
	seatOrder,
	type ActionRecord,
	type HandConfig,
	type HandState,
	type HoleCards,
	type LegalActions,
	type Post,
	type Street
} from './state.ts';

export interface SeatView {
	readonly seat: number;
	readonly config: HandConfig;
	readonly holeCards: HoleCards | null;
	readonly board: readonly number[];
	readonly street: Street;
	readonly button: number;
	readonly smallBlindSeat: number;
	readonly bigBlindSeat: number;
	/** Players dealt in, clockwise from the player left of the button. */
	readonly seatOrder: readonly number[];
	/** Chips behind per seat, null for seats not dealt in. */
	readonly stacks: readonly (number | null)[];
	readonly streetBets: readonly number[];
	readonly contributions: readonly number[];
	readonly folded: readonly boolean[];
	readonly pot: number;
	readonly currentBet: number;
	readonly toAct: number | null;
	/** The seat's legal actions when it is to act, otherwise null. */
	readonly legal: LegalActions | null;
	readonly posts: readonly Post[];
	readonly actions: readonly ActionRecord[];
	/** Seats and hole cards shown at showdown, once the hand is over. */
	readonly revealed: readonly (readonly [number, HoleCards])[];
	readonly isOver: boolean;
}

/** The view of `state` for `seat`. */
export function seatView(state: HandState, seat: number): SeatView {
	if (!(Number.isInteger(seat) && seat >= 0 && seat < numSeats(state))) {
		throw new RangeError('not a seat at this table');
	}
	const revealed: [number, HoleCards][] = [];
	for (const s of state.result?.shown ?? []) {
		const hole = state.holeCards[s];
		if (hole !== null) revealed.push([s, hole]);
	}
	return {
		seat,
		config: state.config,
		holeCards: state.holeCards[seat],
		board: state.board,
		street: state.street,
		button: state.button,
		smallBlindSeat: state.smallBlindSeat,
		bigBlindSeat: state.bigBlindSeat,
		seatOrder: seatOrder(state),
		stacks: finalStacks(state),
		streetBets: state.streetBets,
		contributions: state.contributions,
		folded: state.folded,
		pot: potTotal(state),
		currentBet: state.currentBet,
		toAct: state.toAct,
		legal: state.toAct === seat ? legalActions(state) : null,
		posts: state.posts,
		actions: state.actions,
		revealed,
		isOver: isOver(state)
	};
}

/** Chips this seat would add to call, 0 when it can check. */
export function toCall(view: SeatView): number {
	return view.legal?.call ?? 0;
}

export function stackOf(view: SeatView): number {
	return view.stacks[view.seat] ?? 0;
}

/** Other seats still in the hand. */
export function opponents(view: SeatView): number[] {
	return view.seatOrder.filter((s) => s !== view.seat && !view.folded[s]);
}

export function streetActions(view: SeatView): ActionRecord[] {
	return view.actions.filter((a) => a.street === view.street);
}
