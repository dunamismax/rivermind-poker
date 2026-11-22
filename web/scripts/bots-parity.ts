// Differential test of the TypeScript bots against the Python reference
// (P4B.6). Runs `python -m rivermind.bots.differential` through uv from the
// repository root and checks, with the same deals and generator seeds:
//
//   1. the random, calling-station, heuristic and min-bet bots play every
//      fuzz deal to a byte-identical hand record;
//   2. the blueprint of a serving bundle gives the same probabilities at
//      every decision (to within 1e-9), the same statistics and the same
//      hand records, heads-up against each of those bots and itself;
//   3. card-bucket lookups agree on every hole-card pair for a seeded sample
//      of boards on each street;
//   4. the blueprint of a multiway (format 2) bundle does the same at a table
//      of its size with three or more dealt in, in one or more seats, against
//      those bots and itself (P5.7).
//
// Without --bundle it checks a synthetic bundle (the real trees with random
// strategies and card tables), which CI can build in a second. Without
// --multiway-bundle it checks a synthetic six-seat bundle of the 50 big
// blind graph, which Python compiles in half a minute where no cache holds it.
//
//   node scripts/bots-parity.ts [--hands 250] [--seats 2-9] [--seed 0]
//     [--bundle <dir>] [--tables <dir>] [--decisions 2000] [--boards 200]
//     [--multiway-bundle <dir>] [--multiway-decisions 2000]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BlueprintPolicy } from '../src/lib/server/bots/blueprint.ts';
import { loadBundle } from '../src/lib/server/bots/bundle.ts';
import { MultiwayBlueprintPolicy } from '../src/lib/server/bots/multiway.ts';
import {
	bucketReport,
	largestDifference,
	replayLine,
	simpleBots,
	type TrainedPolicy
} from '../src/lib/server/bots/parity.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const { values } = parseArgs({
	args: argv[0] === '--' ? argv.slice(1) : argv,
	options: {
		hands: { type: 'string', default: '250' },
		seats: { type: 'string', default: '2-9' },
		seed: { type: 'string', default: '0' },
		bundle: { type: 'string' },
		tables: { type: 'string' },
		decisions: { type: 'string', default: '2000' },
		boards: { type: 'string', default: '200' },
		'multiway-bundle': { type: 'string' },
		'multiway-decisions': { type: 'string', default: '2000' }
	}
});
const TOLERANCE = 1e-9;

function python(args: string[]) {
	const child = spawn(
		'uv',
		['run', '--locked', 'python', '-m', 'rivermind.bots.differential', ...args],
		{ cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }
	);
	const exited = new Promise<void>((resolveExit, reject) => {
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0 ? resolveExit() : reject(new Error(`differential ${args[0]} exited with ${code}`))
		);
	});
	return { child, exited };
}

function fail(message: string): never {
	console.error(`bots parity FAILED: ${message}`);
	process.exit(1);
}

async function lines(args: string[], each: (fields: string[], n: number) => void): Promise<number> {
	const { child, exited } = python(args);
	let count = 0;
	for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
		const fields = line.split('\t');
		if (fields.length !== 2) fail(`${args[0]} line ${count + 1} does not have two fields`);
		each(fields, ++count);
	}
	await exited;
	if (count === 0) fail(`the reference wrote no ${args[0]} lines`);
	return count;
}

const started = performance.now();
const report: Record<string, unknown> = {};
const seed = values.seed;
let blueprintReport: Record<string, unknown> = {};

/** Replay the reference's hands of a blueprint and compare probabilities, statistics and records. */
async function checkBlueprint(
	label: string,
	args: string[],
	blueprint: TrainedPolicy
): Promise<number> {
	const withBlueprint = { ...bots, blueprint };
	let decisions = 0;
	let largest = 0;
	let exact = true;
	const hands = await lines(args, ([metaText, record], n) => {
		const meta = JSON.parse(metaText);
		const result = replayLine(meta, JSON.parse(record), withBlueprint, blueprint);
		const gap = largestDifference(result.probabilities, meta.probabilities);
		if (gap === null || gap > TOLERANCE) {
			fail(
				`${label} line ${n}: probabilities differ (${gap}):\n  python: ${JSON.stringify(meta.probabilities)}\n  ts:     ${JSON.stringify(result.probabilities)}`
			);
		}
		if (JSON.stringify(result.probabilities) !== JSON.stringify(meta.probabilities)) exact = false;
		largest = Math.max(largest, gap);
		if (JSON.stringify(result.stats) !== JSON.stringify(meta.stats)) {
			fail(
				`${label} line ${n}: statistics differ:\n  python: ${JSON.stringify(meta.stats)}\n  ts:     ${JSON.stringify(result.stats)}`
			);
		}
		if (result.record !== record) {
			fail(`${label} line ${n} differs:\n  python: ${record}\n  ts:     ${result.record}`);
		}
		decisions += result.probabilities.length;
	});
	blueprintReport = {
		decisions,
		largest_difference: largest,
		identical: exact,
		stats: blueprint.stats
	};
	return hands;
}

// 1. Simple bots on the fuzz deals.
const bots = simpleBots();
report.policy_hands = await lines(
	['policies', '--hands', values.hands, '--seats', values.seats, '--seed', seed],
	([meta, record], n) => {
		const result = replayLine(JSON.parse(meta), JSON.parse(record), bots);
		if (result.record !== record) {
			fail(
				`policies line ${n} (${meta}) differs:\n  python: ${record}\n  ts:     ${result.record}`
			);
		}
	}
);

// 2. The blueprint, on a real or synthetic bundle.
let scratch: string | null = null;
let bundlePath = values.bundle;
if (bundlePath === undefined) {
	scratch = mkdtempSync(join(tmpdir(), 'rivermind-bundle-'));
	bundlePath = join(scratch, 'synthetic');
	const { exited } = python(['synthetic', bundlePath, '--seed', seed]);
	await exited;
}
bundlePath = resolve(bundlePath);
try {
	const loadStarted = performance.now();
	const bundle = loadBundle(bundlePath);
	report.bundle = {
		path: values.bundle ?? 'synthetic',
		checkpoint: bundle.manifest.checkpoint.path ?? 'synthetic',
		iteration: bundle.manifest.checkpoint.iteration ?? null,
		table_set: bundle.manifest.cards.table_set,
		load_seconds: Math.round((performance.now() - loadStarted) / 100) / 10
	};
	const blueprint = new BlueprintPolicy(bundle);
	report.blueprint_hands = await checkBlueprint(
		'blueprint',
		['blueprint', bundlePath, '--decisions', values.decisions, '--seed', seed],
		blueprint
	);
	report.blueprint = blueprintReport;

	// 3. Card buckets.
	const boards = Number(values.boards);
	const { child, exited } = python([
		'buckets',
		bundlePath,
		'--boards',
		values.boards,
		'--seed',
		seed,
		...(values.tables ? ['--tables', resolve(values.tables)] : [])
	]);
	let text = '';
	for await (const chunk of child.stdout) text += chunk;
	await exited;
	const expected = JSON.parse(text);
	const actual = bucketReport(bundle.tables, boards, Number(seed));
	const sorted = (o: object) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
	if (sorted(actual) !== sorted(expected)) {
		fail(`bucket digests differ:\n  python: ${sorted(expected)}\n  ts:     ${sorted(actual)}`);
	}
	report.buckets = { boards_per_street: boards, against: values.tables ? 'tables' : 'bundle' };
} finally {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
}

// 4. A multiway blueprint, on a real or synthetic format 2 bundle.
let multiwayScratch: string | null = null;
let multiwayPath = values['multiway-bundle'];
if (multiwayPath === undefined) {
	multiwayScratch = mkdtempSync(join(tmpdir(), 'rivermind-bundle-'));
	multiwayPath = join(multiwayScratch, 'synthetic');
	const { exited } = python([
		'synthetic',
		multiwayPath,
		'--seed',
		seed,
		'--abstraction',
		'6max-s1',
		'--depths',
		'50'
	]);
	await exited;
}
multiwayPath = resolve(multiwayPath);
try {
	const loadStarted = performance.now();
	const bundle = loadBundle(multiwayPath);
	report.multiway_bundle = {
		path: values['multiway-bundle'] ?? 'synthetic',
		abstraction: bundle.manifest.abstraction,
		seats: bundle.seats,
		depths: bundle.graphs.map((g) => g.depth),
		table_set: bundle.manifest.cards.table_set,
		load_seconds: Math.round((performance.now() - loadStarted) / 100) / 10
	};
	const blueprint = new MultiwayBlueprintPolicy(bundle);
	report.multiway_hands = await checkBlueprint(
		'multiway',
		['multiway', multiwayPath, '--decisions', values['multiway-decisions'], '--seed', seed],
		blueprint
	);
	report.multiway = blueprintReport;
} finally {
	if (multiwayScratch) rmSync(multiwayScratch, { recursive: true, force: true });
}
report.seconds = Math.round((performance.now() - started) / 100) / 10;
console.log(JSON.stringify({ parity: 'ok', ...report }, null, 2));
