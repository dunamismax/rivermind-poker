// Differential test of the TypeScript engine against the Python reference
// (P4B.4). Runs `python -m rivermind.engine.differential` through uv from the
// repository root, replays every hand it writes and checks that the hand
// record, the final state document and the digest of every intermediate
// state, legal-action set and text history are byte-identical, then compares
// evaluator digests. Exits non-zero on the first difference.
//
//   node scripts/engine-parity.ts [--hands 625] [--seats 2-9] [--seed 0]
//     [--evaluator-hands 100000] [--all-five] [--skip-hands]

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dumps, replayRecord } from '../src/lib/server/engine/history.ts';
import {
	allFiveCardHands,
	evaluatorReport,
	handLine,
	sampleHands,
	type EvaluatorReport
} from '../src/lib/server/engine/parity.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// `pnpm engine:… -- --hands 10` passes the `--` through; drop it.
const argv = process.argv.slice(2);
const { values } = parseArgs({
	args: argv[0] === '--' ? argv.slice(1) : argv,
	options: {
		hands: { type: 'string', default: '625' },
		seats: { type: 'string', default: '2-9' },
		seed: { type: 'string', default: '0' },
		'evaluator-hands': { type: 'string', default: '100000' },
		'all-five': { type: 'boolean', default: false },
		'skip-hands': { type: 'boolean', default: false }
	}
});

function python(args: string[]) {
	const child = spawn(
		'uv',
		['run', '--locked', 'python', '-m', 'rivermind.engine.differential', ...args],
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
	console.error(`engine parity FAILED: ${message}`);
	process.exit(1);
}

function firstDifference(a: string, b: string): string {
	let i = 0;
	while (i < a.length && a[i] === b[i]) i++;
	return `at character ${i}:\n  python: ${b.slice(Math.max(0, i - 60), i + 60)}\n  ts:     ${a.slice(Math.max(0, i - 60), i + 60)}`;
}

async function checkHands(): Promise<number> {
	const { child, exited } = python([
		'hands',
		'--hands',
		values.hands,
		'--seats',
		values.seats,
		'--seed',
		values.seed
	]);
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	let count = 0;
	for await (const line of lines) {
		const expected = line.split('\t');
		if (expected.length !== 3) fail(`line ${count + 1} does not have three fields`);
		let actual: [string, string, string];
		try {
			actual = handLine(replayRecord(JSON.parse(expected[0])));
		} catch (error) {
			fail(`line ${count + 1} did not replay: ${error}\n  ${expected[0]}`);
		}
		const names = ['hand record', 'final state', 'digest'];
		for (let i = 0; i < 3; i++) {
			if (actual[i] !== expected[i]) {
				fail(`line ${count + 1}: ${names[i]} differs ${firstDifference(actual[i], expected[i])}`);
			}
		}
		count++;
	}
	await exited;
	if (count === 0) fail('the reference wrote no hands');
	return count;
}

async function pythonReport(args: string[]): Promise<EvaluatorReport> {
	const { child, exited } = python(['evaluator', ...args]);
	let text = '';
	for await (const chunk of child.stdout) text += chunk;
	await exited;
	return JSON.parse(text) as EvaluatorReport;
}

async function checkEvaluator(
	args: string[],
	ours: () => EvaluatorReport
): Promise<EvaluatorReport> {
	const [expected, actual] = await Promise.all([pythonReport(args), Promise.resolve().then(ours)]);
	if (dumps(actual) !== dumps(expected)) {
		fail(
			`evaluator ${args.join(' ')} differs:\n  python: ${dumps(expected)}\n  ts:     ${dumps(actual)}`
		);
	}
	return actual;
}

const started = performance.now();
const report: Record<string, unknown> = {};
if (!values['skip-hands']) {
	report.hands = await checkHands();
}
const sample = Number(values['evaluator-hands']);
const seed = Number(values.seed);
if (sample > 0) {
	report.evaluator = [];
	for (const size of [5, 6, 7]) {
		const args = ['--size', String(size), '--hands', String(sample), '--seed', String(seed)];
		(report.evaluator as unknown[]).push(
			await checkEvaluator(args, () =>
				evaluatorReport(sampleHands(size, sample, seed), { size, seed })
			)
		);
	}
}
if (values['all-five']) {
	report.all_five = await checkEvaluator(['--all-five'], () =>
		evaluatorReport(allFiveCardHands(), { all_five: true })
	);
}
report.seconds = Math.round((performance.now() - started) / 100) / 10;
console.log(JSON.stringify({ parity: 'ok', ...report }, null, 2));
