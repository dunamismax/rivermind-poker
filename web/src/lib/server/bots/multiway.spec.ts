// The multiway blueprint in TypeScript (P5.7). scripts/bots-parity.ts checks
// it against the Python reference on many hands; these tests pin the pieces
// without Python: the six-seat graph against the Python graph's SHA-256, the
// format 2 bundle checks, and the policy's seats, sizes and place in the
// graph (ported from test/engine/test_blueprint_multiway.py).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Action, apply, handConfig, isOver, startHand, type HandState } from '../engine/state.ts';
import { seatView } from '../engine/view.ts';
import { ABSTRACTIONS, SIX_MAX_S1 } from './abstraction.ts';
import { BlueprintPolicy } from './blueprint.ts';
import {
	BundleError,
	graphFromDocument,
	graphSha256,
	loadBundle,
	type Bundle,
	type GraphDocument
} from './bundle.ts';
import { MultiwayBlueprintPolicy } from './multiway.ts';
import { PythonRandom } from './mt.ts';
import {
	CallingStationPolicy,
	HeuristicPolicy,
	RandomPolicy,
	type BotRandom,
	type Policy
} from './policies.ts';
import { strategySize, writeBundle } from './testing.ts';
import { compileGraph } from './tree.ts';

const DECK = Array.from({ length: 52 }, (_, c) => c);
// The Python graph's SHA-256 (docs/bots.md, and test_blueprint_multiway.py).
const SIX_50 = 'cc952203fb974367c81d7a97ce840458e279c1edb10ac75318b8a015c7383f59';

let doc: GraphDocument;
let dir: string;
let bundle: Bundle;
/** Slots of the 50 big blind graph with one bucket a street, set to 1 so every info set is trained and uniform. */
let strategy: Uint8Array;

/** The first slot of the node a history of tokens leads to. */
function slotOf(tokens: readonly string[]): { slot: number; actions: readonly string[] } {
	const graph = bundle.graphs[0];
	let v = 0;
	for (const token of tokens) {
		const i = graph.tokenSets[graph.tokens[v]].indexOf(token);
		if (i < 0) throw new Error(`no ${token} at node ${v}`);
		v = graph.children[graph.first[v] + i];
	}
	return {
		slot: bundle.base[0][graph.street[v]] + graph.offset[v],
		actions: graph.tokenSets[graph.tokens[v]]
	};
}

/** Make the blueprint always play `token` at a history; undone by `restore`. */
function always(tokens: readonly string[], token: string): void {
	const { slot, actions } = slotOf(tokens);
	actions.forEach((t, i) => (bundle.strategy[slot + i] = t === token ? 1 : 0));
}

function restore(): void {
	bundle.strategy.fill(1);
}

function table(
	stacks: readonly (number | null)[],
	button: number,
	deck: readonly number[] = DECK,
	blinds: [number, number] = [50, 100]
): HandState {
	return startHand(handConfig(...blinds), stacks, button, { deck });
}

function shuffled(seed: number): number[] {
	const rng = new PythonRandom(seed);
	const deck = [...DECK];
	for (let i = deck.length - 1; i > 0; i--) {
		const j = rng.below(i + 1);
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	return deck;
}

/** Play a hand to the end; the engine throws on an illegal action. */
function play(state: HandState, policies: Map<number, Policy>, rng: BotRandom): void {
	for (const policy of policies.values()) (policy as { newHand?: () => void }).newHand?.();
	let steps = 0;
	while (!isOver(state)) {
		const seat = state.toAct as number;
		state = apply(state, policies.get(seat)!.act(seatView(state, seat), rng));
		if (++steps > 500) throw new Error('the hand did not end');
	}
}

beforeAll(() => {
	doc = compileGraph(50, SIX_MAX_S1);
	dir = mkdtempSync(join(tmpdir(), 'rivermind-multiway-'));
	strategy = new Uint8Array(strategySize([doc])).fill(1);
	writeBundle(join(dir, 'six'), [doc], { strategy });
	bundle = loadBundle(join(dir, 'six'));
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the 6max-s1 graph', () => {
	it('compiles to the Python graph', () => {
		expect(doc.player.length).toBe(345_581);
		expect(doc.width).toEqual([79_677, 152_895, 254_203, 272_733]);
		expect(doc.terminal_kind.length).toBe(15_179);
		expect(doc.starts.map((s) => s.length)).toEqual([1, 1_936, 5_163, 6_172]);
		expect(doc.sha256).toBe(SIX_50);
		// Seat 3 opens: fold, call, raise to 2.5 big blinds or all-in.
		expect(doc.player[0]).toBe(3);
		expect(doc.token_sets[doc.tokens[0]]).toEqual(['f', 'c', 'r0', 'a']);
		expect(doc.live[0]).toBe(0b111111);
		expect(Object.keys(ABSTRACTIONS)).toEqual(['hu-m1', '6max-s1']);
	});

	it('is rebuilt from its columns, and refused when they disagree', () => {
		const graph = graphFromDocument(doc);
		expect(graphSha256(graph)).toBe(SIX_50);
		expect(graph.first[graph.first.length - 1]).toBe(doc.children.length);
		expect(() => graphFromDocument({ ...doc, children: doc.children.slice(1) })).toThrow(
			BundleError
		);
		expect(() => graphFromDocument({ ...doc, spr: doc.spr.slice(1) })).toThrow(BundleError);
		expect(() =>
			graphFromDocument({ ...doc, children: [doc.player.length, ...doc.children.slice(1)] })
		).toThrow(/not in the graph/);
	});
});

describe('a format 2 bundle', () => {
	it('loads as a multiway bundle', () => {
		expect(bundle.manifest.format).toBe(2);
		expect(bundle.seats).toBe(6);
		expect(bundle.trees).toEqual([]);
		expect(bundle.graphs.map((g) => [g.depth, g.sha256])).toEqual([[50, SIX_50]]);
		expect(bundle.strategy.length).toBe(759_508);
		expect(() =>
			new BlueprintPolicy(bundle).act(seatView(table([5_000, 5_000], 0), 0), new PythonRandom(1))
		).toThrow();
	});

	it('is refused when a graph differs from the manifest', () => {
		const other = join(dir, 'changed');
		const changed = { ...doc, contribution: [1, ...doc.contribution.slice(1)] };
		writeBundle(other, [changed], { strategy });
		expect(() => loadBundle(other)).toThrow(/trees do not match/);
		// A heads-up reader's format with a graph inside is refused too.
		const manifestPath = join(dir, 'six', 'manifest.json');
		const original = readFileSync(manifestPath, 'utf8');
		writeFileSync(manifestPath, original.replace('"format": 2', '"format": 1'));
		try {
			expect(() => loadBundle(join(dir, 'six'))).toThrow(/do not suit its format/);
		} finally {
			writeFileSync(manifestPath, original);
		}
	});
});

describe('the multiway policy', () => {
	it('needs a format 2 bundle and three to six players', () => {
		const bot = new MultiwayBlueprintPolicy(bundle);
		expect(bot.seats).toBe(6);
		const two = table([5_000, null, null, 5_000, null, null], 0);
		expect(() => bot.act(seatView(two, two.toAct as number), new PythonRandom(1))).toThrow(
			/three to 6/
		);
	});

	it('seats real players by position', () => {
		const bot = new MultiwayBlueprintPolicy(bundle);
		const seats = (stacks: (number | null)[], button: number) =>
			Object.fromEntries(bot.treeSeats(seatView(table(stacks, button), button)));
		const full = new Array<number>(6).fill(5_000);
		expect(seats(full, 0)).toEqual({ 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 });
		expect(seats(full, 4)).toEqual({ 4: 0, 5: 1, 0: 2, 1: 3, 2: 4, 3: 5 });
		// Four dealt in are the cutoff, the button and the blinds; three are the button and the blinds.
		expect(seats([5_000, null, 5_000, 5_000, null, 5_000], 2)).toEqual({ 2: 0, 3: 1, 5: 2, 0: 5 });
		expect(seats([null, 5_000, null, 5_000, 5_000, null], 3)).toEqual({ 3: 0, 4: 1, 1: 2 });
		expect(seats([5_000, 5_000, null, 5_000, 5_000, 5_000], 0)).toEqual({
			0: 0,
			1: 1,
			3: 2,
			4: 4,
			5: 5
		});
	});

	it('sizes its own bets from the real pot', () => {
		always([], 'r0');
		always(['r0'], 'r0');
		always(['f', 'f', 'f'], 'r0');
		try {
			const bot = new MultiwayBlueprintPolicy(bundle);
			const rng = new PythonRandom(0);
			let state = table(new Array<number>(6).fill(5_000), 0);
			expect(bot.act(seatView(state, 3), rng)).toEqual(Action.raiseTo(250));
			state = apply(state, Action.raiseTo(250));
			expect(bot.act(seatView(state, 4), rng)).toEqual(Action.raiseTo(750));
			// Other stakes, and three dealt in: the button opens where three graph seats have folded.
			const three = table([null, 1_000, null, 1_000, null, 1_000], 3, DECK, [10, 20]);
			expect(three.toAct).toBe(3);
			expect(bot.act(seatView(three, 3), rng)).toEqual(Action.raiseTo(50));
			expect(bot.stats.lost ?? 0).toBe(0);
			expect(bot.stats.trained).toBe(3);
		} finally {
			restore();
		}
	});

	it.each([6, 5, 4, 3])(
		'stays on the graph when %i blueprints play each other with equal stacks',
		(dealt) => {
			const bots = Array.from({ length: dealt }, () => new MultiwayBlueprintPolicy(bundle));
			const rng = new PythonRandom(dealt);
			for (let hand = 0; hand < 60; hand++) {
				const stacks: (number | null)[] = new Array<number | null>(6).fill(null);
				const free = [0, 1, 2, 3, 4, 5];
				const seats: number[] = [];
				for (let i = 0; i < dealt; i++) seats.push(free.splice(rng.below(free.length), 1)[0]);
				seats.sort((a, b) => a - b);
				for (const s of seats) stacks[s] = 5_000;
				const policies = new Map<number, Policy>(seats.map((s, i) => [s, bots[i]]));
				play(table(stacks, seats[hand % dealt], shuffled(1_000 * dealt + hand)), policies, rng);
			}
			for (const bot of bots) {
				expect(bot.stats.decisions).toBeGreaterThan(60);
				expect(bot.stats.trained).toBe(bot.stats.decisions);
				for (const key of [
					'lost',
					'reentries',
					'off_tree',
					'below_smallest',
					'resized',
					'passed',
					'capped'
				]) {
					expect(bot.stats[key] ?? 0).toBe(0);
				}
			}
		}
	);

	it('keeps its place among other players and stacks', () => {
		const bot = new MultiwayBlueprintPolicy(bundle);
		const others = [
			new RandomPolicy(),
			new CallingStationPolicy(),
			new HeuristicPolicy(),
			new RandomPolicy(),
			new HeuristicPolicy()
		];
		const rng = new PythonRandom(5);
		const sizes = [700, 2_000, 4_000, 5_000, 10_000, 15_000];
		for (let hand = 0; hand < 300; hand++) {
			const dealt = 3 + (hand % 4);
			const stacks: (number | null)[] = new Array<number | null>(6).fill(null);
			const free = [0, 1, 2, 3, 4, 5];
			const seats: number[] = [];
			for (let i = 0; i < dealt; i++) seats.push(free.splice(rng.below(free.length), 1)[0]);
			for (const s of seats) stacks[s] = sizes[rng.below(sizes.length)];
			const policies = new Map<number, Policy>(seats.map((s, i) => [s, i ? others[i - 1] : bot]));
			play(table(stacks, seats[hand % dealt], shuffled(9_000 + hand)), policies, rng);
		}
		const stats = bot.stats;
		expect(stats.decisions).toBeGreaterThan(400);
		expect(stats.off_tree).toBeGreaterThan(50);
		expect(stats.reentries).toBeGreaterThan(20);
		expect(stats.passed).toBeGreaterThan(0);
		expect(stats.trained + (stats.lost ?? 0)).toBe(stats.decisions);
		expect(stats.capped).toBeGreaterThan(0);
		expect((stats.lost ?? 0) / stats.decisions).toBeLessThan(0.03);
	});
});
