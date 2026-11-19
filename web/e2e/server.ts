// Runs a real `rivermind-poker serve-nl` for the browser tests: the built
// client, the table API and the WebSocket on one origin. Tables live in
// memory; their durability is tested in pytest (test/db).

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');

export class TableServer {
	readonly url: string;
	#process: ChildProcess | null = null;
	#output = '';

	constructor(readonly port: number) {
		this.url = `http://127.0.0.1:${port}`;
	}

	#args(): string[] {
		// Quick bots and hands, so the tests play many of them.
		return [
			'serve-nl',
			'--port',
			String(this.port),
			'--client_dir',
			'web/build',
			'--hand_pause',
			'0.4',
			'--bot_delay',
			'0.05'
		];
	}

	async start(): Promise<void> {
		const child = spawn(
			'uv',
			['run', '--locked', 'rivermind-poker', ...this.#args()],
			// Its own process group, so a kill reaches the Python process under uv.
			{
				cwd: REPO,
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: true,
				// Never a developer's database: these tables live in memory.
				env: { ...process.env, DATABASE_URL: '' }
			}
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
		throw new Error(`serve-nl did not start on ${this.port}:\n${this.#output}`);
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
