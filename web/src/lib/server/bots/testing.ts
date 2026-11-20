// Test helpers: write a small serving bundle (P4B.6) from TypeScript, with the
// hu-m1 trees, one bucket a street unless told otherwise, and a strategy the
// test sets info set by info set.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAT, KIND, STREETS, tableSetDigest, type Tree } from './bundle.ts';

const BOARDS = { flop: 22_100, turn: 270_725, river: 2_598_960 } as const;

export interface TestBundle {
	readonly path: string;
	readonly tableSet: string;
	readonly base: number[][];
}

/** Write a bundle into `dir`; every card lookup lands in bucket 0 of a 1-class table unless `buckets` says more. */
export function writeBundle(
	dir: string,
	trees: readonly Tree[],
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
		format: FORMAT,
		kind: KIND,
		abstraction: 'hu-m1',
		checkpoint: { synthetic: true },
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
	return { path: dir, tableSet, base };
}
