// Test helpers: write a small serving bundle (P4B.6) from TypeScript, with the
// hu-m1 trees or a multiway abstraction's graphs (format 2, P5.7), one bucket
// a street unless told otherwise, and a strategy the test sets info set by
// info set.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	FORMAT,
	GRAPH_FORMAT,
	KIND,
	STREETS,
	tableSetDigest,
	type GraphDocument,
	type Tree
} from './bundle.ts';
import type { Champion, ChampionRegistry } from './champions.ts';

// As champions.ts has it; not imported, so this file loads without the built-in registry.
const REGISTRY_KIND = 'rivermind-site-champions';

const BOARDS = { flop: 22_100, turn: 270_725, river: 2_598_960 } as const;

export interface TestBundle {
	readonly path: string;
	readonly tableSet: string;
	readonly base: number[][];
	/** Each file's SHA-256, as the bundle's manifest has it. */
	readonly files: Record<string, string>;
	/** The checkpoint hashes the manifest names. */
	readonly checkpoint: { manifest_sha256: string; strategy_sha256: string };
}

/** The SHA-256s a test bundle says its checkpoint had. */
export const TEST_CHECKPOINT = {
	manifest_sha256: 'c'.repeat(64),
	strategy_sha256: 'd'.repeat(64)
} as const;

/** Write a bundle into `dir`; every card lookup lands in bucket 0 of a 1-class table unless `buckets` says more. */
export function writeBundle(
	dir: string,
	trees: readonly (Tree | GraphDocument)[],
	{
		buckets = [1, 1, 1, 1] as [number, number, number, number],
		strategy
	}: { buckets?: [number, number, number, number]; strategy?: Uint8Array } = {}
): TestBundle {
	mkdirSync(dir, { recursive: true });
	const base: number[][] = [];
	let size = 0;
	for (const tree of trees) {
		const row: number[] = [];
		for (let s = 0; s < 4; s++) {
			row.push(size);
			size += tree.width[s] * buckets[s];
		}
		base.push(row);
	}
	const files: Record<string, Uint8Array | string> = {
		'strategy.u8': strategy ?? new Uint8Array(size),
		'trees.json': JSON.stringify(trees),
		'preflop.u16': new Uint8Array(new Uint16Array(1326).buffer)
	};
	const arrays: Record<string, { dtype: string; shape: number[] }> = {
		'preflop.u16': { dtype: '<u2', shape: [1326] }
	};
	for (const street of STREETS) {
		files[`${street}_board_class.i32`] = new Uint8Array(new Int32Array(BOARDS[street]).buffer);
		files[`${street}_board_perm.u8`] = new Uint8Array(BOARDS[street]);
		files[`${street}.u16`] = new Uint8Array(new Uint16Array(1326).buffer);
		arrays[`${street}_board_class.i32`] = { dtype: '<i4', shape: [BOARDS[street]] };
		arrays[`${street}_board_perm.u8`] = { dtype: 'u1', shape: [BOARDS[street]] };
		arrays[`${street}.u16`] = { dtype: '<u2', shape: [1, 1326] };
	}
	const entries: Record<string, { sha256: string; bytes: number }> = {};
	for (const [name, data] of Object.entries(files)) {
		writeFileSync(join(dir, name), data);
		const bytes = typeof data === 'string' ? Buffer.from(data) : data;
		entries[name] = {
			sha256: createHash('sha256').update(bytes).digest('hex'),
			bytes: bytes.length
		};
	}
	const sha256 = { 'test.npy': 'test' };
	const tableSet = tableSetDigest(sha256);
	const manifest = {
		format: 'token_sets' in trees[0] ? GRAPH_FORMAT : FORMAT,
		kind: KIND,
		abstraction: trees[0].abstraction,
		checkpoint: { synthetic: true, ...TEST_CHECKPOINT },
		cards: { synthetic: true, table_set: tableSet, sha256 },
		game: {
			buckets,
			size,
			base,
			trees: trees.map((t) => ({ depth: t.depth, sha256: t.sha256 }))
		},
		strategy: { file: 'strategy.u8', levels: 255 },
		arrays,
		files: entries
	};
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
	const hashes = Object.fromEntries(Object.entries(entries).map(([name, e]) => [name, e.sha256]));
	return { path: dir, tableSet, base, files: hashes, checkpoint: { ...TEST_CHECKPOINT } };
}

/** A strategy of `size` slots with seeded random weights, so a test bundle's bot bets, raises and folds. */
export function randomStrategy(size: number, seed = 1): Uint8Array {
	const out = new Uint8Array(size);
	let x = seed >>> 0 || 1;
	for (let i = 0; i < size; i++) {
		// xorshift32
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		out[i] = x & 0xff;
	}
	return out;
}

/** The slots a bundle of `trees` needs with `buckets` a street. */
export function strategySize(
	trees: readonly (Tree | GraphDocument)[],
	buckets: [number, number, number, number] = [1, 1, 1, 1]
): number {
	let size = 0;
	for (const tree of trees) for (let s = 0; s < 4; s++) size += tree.width[s] * buckets[s];
	return size;
}

/**
 * A models directory holding one champion called `name`, as `rivermind-poker
 * blueprint promote` keeps one (`<models>/<name>/bundle`), and the registry
 * extract a server checks it against. The champion is heads-up for the hu-m1
 * trees and six-seat for `6max-s1` graphs (P5.7). With `medium`, the extract
 * also records an evaluation of its RiverMind Medium (P5.7); `others` are
 * champions already written to `models`, listed in the extract before it.
 */
export function writeChampion(
	models: string,
	trees: readonly (Tree | GraphDocument)[],
	{
		name = 'test-champion',
		strategy,
		medium = false,
		others = []
	}: { name?: string; strategy?: Uint8Array; medium?: boolean; others?: readonly Champion[] } = {}
): { champion: Champion; registry: ChampionRegistry; bundle: TestBundle } {
	const multiway = 'token_sets' in trees[0];
	const bundle = writeBundle(join(models, name, 'bundle'), trees, {
		strategy: strategy ?? randomStrategy(strategySize(trees))
	});
	const result = (opponent: string, bb: number, lo: number, hi: number) => ({
		opponent,
		name: opponent === 'champion' ? 'older-champion' : null,
		stack_bb: 100,
		hands: 40_000,
		bb_per_100: bb,
		ci95: [lo, hi] as [number, number],
		gate: true
	});
	const champion: Champion = {
		format: multiway ? '6-max' : 'heads-up',
		seats: multiway ? 6 : 2,
		name,
		abstraction: multiway ? trees[0].abstraction : 'hu-m1',
		iterations: 1_000,
		promoted: '2026-11-21',
		replaced: 'older-champion',
		checkpoint: {
			manifest_sha256: bundle.checkpoint.manifest_sha256,
			files: { 'regrets.npy': 'e'.repeat(64), 'strategy.npy': bundle.checkpoint.strategy_sha256 }
		},
		bundle: { levels: 255, table_set: bundle.tableSet, files: bundle.files },
		evaluations: [
			{
				candidate: 'bundle',
				report: `evaluations/${name}-served`,
				deals: 20_000,
				seed: 0,
				blinds: [50, 100],
				evaluated_at: '0'.repeat(40),
				results: [
					result('heuristic', 58.79, 50.09, 67.48),
					result('calling_station', 224.92, 208.64, 241.2),
					{ ...result('random', 209.67, 188.65, 230.68), gate: false },
					result('champion', 21.14, 10.45, 31.84)
				]
			}
		]
	};
	if (medium) {
		champion.levels = {
			medium: {
				share: 0.5,
				recorded: '2026-11-23',
				evaluation: {
					candidate: 'medium',
					report: `evaluations/${name}-medium`,
					deals: 20_000,
					seed: 0,
					blinds: [50, 100],
					evaluated_at: '0'.repeat(40),
					results: [
						{ ...result('heuristic', 29.4, 20.1, 38.7), gate: false },
						{ ...result('calling_station', 190.2, 172.5, 207.9), gate: false },
						{ ...result('random', 180.0, 160.0, 200.0), gate: false },
						{ ...result('hard', -30.5, -41.2, -19.8), name, gate: false },
						{ ...result('heuristic', 20.0, 12.0, 28.0), stack_bb: 40, gate: false }
					]
				}
			}
		};
	}
	const registry: ChampionRegistry = {
		format: 1,
		kind: REGISTRY_KIND,
		champions: [...others, champion]
	};
	writeFileSync(join(models, 'champions.json'), JSON.stringify(registry, null, 2));
	return { champion, registry, bundle };
}

/** The checkpoint a test nine-seat bundle names, as a real one names the checkpoint it was exported from. */
export const TEST_NINE_CHECKPOINT = {
	manifest_sha256: 'a'.repeat(64),
	strategy_sha256: 'b'.repeat(64)
} as const;

/**
 * A nine-seat champion called `name` on the six-seat champion `six` (P5.6,
 * option 1): an early table of seeded random weights in
 * `<models>/<name>/bundle`, and the registry extract with `others` before it.
 */
export function writeNineChampion(
	models: string,
	six: Champion,
	{
		name = 'test-nine',
		medium = false,
		others = [],
		seed = 7
	}: { name?: string; medium?: boolean; others?: readonly Champion[]; seed?: number } = {}
): { champion: Champion; registry: ChampionRegistry } {
	const dir = join(models, name, 'bundle');
	mkdirSync(dir, { recursive: true });
	const early = randomStrategy(54 * 169 * 4, seed);
	writeFileSync(join(dir, 'early.u8'), early);
	const sha256 = createHash('sha256').update(early).digest('hex');
	const manifest = {
		format: 1,
		kind: 'rivermind-nine-bundle',
		abstraction: '9max-o1',
		seats: 9,
		builds_on: {
			bundle: `${six.name}/bundle`,
			files: six.bundle.files,
			table_set: six.bundle.table_set
		},
		strategy: { levels: 255, shape: [54, 169, 4] },
		checkpoint: { iteration: 1_000, ...TEST_NINE_CHECKPOINT },
		files: { 'early.u8': { sha256, bytes: early.length } }
	};
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
	const result = (opponent: string, bb: number, lo: number, hi: number) => ({
		opponent,
		name: null,
		stack_bb: 100,
		hands: 180_000,
		bb_per_100: bb,
		ci95: [lo, hi] as [number, number],
		gate: true
	});
	const champion: Champion = {
		format: '9-max',
		seats: 9,
		name,
		abstraction: '9max-o1',
		iterations: 1_000,
		promoted: '2026-11-24',
		replaced: null,
		builds_on: six.name,
		checkpoint: {
			manifest_sha256: TEST_NINE_CHECKPOINT.manifest_sha256,
			files: { 'regrets.npy': 'e'.repeat(64), 'strategy.npy': TEST_NINE_CHECKPOINT.strategy_sha256 }
		},
		bundle: { levels: 255, table_set: six.bundle.table_set, files: { 'early.u8': sha256 } },
		evaluations: [
			{
				candidate: 'bundle',
				report: `evaluations/${name}-served`,
				deals: 20_000,
				seed: 0,
				blinds: [50, 100],
				evaluated_at: '0'.repeat(40),
				results: [
					result('heuristic', 15.2, 9.1, 21.3),
					result('calling_station', 610.4, 560.2, 660.6)
				]
			}
		]
	};
	if (medium) {
		champion.levels = {
			medium: {
				share: 0.5,
				recorded: '2026-11-24',
				evaluation: {
					candidate: 'medium',
					report: `evaluations/${name}-medium`,
					deals: 20_000,
					seed: 0,
					blinds: [50, 100],
					evaluated_at: '0'.repeat(40),
					results: [
						{ ...result('heuristic', 7.6, 3.5, 11.7), gate: false },
						{ ...result('calling_station', 760.1, 712.0, 808.2), gate: false },
						{ ...result('hard', -5.1, -9.6, -0.6), name, gate: false }
					]
				}
			}
		};
	}
	const registry: ChampionRegistry = {
		format: 1,
		kind: REGISTRY_KIND,
		champions: [...others, champion]
	};
	writeFileSync(join(models, 'champions.json'), JSON.stringify(registry, null, 2));
	return { champion, registry };
}
