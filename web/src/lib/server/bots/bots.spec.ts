// The TypeScript bots (P4B.6). scripts/bots-parity.ts checks them against the
// Python reference on many hands; these tests pin the pieces without Python:
// the generator against CPython's outputs, the trees against the Python
// trees' SHA-256s, the simple bots, the bundle checks and the blueprint's
// action mapping (ported from test/engine/test_match.py).

import { mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cards } from '../../engine/cards.ts';
import { Action, apply, FLOP, handConfig, startHand, type HandState } from '../engine/state.ts';
import { seatView } from '../engine/view.ts';
import { abstractActions } from './abstraction.ts';
import { BlueprintPolicy, pseudoHarmonic } from './blueprint.ts';
import { BundleError, CardTables, loadBundle, pairIndex, setRank, type Bundle } from './bundle.ts';
import { PythonRandom } from './mt.ts';
import {
	CallingStationPolicy,
	chenScore,
	handStrength,
	HeuristicPolicy,
	MinBetPolicy,
	RandomPolicy
} from './policies.ts';
import { writeBundle, type TestBundle } from './testing.ts';
import { compileTree } from './tree.ts';

const DECK = Array.from({ length: 52 }, (_, c) => c);

function hand(stack = 10_000, blinds: [number, number] = [50, 100], button = 0): HandState {
	return startHand(handConfig(...blinds), [stack, stack], button, { deck: DECK });
}

describe("Python's random.Random", () => {
	it('matches CPython for a seed', () => {
		const r = new PythonRandom(5);
		expect([r.random(), r.random()]).toEqual([0.6229016948897019, 0.7417869892607294]);
		expect([r.randint(1, 10 ** 12), r.randint(1, 10 ** 12)]).toEqual([759329574456, 927465761771]);
		expect(r.getrandbits(53)).toBe(5872980113096233);
	});

	it('seeds with 64-bit values and repeats', () => {
		const a = new PythonRandom(2n ** 64n - 1n);
		const b = new PythonRandom(2n ** 64n - 1n);
		const draws = Array.from({ length: 500 }, () => a.below(7));
		expect(draws).toEqual(Array.from({ length: 500 }, () => b.below(7)));
		expect(new Set(draws)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
		expect(() => a.below(0)).toThrow(RangeError);
		expect(() => new PythonRandom(0.5)).toThrow(RangeError);
	});
});

describe('the hu-m1 trees', () => {
	// The Python trees' SHA-256s, from every hu-m1 checkpoint's manifest.
	it.each([
		[
			50,
			5472,
			[117, 812, 3216, 9704],
			'378a4e1da9cb5cba898f76c8e4f2dcf90f589b855a87f914d50d68b590613881'
		],
		[
			100,
			11708,
			[129, 1332, 6256, 22576],
			'220a7cab487c973ba65fa3deee6e562804cba0a3474df52c086d483a61f2287b'
		]
	])('%i big blinds compiles to the Python tree', (depth, nodes, width, sha256) => {
		const tree = compileTree(depth);
		expect(tree.player.length).toBe(nodes);
		expect(tree.width).toEqual(width);
		expect(tree.sha256).toBe(sha256);
	});

	it('sizes come from the real pot, halves rounding up', () => {
		const state = apply(hand(), Action.raiseTo(250));
		const legal = { ...seatView(state, 1).legal! };
		const tokens = abstractActions(legal, 0, 1, 350, 250, state.streetBets).map((a) => [
			a.token,
			a.action.amount
		]);
		expect(tokens).toEqual([
			['f', null],
			['c', null],
			['r0', 750],
			['r1', 1125],
			['a', 10_000]
		]);
	});
});

describe('the simple bots', () => {
	it('score hands as Chen does', () => {
		const scores = ['AsAh', '7c2d', 'KsQs', 'Td9d', '5h4h', 'Ac2c', 'JcTd', '2s2h'].map((h) =>
			chenScore(cards(h) as [number, number])
		);
		expect(scores).toEqual([20, -1, 10, 8, 6, 7, 7, 5]);
		expect(handStrength(cards('AsKs') as [number, number], cards('Qs7s2d'))).toBe(
			0.5962072155411656
		);
		expect(handStrength(cards('7c2d') as [number, number], cards('AsKsQh9d'))).toBe(
			0.16666666666666666
		);
	});

	it('the random bot never folds when it can check, and stays legal', () => {
		const bot = new RandomPolicy();
		const rng = new PythonRandom(3);
		const state = apply(hand(), Action.call());
		for (let i = 0; i < 200; i++) {
			const action = bot.act(seatView(state, 1), rng);
			expect(action.kind).not.toBe('fold');
			apply(state, action);
		}
	});

	it('the calling station checks or calls, and the probe min-bets', () => {
		expect(new CallingStationPolicy().act(seatView(hand(), 0))).toEqual(Action.call());
		const probe = new MinBetPolicy();
		let state = hand();
		expect(probe.act(seatView(state, 0))).toEqual(Action.raiseTo(200));
		state = apply(apply(state, Action.call()), Action.check());
		expect(probe.act(seatView(state, 1))).toEqual(Action.bet(100));
		expect(probe.act(seatView(apply(state, Action.bet(300)), 0))).toEqual(Action.call());
	});

	it('RiverMind Easy opens strong hands and folds weak ones', () => {
		const bot = new HeuristicPolicy();
		// Cards go round one at a time, so one seat holds As Ah and the other 2c 7d.
		const top = cards('As2cAh7d');
		const state = startHand(handConfig(50, 100), [10_000, 10_000], 0, {
			deck: [...top, ...DECK.filter((c) => !top.includes(c))]
		});
		const strong = state.holeCards.findIndex((h) => h![0] >> 2 === 12);
		expect(state.holeCards[strong]!.map((c) => c >> 2)).toEqual([12, 12]);
		const weak = 1 - strong;
		expect(state.toAct).toBe(0);
		if (strong === 0) {
			expect(bot.act(seatView(state, 0))).toEqual(Action.raiseTo(250));
			expect(bot.act(seatView(apply(state, Action.raiseTo(250)), weak)).kind).toBe('fold');
		} else {
			expect(bot.act(seatView(state, 0)).kind).toBe('fold');
		}
	});
});

describe('serving bundles', () => {
	let dir: string;
	let made: TestBundle;
	let bundle: Bundle;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'rivermind-bots-'));
		made = writeBundle(join(dir, 'good'), [compileTree(50), compileTree(100)]);
		bundle = loadBundle(made.path, { tableSet: made.tableSet });
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('loads and reads every array', () => {
		expect(bundle.trees.map((t) => t.depth)).toEqual([50, 100]);
		expect(bundle.strategy.length).toBe(bundle.manifest.game.size);
		expect(bundle.tables.bucket(cards('AsKd'), cards('Qh7c2s'))).toBe(0);
		expect(() => bundle.tables.bucket(cards('AsKd'), cards('AsKd2s'))).toThrow(BundleError);
		expect(() => bundle.tables.bucket(cards('AsKd'), cards('Qh7c'))).toThrow(BundleError);
	});

	it('refuses another table set, a changed, missing or extra file and a changed tree', () => {
		expect(() => loadBundle(made.path, { tableSet: '0'.repeat(64) })).toThrow(/table set/);
		const cases: [string, (path: string) => void, RegExp][] = [
			['changed', (p) => appendFileSync(join(p, 'flop.u16'), 'x'), /flop\.u16 differs/],
			['missing', (p) => unlinkSync(join(p, 'turn.u16')), /missing/],
			['extra', (p) => writeFileSync(join(p, 'notes.txt'), 'hi'), /notes\.txt/]
		];
		for (const [name, damage, error] of cases) {
			const other = writeBundle(join(dir, name), [compileTree(50), compileTree(100)]);
			damage(other.path);
			expect(() => loadBundle(other.path)).toThrow(error);
		}
		const tree = compileTree(50);
		const wrong = writeBundle(join(dir, 'tree'), [
			{ ...tree, player: tree.player.map((p) => 1 - p) }
		]);
		expect(() => loadBundle(wrong.path)).toThrow(/trees/);
	});

	it('looks up buckets through the suit permutation, as Python does', () => {
		// A one-class flop whose stored row maps each pair to its own index, under permutation 1 (0,1,3,2).
		const row = Uint16Array.from({ length: 1326 }, (_, i) => i);
		const tables = new CardTables(
			new Uint16Array(1326),
			{
				flop: new Int32Array(22_100),
				turn: new Int32Array(270_725),
				river: new Int32Array(2_598_960)
			},
			{
				flop: new Uint8Array(22_100).fill(1),
				turn: new Uint8Array(270_725),
				river: new Uint8Array(2_598_960)
			},
			{ flop: row, turn: row, river: row }
		);
		// Suits 2 and 3 (h and s) swap: As (51) becomes Ah (50), and Kd (45) stays.
		expect(tables.bucket(cards('AsKd'), cards('Qh7c2s'))).toBe(pairIndex(50, 45));
		expect(tables.bucket(cards('AhKd'), cards('Qh7c2s'))).toBe(pairIndex(51, 45));
		expect(setRank([2, 1, 0])).toBe(0);
		expect(pairIndex(1, 0)).toBe(0);
	});

	describe('the blueprint policy', () => {
		const always = (depth: number, history: string, token: string) => {
			const d = bundle.trees.findIndex((t) => t.depth === depth);
			const tree = bundle.trees[d];
			const node = tree.history.indexOf(history);
			const slot = bundle.base[d][tree.street[node]] + tree.offset[node];
			const n = tree.tokens[node].length;
			bundle.strategy.fill(0, slot, slot + n);
			bundle.strategy[slot + tree.tokens[node].indexOf(token)] = 255;
		};

		it('maps by the pseudo-harmonic rule of the design', () => {
			expect(pseudoHarmonic(1 / 3, 3 / 4, 1 / 2)).toBeCloseTo(0.533, 3);
			expect(pseudoHarmonic(0.5, 1, 0.5)).toBe(1);
			expect(pseudoHarmonic(0.5, 1, 1)).toBe(0);
		});

		it('sizes its own raises from the real pot', () => {
			always(100, '', 'r0');
			const bot = new BlueprintPolicy(bundle);
			expect(bot.act(seatView(hand(), 0), new PythonRandom(0))).toEqual(Action.raiseTo(250));
			expect(bot.act(seatView(hand(5_000, [25, 50]), 0), new PythonRandom(0))).toEqual(
				Action.raiseTo(125)
			);
			always(50, '', 'r1');
			expect(bot.act(seatView(hand(6_000), 0), new PythonRandom(0))).toEqual(Action.raiseTo(400));
		});

		it('plays its tree from either seat on the button, and with an empty seat', () => {
			always(100, '', 'r0');
			always(100, 'r0', 'c');
			const bot = new BlueprintPolicy(bundle);
			const swapped = hand(10_000, [50, 100], 1);
			expect(swapped.toAct).toBe(1);
			expect(bot.act(seatView(swapped, 1), new PythonRandom(0))).toEqual(Action.raiseTo(250));
			const three = startHand(handConfig(50, 100), [null, 10_000, 10_000], 2, { deck: DECK });
			expect(bot.act(seatView(three, 2), new PythonRandom(0))).toEqual(Action.raiseTo(250));
			const facing = apply(three, Action.raiseTo(250));
			expect(bot.act(seatView(facing, 1), new PythonRandom(0))).toEqual(Action.call());
			expect(bot.stats.lost).toBeUndefined();
		});

		it('maps off-tree raises at the pseudo-harmonic rate', () => {
			// An open to 300 is x = 1.0, between 2.5× (0.75) and 4× (1.5): 2.5× with p = 0.583.
			always(100, 'r0', 'c');
			always(100, 'r1', 'f');
			const bot = new BlueprintPolicy(bundle);
			const state = apply(hand(), Action.raiseTo(300));
			const rng = new PythonRandom(7);
			let calls = 0;
			for (let i = 0; i < 4_000; i++) {
				bot.newHand();
				if (bot.act(seatView(state, 1), rng).kind === 'call') calls++;
			}
			expect(calls / 4_000).toBeCloseTo(pseudoHarmonic(0.75, 1.5, 1), 1);
			expect(bot.stats.off_tree).toBe(4_000);
		});

		it('maps small bets and shoves to the nearest ends', () => {
			always(100, 'r0', 'c');
			always(100, 'a', 'f');
			const bot = new BlueprintPolicy(bundle);
			expect(bot.act(seatView(apply(hand(), Action.raiseTo(200)), 1), new PythonRandom(0))).toEqual(
				Action.call()
			);
			expect(bot.stats.below_smallest).toBe(1);
			expect(
				bot.act(seatView(apply(hand(), Action.raiseTo(10_000)), 1), new PythonRandom(0))
			).toEqual(Action.fold());
		});

		it('re-enters the tree when mapping ends the abstract hand', () => {
			always(100, 'a', 'c');
			const bot = new BlueprintPolicy(bundle);
			const rng = new PythonRandom(1);
			let state = apply(hand(), Action.raiseTo(9_800));
			expect(bot.act(seatView(state, 1), rng)).toEqual(Action.call());
			state = apply(state, Action.call());
			expect(state.street).toBe(FLOP);
			const tree = bundle.trees[1];
			const starts = tree.history
				.map((h, v) => v)
				.filter((v) => tree.street[v] === 1 && tree.history[v].endsWith('/'));
			const target = Math.log(200 / 19_600);
			const reentry = starts.reduce((best, v) =>
				Math.abs(Math.log(tree.spr[v]) - target) < Math.abs(Math.log(tree.spr[best]) - target)
					? v
					: best
			);
			always(100, tree.history[reentry], 'a');
			const action = bot.act(seatView(state, 1), rng);
			expect(bot.stats.reentries).toBeGreaterThanOrEqual(1);
			expect(action).toEqual(Action.bet(200));
		});

		it('checks or calls at an untrained node and refuses more players', () => {
			const bot = new BlueprintPolicy(bundle);
			const state = apply(apply(hand(), Action.call()), Action.check());
			expect(bot.act(seatView(state, 1), new PythonRandom(0))).toEqual(Action.check());
			expect(bot.stats.untrained_node).toBe(1);
			const three = startHand(handConfig(50, 100), [10_000, 10_000, 10_000], 0, { deck: DECK });
			expect(() => bot.act(seatView(three, three.toAct!), new PythonRandom(0))).toThrow(/heads-up/);
		});
	});
});
