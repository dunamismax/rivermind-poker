// Runs a real `rivermind-poker serve` for the browser tests: the built
// client, the table API and the WebSocket on one origin, with a SQLite state
// file so tables survive the restarts some tests perform.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');

export class TableServer {
	readonly url: string;
	readonly #dir = mkdtempSync(join(tmpdir(), 'rivermind-e2e-'));
	#process: ChildProcess | null = null;
	#output = '';

	constructor(readonly port: number) {
		this.url = `http://127.0.0.1:${port}`;
	}

	async start(): Promise<void> {
		const child = spawn(
			'uv',
			[
				'run',
				'--locked',
				'rivermind-poker',
				'serve',
				'--port',
				String(this.port),
				'--client_dir',
				'web/build',
				'--state_path',
				join(this.#dir, 'tables.sqlite3')
			],
			// Its own process group, so a kill reaches the Python process under uv.
			{ cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
		);
		this.#process = child;
		child.stdout?.on('data', (chunk) => (this.#output += chunk));
		child.stderr?.on('data', (chunk) => (this.#output += chunk));
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) break;
			try {
				if ((await fetch(`${this.url}/api/config`)).ok) return;
			} catch {
				// not listening yet
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`serve did not start on ${this.port}:\n${this.#output}`);
	}

	/** Kill the process outright (no graceful shutdown), as a crash would. */
	async stop(): Promise<void> {
		const child = this.#process;
		this.#process = null;
		if (!child || child.exitCode !== null) return;
		const exited = new Promise((r) => child.once('exit', r));
		process.kill(-child.pid!, 'SIGKILL');
		await exited;
		await this.#waitUntilDown();
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	async dispose(): Promise<void> {
		await this.stop();
		rmSync(this.#dir, { recursive: true, force: true });
	}

	async #waitUntilDown(): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try {
				await fetch(`${this.url}/api/config`);
			} catch {
				return;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`serve on ${this.port} is still answering after being killed`);
	}
}
