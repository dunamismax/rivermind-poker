// Differential test of the TypeScript table against the Python reference
// (P4B.5b). Runs `python -m test.server.table_differential` through uv from
// the repository root, replays every request it writes against
// src/lib/server/table and compares the digest of each request's answer,
// events, departures, finished hands and whole snapshot. Exits non-zero on
// the first difference, and names where the documents differ.
//
//   node scripts/table-parity.ts [--sequences 100] [--ops 250] [--seed 1000]

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
	canonical,
	firstDifference,
	replaySequence,
	type Sequence
} from '../src/lib/server/table/parity.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// `pnpm table:parity -- --ops 10` passes the `--` through; drop it.
const argv = process.argv.slice(2);
const { values } = parseArgs({
	args: argv[0] === '--' ? argv.slice(1) : argv,
	options: {
		sequences: { type: 'string', default: '100' },
		ops: { type: 'string', default: '250' },
		seed: { type: 'string', default: '1000' }
	}
});

function python(args: string[]) {
	const child = spawn(
		'uv',
		['run', '--locked', 'python', '-m', 'test.server.table_differential', ...args],
		{ cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }
	);
	const exited = new Promise<void>((resolveExit, reject) => {
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0 ? resolveExit() : reject(new Error(`table_differential exited with ${code}`))
		);
	});
	return { child, exited };
}

async function sequencesFrom(args: string[]): Promise<Sequence[]> {
	const { child, exited } = python(args);
	const found: Sequence[] = [];
	for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
		if (line) found.push(JSON.parse(line) as Sequence);
	}
	await exited;
	return found;
}

const started = performance.now();
const args = ['--sequences', values.sequences, '--ops', values.ops, '--seed', values.seed];
let requests = 0;
let hands = 0;
for (const sequence of await sequencesFrom(args)) {
	const difference = replaySequence(sequence);
	if (difference !== null) {
		// Ask Python for the whole documents of this one sequence, to say what differs.
		const [full] = await sequencesFrom([
			'--sequences',
			'1',
			'--ops',
			values.ops,
			'--seed',
			String(sequence.seed),
			'--full'
		]);
		const expected = full.documents?.[difference.index];
		console.error(
			`table parity FAILED: sequence ${difference.seed}, request ${difference.index} ` +
				`${canonical(difference.op)}\n  ${firstDifference(difference.document, expected)}`
		);
		process.exit(1);
	}
	requests += sequence.ops.length;
	hands += sequence.ops.filter((op) => op[0] === 'start').length;
}
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(
	`table parity: ${values.sequences} sequences, ${requests} requests ` +
		`(${hands} asked to deal) matched Python's digests in ${seconds} s`
);
