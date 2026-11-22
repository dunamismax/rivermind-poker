// The betting trees compiled from the TypeScript engine: a port of
// compile_tree in rivermind/bots/blueprint/tree.py (P4B.6; multiway graphs at
// P5.7). A serving bundle carries its trees, so serving does not need this;
// the tests compile the trees here and check them against the Python trees'
// SHA-256s, which proves the abstraction port, and build small bundles for
// the policies' tests.

import {
	apply,
	handConfig,
	legalActions,
	potTotal,
	startHand,
	type HandState
} from '../engine/state.ts';
import { abstractActions, NAME, streetLevel, type Abstraction } from './abstraction.ts';
import {
	graphFromDocument,
	graphSha256,
	treeSha256,
	type GraphDocument,
	type Tree
} from './bundle.ts';

export const SMALL_BLIND = 50;
export const BIG_BLIND = 100;
export const DEPTHS = [50, 100] as const;
const FOLD = 0;
const SHOWDOWN = 1;

export function startState(depth: number, seats = 2): HandState {
	const stack = depth * BIG_BLIND;
	return startHand(handConfig(SMALL_BLIND, BIG_BLIND), new Array<number>(seats).fill(stack), 0, {
		deck: Array.from({ length: 52 }, (_, c) => c)
	});
}

/**
 * Build a multiway abstraction's graph for stacks of `depth` big blinds, as a
 * format 2 trees.json stores it: `_compile_multiway` in tree.py. Betting
 * states with the same seats, chips, bets and rights to raise are one node
 * when the abstraction is merged.
 */
export function compileGraph(depth: number, abstraction: Abstraction): GraphDocument {
	const player: number[] = [];
	const street: number[] = [];
	const offset: number[] = [];
	const contribution: number[] = [];
	const live: number[] = [];
	const tokens: number[] = [];
	const kids: number[][] = [];
	const measure: number[] = [];
	const spr: number[] = [];
	const starts: number[][] = [[], [], [], []];
	const terminalKind: number[] = [];
	const terminalValue: number[] = [];
	const terminalPot: number[] = [];
	const terminalLive: number[] = [];
	const width: [number, number, number, number] = [0, 0, 0, 0];
	const tokenSets: string[][] = [];
	const tokenSetIndex = new Map<string, number>();
	const measureSets: (number | null)[][] = [];
	const measureSetIndex = new Map<string, number>();
	const nodes = new Map<string, number>();
	const terminals = new Map<string, number>();

	const liveSeats = (state: HandState) => {
		const out: number[] = [];
		state.folded.forEach((folded, i) => {
			if (!folded) out.push(i);
		});
		return out;
	};
	const mask = (seats: readonly number[]) => seats.reduce((m, i) => m | (1 << i), 0);

	const terminal = (state: HandState): number => {
		const result = state.result!;
		const seats = liveSeats(state);
		const each = state.contributions[seats[0]];
		const pot = potTotal(state);
		if (result.showdown && seats.some((i) => state.contributions[i] !== each)) {
			throw new Error('equal stacks leave one pot at a showdown');
		}
		const key = `${result.showdown}|${seats}|${each}|${pot}`;
		let t = terminals.get(key);
		if (t === undefined) {
			t = terminalKind.length;
			terminals.set(key, t);
			terminalKind.push(result.showdown ? SHOWDOWN : FOLD);
			terminalValue.push(each);
			terminalPot.push(pot);
			terminalLive.push(mask(seats));
		}
		return ~t;
	};

	const visit = (state: HandState, opens: boolean): number => {
		if (state.result !== null) return terminal(state);
		const s = state.street;
		const level = streetLevel(state.actions, s);
		const seat = state.toAct!;
		const pot = potTotal(state);
		const other = Math.max(...state.streetBets.filter((_, i) => i !== seat));
		let key: string | null = null;
		if (abstraction.merged) {
			const seats = liveSeats(state);
			key = [
				s,
				seat,
				seats,
				seats.map((i) => state.contributions[i]),
				pot,
				seats.map((i) => state.streetBets[i]),
				seats.map((i) => state.actedAt[i] ?? 'n'),
				state.currentBet,
				state.minRaise,
				other,
				level
			].join('|');
			const found = nodes.get(key);
			if (found !== undefined) return found;
		}
		const legal = legalActions(state);
		const actions = abstractActions(
			legal,
			s,
			level,
			pot,
			state.currentBet,
			state.streetBets,
			abstraction
		);
		const v = player.length;
		if (key !== null) nodes.set(key, v);
		player.push(seat);
		street.push(s);
		offset.push(width[s]);
		width[s] += actions.length;
		const names = actions.map((a) => a.token);
		let set = tokenSetIndex.get(names.join(','));
		if (set === undefined) {
			set = tokenSets.length;
			tokenSetIndex.set(names.join(','), set);
			tokenSets.push(names);
		}
		tokens.push(set);
		kids.push([]);
		contribution.push(state.contributions[seat]);
		live.push(mask(liveSeats(state)));
		const owed = state.currentBet - state.streetBets[seat];
		const sizes = actions.map((a) =>
			a.action.amount === null ? null : (a.action.amount - state.currentBet) / (pot + owed)
		);
		const sizesKey = JSON.stringify(sizes);
		let sizeSet = measureSetIndex.get(sizesKey);
		if (sizeSet === undefined) {
			sizeSet = measureSets.length;
			measureSetIndex.set(sizesKey, sizeSet);
			measureSets.push(sizes);
		}
		measure.push(sizeSet);
		spr.push(state.stacks[seat] / pot);
		if (opens) starts[s].push(v);
		kids[v] = actions.map((a) => {
			const child = apply(state, a.action);
			return visit(child, child.street !== s);
		});
		return v;
	};

	visit(startState(depth, abstraction.seats), true);
	const doc = {
		abstraction: abstraction.name,
		depth,
		small_blind: SMALL_BLIND,
		big_blind: BIG_BLIND,
		sha256: '',
		width,
		seats: abstraction.seats,
		merged: abstraction.merged,
		player,
		street,
		offset,
		contribution,
		live,
		token_sets: tokenSets,
		tokens,
		children: kids.flat(),
		measure_sets: measureSets,
		measure,
		spr,
		starts,
		terminal_kind: terminalKind,
		terminal_value: terminalValue,
		terminal_pot: terminalPot,
		terminal_live: terminalLive
	};
	doc.sha256 = graphSha256(graphFromDocument(doc));
	return doc;
}

/** Build the hu-m1 tree for stacks of `depth` big blinds, as trees.json stores it. */
export function compileTree(depth: number): Tree {
	const player: number[] = [];
	const street: number[] = [];
	const offset: number[] = [];
	const history: string[] = [];
	const tokens: string[][] = [];
	const children: number[][] = [];
	const terminalKind: number[] = [];
	const terminalValue: number[] = [];
	const measure: (number | null)[][] = [];
	const spr: number[] = [];
	const width: [number, number, number, number] = [0, 0, 0, 0];

	const terminal = (state: HandState): number => {
		const result = state.result!;
		const [c0, c1] = state.contributions;
		if (result.showdown) {
			terminalKind.push(SHOWDOWN);
			terminalValue.push(c0);
		} else {
			terminalKind.push(FOLD);
			terminalValue.push(state.folded[1] ? c1 : -c0);
		}
		return ~(terminalKind.length - 1);
	};

	const visit = (state: HandState, past: string): number => {
		if (state.result !== null) return terminal(state);
		const legal = legalActions(state);
		const s = state.street;
		const pot = potTotal(state);
		const actions = abstractActions(
			legal,
			s,
			streetLevel(state.actions, s),
			pot,
			state.currentBet,
			state.streetBets
		);
		const v = player.length;
		player.push(legal.seat);
		street.push(s);
		offset.push(width[s]);
		width[s] += actions.length;
		history.push(past);
		tokens.push(actions.map((a) => a.token));
		children.push([]);
		const owed = state.currentBet - state.streetBets[legal.seat];
		measure.push(
			actions.map((a) =>
				a.action.amount === null ? null : (a.action.amount - state.currentBet) / (pot + owed)
			)
		);
		spr.push(Math.min(...state.stacks) / pot);
		children[v] = actions.map((a) => {
			const child = apply(state, a.action);
			let step = a.token;
			if (child.result === null && child.street !== s) step += '/'.repeat(child.street - s);
			return visit(child, past + step);
		});
		return v;
	};

	visit(startState(depth), '');
	const tree = {
		abstraction: NAME,
		depth,
		small_blind: SMALL_BLIND,
		big_blind: BIG_BLIND,
		sha256: '',
		width,
		history,
		player,
		street,
		offset,
		tokens,
		children,
		terminal_kind: terminalKind,
		terminal_value: terminalValue,
		measure,
		spr
	};
	tree.sha256 = treeSha256(tree);
	return tree;
}
