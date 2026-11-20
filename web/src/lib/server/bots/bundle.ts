// Read a serving bundle written by `rivermind-poker blueprint export` (P4B.6,
// rivermind/bots/blueprint/bundle.py): the uint8 average strategy, the trees
// and the card-table arrays, each a flat little-endian file named with its
// SHA-256 in manifest.json.
//
// `loadBundle` reads every file once, hashes it while it reads, and refuses
// the bundle if any file is missing, extra or different, if a tree's
// recomputed SHA-256 or the layout disagrees with the manifest, or if the
// caller expects another card table set. The arrays then stay in memory, so
// a lookup is an array read.

import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { endianness } from 'node:os';
import { join } from 'node:path';

export const FORMAT = 1;
export const KIND = 'rivermind-serving-bundle';
export const STREETS = ['flop', 'turn', 'river'] as const;
export const INVALID = 0xffff;

export class BundleError extends Error {
	override name = 'BundleError';
}

/** One depth class's compiled tree, as `trees.json` stores it. */
export interface Tree {
	readonly abstraction: string;
	readonly depth: number;
	readonly small_blind: number;
	readonly big_blind: number;
	readonly sha256: string;
	readonly width: readonly [number, number, number, number];
	readonly history: readonly string[];
	readonly player: readonly number[];
	readonly street: readonly number[];
	readonly offset: readonly number[];
	readonly tokens: readonly (readonly string[])[];
	readonly children: readonly (readonly number[])[];
	readonly terminal_kind: readonly number[];
	readonly terminal_value: readonly number[];
	readonly measure: readonly (readonly (number | null)[])[];
	readonly spr: readonly number[];
}

export interface BundleManifest {
	readonly format: number;
	readonly kind: string;
	readonly abstraction: string;
	readonly checkpoint: Record<string, unknown>;
	readonly cards: { readonly table_set: string; readonly sha256: Record<string, string> } & Record<
		string,
		unknown
	>;
	readonly game: {
		readonly buckets: readonly [number, number, number, number];
		readonly size: number;
		readonly base: readonly (readonly [number, number, number, number])[];
		readonly trees: readonly { readonly depth: number; readonly sha256: string }[];
	};
	readonly arrays: Record<string, { readonly dtype: string; readonly shape: readonly number[] }>;
	readonly files: Record<string, { readonly sha256: string; readonly bytes: number }>;
}

/** A tree's SHA-256 as `Tree.sha256` computes it in Python. */
export function treeSha256(tree: Tree): string {
	const body = {
		abstraction: tree.abstraction,
		depth: tree.depth,
		blinds: [tree.small_blind, tree.big_blind],
		nodes: tree.history.map((h, v) => [
			h,
			tree.player[v],
			tree.street[v],
			tree.offset[v],
			tree.tokens[v],
			tree.children[v]
		]),
		terminals: tree.terminal_kind.map((k, t) => [k, tree.terminal_value[t]])
	};
	return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** One SHA-256 naming a table set: over its files' SHA-256s as sorted compact JSON. */
export function tableSetDigest(sha256: Record<string, string>): string {
	const sorted = Object.fromEntries(
		Object.keys(sha256)
			.sort()
			.map((k) => [k, sha256[k]])
	);
	return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// Card buckets (rivermind/bots/cards/tables.py and iso.py)

/** The 24 suit permutations in `itertools.permutations(range(4))` order. */
export const PERMS: readonly (readonly number[])[] = (() => {
	const out: number[][] = [];
	const visit = (prefix: number[], rest: number[]) => {
		if (rest.length === 0) out.push(prefix);
		rest.forEach((x, i) => visit([...prefix, x], [...rest.slice(0, i), ...rest.slice(i + 1)]));
	};
	visit([], [0, 1, 2, 3]);
	return out;
})();

const BINOM: number[][] = Array.from({ length: 53 }, (_, n) =>
	Array.from({ length: 6 }, (_, k) => {
		let c = 1;
		for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
		return k > n ? 0 : c;
	})
);

/** Colexicographic rank of a set of distinct cards. */
export function setRank(cards: readonly number[]): number {
	const sorted = [...cards].sort((a, b) => a - b);
	let rank = 0;
	sorted.forEach((c, i) => (rank += BINOM[c][i + 1]));
	return rank;
}

/** Index of the hole-card pair {a, b}, from 0 to 1,325. */
export function pairIndex(a: number, b: number): number {
	if (a === b) throw new RangeError('a pair needs two different cards');
	if (a > b) [a, b] = [b, a];
	return (b * (b - 1)) / 2 + a;
}

type ByStreet<T> = Record<(typeof STREETS)[number], T>;

export class CardTables {
	readonly preflop: Uint16Array;
	readonly boardClass: ByStreet<Int32Array>;
	readonly boardPerm: ByStreet<Uint8Array>;
	readonly buckets: ByStreet<Uint16Array>;

	constructor(
		preflop: Uint16Array,
		boardClass: ByStreet<Int32Array>,
		boardPerm: ByStreet<Uint8Array>,
		buckets: ByStreet<Uint16Array>
	) {
		this.preflop = preflop;
		this.boardClass = boardClass;
		this.boardPerm = boardPerm;
		this.buckets = buckets;
	}

	/** The bucket of the hole cards on a board of 0, 3, 4 or 5 cards. */
	bucket(hole: readonly number[], board: readonly number[] = []): number {
		const cards = [...hole, ...board];
		const street = ({ 0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river' } as const)[
			board.length as 0 | 3 | 4 | 5
		];
		if (
			street === undefined ||
			hole.length !== 2 ||
			new Set(cards).size !== cards.length ||
			!cards.every((c) => Number.isInteger(c) && c >= 0 && c < 52)
		) {
			throw new BundleError('two hole cards and a board of 0, 3, 4 or 5 other cards are needed');
		}
		const [a, b] = hole;
		if (street === 'preflop') return this.preflop[pairIndex(a, b)];
		const rank = setRank(board);
		const cls = this.boardClass[street][rank];
		const perm = PERMS[this.boardPerm[street][rank]];
		const table = this.buckets[street];
		if ((cls + 1) * 1326 > table.length) throw new BundleError(`no ${street} board class ${cls}`);
		const value = table[cls * 1326 + pairIndex((a & ~3) | perm[a & 3], (b & ~3) | perm[b & 3])];
		if (value === INVALID) throw new BundleError('the hand collides with the board');
		return value;
	}
}

// Loading

export interface Bundle {
	readonly path: string;
	readonly manifest: BundleManifest;
	readonly trees: readonly Tree[];
	readonly buckets: readonly [number, number, number, number];
	readonly base: readonly (readonly [number, number, number, number])[];
	readonly strategy: Uint8Array;
	readonly tables: CardTables;
}

export interface LoadOptions {
	/** Refuse a bundle built from any other card table set (its `cards.table_set` digest). */
	readonly tableSet?: string;
}

const DTYPES = {
	'<u2': { bytes: 2, make: (b: ArrayBuffer, o: number, n: number) => new Uint16Array(b, o, n) },
	'<i4': { bytes: 4, make: (b: ArrayBuffer, o: number, n: number) => new Int32Array(b, o, n) },
	u1: { bytes: 1, make: (b: ArrayBuffer, o: number, n: number) => new Uint8Array(b, o, n) }
} as const;

/** Read a whole file into memory once, hashing it as it is read. */
function readHashed(path: string): { data: Uint8Array; sha256: string } {
	const size = statSync(path).size;
	// A fresh buffer, never Node's shared pool, so typed-array views are aligned.
	const data = new Uint8Array(new ArrayBuffer(size));
	const hash = createHash('sha256');
	const fd = openSync(path, 'r');
	try {
		let at = 0;
		while (at < size) {
			const n = readSync(fd, data, at, Math.min(1 << 24, size - at), at);
			if (n <= 0) throw new BundleError(`${path} ended early`);
			hash.update(data.subarray(at, at + n));
			at += n;
		}
	} finally {
		closeSync(fd);
	}
	return { data, sha256: hash.digest('hex') };
}

export function loadBundle(path: string, options: LoadOptions = {}): Bundle {
	if (endianness() !== 'LE') throw new BundleError('serving bundles are little-endian');
	let manifest: BundleManifest;
	try {
		manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as BundleManifest;
	} catch (error) {
		throw new BundleError(`${path} has no readable manifest.json: ${error}`);
	}
	if (manifest.kind !== KIND || manifest.format !== FORMAT) {
		throw new BundleError(`${path} is not a format ${FORMAT} serving bundle`);
	}
	if (options.tableSet !== undefined && manifest.cards.table_set !== options.tableSet) {
		throw new BundleError('this bundle was not built from the expected card table set');
	}
	if (tableSetDigest(manifest.cards.sha256) !== manifest.cards.table_set) {
		throw new BundleError("the manifest's table set digest does not match its files");
	}
	const present = readdirSync(path, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name !== 'manifest.json')
		.map((e) => e.name);
	const expected = Object.keys(manifest.files);
	const bad = [...new Set([...present, ...expected])]
		.filter((name) => !present.includes(name) || !expected.includes(name))
		.sort();
	if (bad.length) throw new BundleError(`files missing or not in the manifest: ${bad.join(', ')}`);
	const files = new Map<string, Uint8Array>();
	for (const name of expected) {
		const { data, sha256 } = readHashed(join(path, name));
		if (sha256 !== manifest.files[name].sha256 || data.length !== manifest.files[name].bytes) {
			throw new BundleError(`${name} differs from the manifest`);
		}
		files.set(name, data);
	}
	const array = (name: string) => {
		const spec = manifest.arrays[name];
		const data = files.get(name);
		const dtype = spec && DTYPES[spec.dtype as keyof typeof DTYPES];
		if (!spec || !data || !dtype) throw new BundleError(`${name} is missing from the bundle`);
		const count = spec.shape.reduce((a, b) => a * b, 1);
		if (count * dtype.bytes !== data.length) throw new BundleError(`${name} has the wrong size`);
		return dtype.make(data.buffer as ArrayBuffer, data.byteOffset, count);
	};
	const trees = JSON.parse(new TextDecoder().decode(files.get('trees.json'))) as Tree[];
	const layout = manifest.game;
	if (
		trees.length !== layout.trees.length ||
		trees.some(
			(t, d) => t.depth !== layout.trees[d].depth || treeSha256(t) !== layout.trees[d].sha256
		)
	) {
		throw new BundleError("the bundle's trees do not match its manifest");
	}
	let size = 0;
	trees.forEach((t, d) =>
		[0, 1, 2, 3].forEach((s) => {
			if (layout.base[d][s] !== size) throw new BundleError("the bundle's layout is inconsistent");
			size += t.width[s] * layout.buckets[s];
		})
	);
	const strategy = files.get('strategy.u8');
	if (size !== layout.size || strategy?.length !== size) {
		throw new BundleError('the strategy does not fit the layout');
	}
	const tables = new CardTables(
		array('preflop.u16') as Uint16Array,
		Object.fromEntries(STREETS.map((s) => [s, array(`${s}_board_class.i32`)])) as never,
		Object.fromEntries(STREETS.map((s) => [s, array(`${s}_board_perm.u8`)])) as never,
		Object.fromEntries(STREETS.map((s) => [s, array(`${s}.u16`)])) as never
	);
	return {
		path,
		manifest,
		trees,
		buckets: layout.buckets,
		base: layout.base,
		strategy,
		tables
	};
}
