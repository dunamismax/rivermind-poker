// Helpers for engine tests, ported from test/engine/helpers.py: arranged deals
// and compact action scripts.
//
// A script is a space-separated list of `S<seat>:<action>` tokens, such as
// "S5:r300 S0:c S1:f". Actions are f (fold), k (check), c (call), b<total>
// (bet), r<total> (raise) and a (all-in: the largest bet or raise, or a call
// when no raise is allowed). Each token also asserts that its seat is the one
// to act.

import { FULL_DECK, buildDeck, cards } from '../../engine/cards.ts';
import { dealOrder, seatsDealtIn } from './seating.ts';
import {
	Action,
	apply,
	handConfig,
	isOver,
	legalActions,
	startHand,
	type ActionKind,
	type HandConfig,
	type HandState
} from './state.ts';
import rules from './rules.json' with { type: 'json' };

export const BLINDS = handConfig(50, 100);

/** Start a hand whose hole cards and board are given as text. */
export function deal(
	stacks: readonly (number | null)[],
	button: number,
	holes: Readonly<Record<number, string>> = {},
	board = '',
	config: HandConfig = BLINDS
): HandState {
	const order = dealOrder(button, seatsDealtIn(stacks), stacks.length);
	const given = new Map(Object.entries(holes).map(([seat, text]) => [Number(seat), cards(text)]));
	const boardCards = board ? cards(board) : [];
	const used = new Set([...[...given.values()].flat(), ...boardCards]);
	const spare = FULL_DECK.filter((c) => !used.has(c));
	let next = 0;
	const holeList = order.map((seat) => given.get(seat) ?? [spare[next++], spare[next++]]);
	return startHand(config, stacks, button, { deck: buildDeck(holeList, boardCards) });
}

export function parseAction(state: HandState, token: string): Action {
	const legal = legalActions(state);
	const code = token[0];
	const amount = token.slice(1);
	if (code === 'f') return Action.fold();
	if (code === 'k') return Action.check();
	if (code === 'c') return Action.call();
	if (code === 'b') return Action.bet(Number(amount));
	if (code === 'r') return Action.raiseTo(Number(amount));
	if (code === 'a') {
		return legal.raiseKind !== null ? Action.of(legal.raiseKind, legal.maxTo) : Action.call();
	}
	throw new Error(`unknown action code in ${JSON.stringify(token)}`);
}

/** Apply a script, checking the seat to act before each action. */
export function play(state: HandState, script: string): HandState {
	for (const token of script.split(/\s+/).filter(Boolean)) {
		const [seatText, actionText] = token.split(':');
		const seat = Number(seatText.replace(/^S/, ''));
		if (state.toAct !== seat) {
			throw new Error(`expected S${seat} to act at ${token}, but it is ${state.toAct}`);
		}
		state = apply(state, parseAction(state, actionText));
	}
	return state;
}

/** Check (or call) until the hand ends. */
export function checkDown(state: HandState): HandState {
	while (!isOver(state)) {
		state = apply(state, legalActions(state).canCheck ? Action.check() : Action.call());
	}
	return state;
}

/** Seats to act on the current street if everyone checks or calls. */
export function actingOrder(state: HandState, kind: ActionKind = 'call'): (number | null)[] {
	const seats: (number | null)[] = [];
	const street = state.street;
	while (!isOver(state) && state.street === street) {
		seats.push(state.toAct);
		state = apply(state, legalActions(state).canCheck ? Action.check() : Action.of(kind));
	}
	return seats;
}

/** A hand-worked rule hand from test/engine/fixtures.py, via rules.json. */
export interface RuleHand {
	name: string;
	rule: string;
	config: { small_blind: number; big_blind: number; ante: number };
	stacks: (number | null)[];
	button: number;
	holes: Record<string, string>;
	board: string;
	script: string;
	final: (number | null)[];
	pots: [number, number[]][] | null;
	uncalled: [number, number] | null;
	shown: number[] | null;
	mucked: number[] | null;
	tabled: boolean | null;
	reference: { record: string; state: string; text: string };
}

export const RULE_HANDS = rules.fixtures as RuleHand[];

/** Every state of a rule hand, from the deal to the end of its script. */
export function ruleHandStates(fixture: RuleHand): HandState[] {
	const config = handConfig(
		fixture.config.small_blind,
		fixture.config.big_blind,
		fixture.config.ante
	);
	const holes = Object.fromEntries(Object.entries(fixture.holes).map(([s, t]) => [Number(s), t]));
	let state = deal(fixture.stacks, fixture.button, holes, fixture.board, config);
	const found = [state];
	for (const token of fixture.script.split(/\s+/).filter(Boolean)) {
		state = apply(state, parseAction(state, token.split(':')[1]));
		found.push(state);
	}
	return found;
}

export function ruleHand(name: string): RuleHand {
	const found = RULE_HANDS.find((f) => f.name === name);
	if (!found) throw new Error(`no rule hand named ${JSON.stringify(name)}`);
	return found;
}
