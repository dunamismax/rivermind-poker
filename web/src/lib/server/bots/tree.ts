// The hu-m1 betting trees compiled from the TypeScript engine: a port of
// compile_tree in rivermind/bots/blueprint/tree.py (P4B.6). A serving bundle
// carries its trees, so serving does not need this; the tests compile the
// trees here and check them against the Python trees' SHA-256s, which proves
// the abstraction port, and build small bundles for the policy's tests.

import {
	apply,
	handConfig,
	legalActions,
	potTotal,
	startHand,
	type HandState
} from '../engine/state.ts';
import { abstractActions, NAME, streetLevel } from './abstraction.ts';
import { treeSha256, type Tree } from './bundle.ts';

export const SMALL_BLIND = 50;
export const BIG_BLIND = 100;
export const DEPTHS = [50, 100] as const;
const FOLD = 0;
const SHOWDOWN = 1;

export function startState(depth: number): HandState {
	const stack = depth * BIG_BLIND;
	return startHand(handConfig(SMALL_BLIND, BIG_BLIND), [stack, stack], 0, {
		deck: Array.from({ length: 52 }, (_, c) => c)
	});
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
