// The TypeScript side of the bots' differential tests (P4B.6): replays the
// lines `python -m rivermind.bots.differential` writes and reports the first
// difference. scripts/bots-parity.ts drives it.

import { dumps, handRecord, historyFromDict, type Json } from '../engine/history.ts';
import { apply, isOver, startHand, type HandState } from '../engine/state.ts';
import { seatView } from '../engine/view.ts';
import { BlueprintPolicy, type Stats } from './blueprint.ts';
import { STREETS, type CardTables } from './bundle.ts';
import { PythonRandom } from './mt.ts';
import {
	CallingStationPolicy,
	HeuristicPolicy,
	MinBetPolicy,
	RandomPolicy,
	type BotRandom,
	type Policy
} from './policies.ts';
import { createHash } from 'node:crypto';

const MAX_ACTIONS = 4_000;

export function simpleBots(): Record<string, Policy> {
	return {
		random: new RandomPolicy(),
		calling_station: new CallingStationPolicy(),
		heuristic: new HeuristicPolicy(),
		min_bettor: new MinBetPolicy()
	};
}

/** Play a hand to the end, each seat's bot drawing from the one `rng`. */
export function play(
	state: HandState,
	seats: readonly string[],
	bots: Record<string, Policy>,
	rng: BotRandom,
	onAct?: (policy: Policy) => void
): HandState {
	let steps = 0;
	while (!isOver(state)) {
		const seat = state.toAct as number;
		const policy = bots[seats[seat]];
		if (!policy) throw new Error(`no bot named ${seats[seat]}`);
		const action = policy.act(seatView(state, seat), rng);
		onAct?.(policy);
		state = apply(state, action);
		if (++steps > MAX_ACTIONS) throw new Error('the hand did not end');
	}
	return state;
}

interface LineMeta {
	readonly bots: string[];
	readonly seed: string;
	readonly probabilities?: (number[] | null)[];
	readonly stats?: Stats;
}

export interface LineResult {
	/** The record the TypeScript bots produced. */
	readonly record: string;
	readonly probabilities: (number[] | null)[];
	readonly stats: Stats;
}

/** Play the deal of one reference line with the TypeScript bots. */
export function replayLine(
	meta: LineMeta,
	record: Json,
	bots: Record<string, Policy>,
	blueprint?: BlueprintPolicy
): LineResult {
	const history = historyFromDict(record);
	const probabilities: (number[] | null)[] = [];
	blueprint?.newHand();
	const final = play(
		startHand(history.config, history.startingStacks, history.button, { deck: history.deck }),
		meta.bots,
		bots,
		new PythonRandom(BigInt(meta.seed)),
		(policy) => {
			if (policy === blueprint) probabilities.push(blueprint.lastProbabilities);
		}
	);
	const stats = blueprint
		? Object.fromEntries(Object.entries(blueprint.stats).sort(([a], [b]) => (a < b ? -1 : 1)))
		: {};
	return { record: dumps(handRecord(final)), probabilities, stats };
}

/** The largest difference between two lists of probability vectors, or null if their shapes differ. */
export function largestDifference(
	a: readonly (readonly number[] | null)[],
	b: readonly (readonly number[] | null)[]
): number | null {
	if (a.length !== b.length) return null;
	let most = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === null || y === null) {
			if (x !== y) return null;
			continue;
		}
		if (x.length !== y.length) return null;
		for (let j = 0; j < x.length; j++) most = Math.max(most, Math.abs(x[j] - y[j]));
	}
	return most;
}

// Card buckets

/** Boards drawn as `rivermind.bots.differential.boards` draws them (SplitMix32). */
export function* sampleBoards(size: number, count: number, seed: number): Generator<number[]> {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x9e3779b9) >>> 0;
		let z = state;
		z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
		z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
		return (z ^ (z >>> 15)) >>> 0;
	};
	for (let i = 0; i < count; i++) {
		const board: number[] = [];
		while (board.length < size) {
			const c = next() % 52;
			if (!board.includes(c)) board.push(c);
		}
		yield board;
	}
}

/** The bucket digests of `differential.bucket_report`, through `CardTables.bucket`. */
export function bucketReport(tables: CardTables, count: number, seed: number) {
	const pairs: [number, number][] = [];
	for (let b = 1; b < 52; b++) for (let a = 0; a < b; a++) pairs.push([a, b]);
	const report: Record<string, { boards: number; sha256: string }> = {};
	const pre = new Uint16Array(1326);
	pairs.forEach(([a, b], i) => (pre[i] = tables.bucket([a, b])));
	report.preflop = { boards: 1, sha256: createHash('sha256').update(pre).digest('hex') };
	STREETS.forEach((street, k) => {
		const size = 3 + k;
		const hash = createHash('sha256');
		const values = new Uint16Array(1326);
		for (const board of sampleBoards(size, count, seed + size)) {
			pairs.forEach(([a, b], i) => {
				values[i] = board.includes(a) || board.includes(b) ? 0xffff : tables.bucket([a, b], board);
			});
			hash.update(values);
		}
		report[street] = { boards: count, sha256: hash.digest('hex') };
	});
	return report;
}
