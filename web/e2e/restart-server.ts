// The site on PostgreSQL, restarted on request: for the iPhone app's check that it
// rejoins a hand in progress across a server restart (P5D.3,
// TableConnectionRestartTests.swift). It empties and migrates the test database,
// starts the built Node server on it, and answers POST /restart on a control port
// by killing the server outright, as a crash would, and starting it again on the
// same port and database, which restores every table with its hand in progress.
// Node runs it as it is, so it imports nothing that needs more than type
// stripping (e2e/server.ts does).
//
// Test-only, and only on a database whose name says it is for tests.
//
//   RIVERMIND_TEST_DATABASE_URL=postgresql://localhost/rivermind_test \
//     PORT=4384 CONTROL_PORT=4385 node e2e/restart-server.ts

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { migrate } from '../src/lib/server/db/migrate.ts';
import { resetDatabase, testDatabaseUrl } from '../src/lib/server/db/testing.ts';

const url = testDatabaseUrl();
if (!url) throw new Error('set RIVERMIND_TEST_DATABASE_URL to a disposable test database');
const port = Number(process.env.PORT ?? 4384);
const control = Number(process.env.CONTROL_PORT ?? port + 1);
const origin = `http://127.0.0.1:${port}`;
const web = resolve(import.meta.dirname, '..');

await resetDatabase(url);
await migrate(url);

let child: ChildProcess | null = null;
let output = '';

async function answers(): Promise<boolean> {
	try {
		return (await fetch(`${origin}/healthz`)).ok;
	} catch {
		return false;
	}
}

async function start(): Promise<void> {
	output = '';
	child = spawn(process.execPath, ['build/start.js'], {
		cwd: web,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(port),
			ORIGIN: origin,
			RIVERMIND_API: '1',
			DATABASE_URL: url,
			// One secret across restarts, as the live site keeps its in a file: a new one
			// would sign every guest out, and the check would see that instead.
			RIVERMIND_SECRET: 'the iPhone app restart check',
			// As the browser tests' server (e2e/server.ts): quick bots and short pauses.
			RIVERMIND_HAND_PAUSE: '0.4',
			RIVERMIND_BOT_DELAY: '0.05',
			RIVERMIND_PRACTICE_STACK: '300'
		}
	});
	child.stdout?.on('data', (chunk) => (output += chunk));
	child.stderr?.on('data', (chunk) => (output += chunk));
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) break;
		if (await answers()) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`the server did not start:\n${output}`);
}

/** Kills the server outright, with no graceful shutdown, as a crash would. */
async function kill(): Promise<void> {
	const running = child;
	child = null;
	if (!running || running.exitCode !== null) return;
	const exited = new Promise((r) => running.once('exit', r));
	process.kill(-running.pid!, 'SIGKILL');
	await exited;
	while (await answers()) await new Promise((r) => setTimeout(r, 100));
}

await start();
let restarts = Promise.resolve();
createServer((req, res) => {
	if (req.method !== 'POST' || req.url !== '/restart') {
		res.statusCode = 404;
		res.end();
		return;
	}
	restarts = restarts.then(async () => {
		try {
			await kill();
			await start();
			res.statusCode = 204;
		} catch (error) {
			res.statusCode = 500;
			console.error(error);
		}
		res.end();
	});
}).listen(control, '127.0.0.1', () => console.log(`Restartable site on ${origin}`));

const stop = () => void kill().finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
