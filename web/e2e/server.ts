// Runs the site as the browser tests see it: the built Node server
// (`node build/start.js`) serving the pages, the API and the tables itself
// (P4B.5b). Until the P4B.7 cutover the live tables are still in Python, so
// with E2E_LEGACY=1 the Node server instead forwards /api/* and /ws to a real
// `rivermind-poker serve-nl` on another port, as the live site does. Tables
// live in memory; their durability is tested in Vitest and pytest.

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const WEB = resolve(import.meta.dirname, '..');
const REPO = resolve(WEB, '..');

/** One child process, started in its own group so a kill reaches everything under it. */
class Child {
	#process: ChildProcess | null = null;
	#output = '';

	constructor(
		readonly name: string,
		readonly ready: string,
		readonly command: string,
		readonly args: string[],
		readonly cwd: string,
		readonly env: NodeJS.ProcessEnv
	) {}

	async start(): Promise<void> {
		const child = spawn(this.command, this.args, {
			cwd: this.cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
			env: this.env
		});
		this.#process = child;
		this.#output = '';
		child.stdout?.on('data', (chunk) => (this.#output += chunk));
		child.stderr?.on('data', (chunk) => (this.#output += chunk));
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) break;
			try {
				if ((await fetch(this.ready)).ok) return;
			} catch {
				// not listening yet
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`${this.name} did not start (${this.ready}):\n${this.#output}`);
	}

	/** Kill the process outright (no graceful shutdown), as a crash would. */
	async stop(): Promise<void> {
		const child = this.#process;
		this.#process = null;
		if (!child || child.exitCode !== null) return;
		const exited = new Promise((r) => child.once('exit', r));
		process.kill(-child.pid!, 'SIGKILL');
		await exited;
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try {
				await fetch(this.ready);
			} catch {
				return;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error(`${this.name} is still answering after being killed`);
	}
}

/** Whether the tables run in serve-nl behind the Node server, as they do live until P4B.7. */
export const LEGACY = process.env.E2E_LEGACY === '1';

// Quick bots and hands, so the tests play many of them, and a short practice
// stack, so a guest who calls every bet runs out within a minute or two.
const HAND_PAUSE = '0.4';
const BOT_DELAY = '0.05';
const PRACTICE_STACK = '300';

export class TableServer {
	/** The site's origin: the Node server. */
	readonly url: string;
	readonly #tables: Child | null;
	readonly #web: Child;

	/** `port` is the Node server's; with E2E_LEGACY, serve-nl listens 100 below it. */
	constructor(readonly port: number) {
		this.url = `http://127.0.0.1:${port}`;
		const legacy = `http://127.0.0.1:${port - 100}`;
		const args = [
			'run',
			'--locked',
			'rivermind-poker',
			'serve-nl',
			'--port',
			String(port - 100),
			'--hand_pause',
			HAND_PAUSE,
			'--bot_delay',
			BOT_DELAY,
			'--practice_stack',
			PRACTICE_STACK
		];
		// Never a developer's database: these tables live in memory.
		this.#tables = LEGACY
			? new Child('serve-nl', `${legacy}/api/config`, 'uv', args, REPO, {
					...process.env,
					DATABASE_URL: ''
				})
			: null;
		const tables: NodeJS.ProcessEnv = LEGACY
			? { RIVERMIND_LEGACY_API: legacy }
			: {
					RIVERMIND_LEGACY_API: '',
					RIVERMIND_API: '1',
					DATABASE_URL: '',
					RIVERMIND_HAND_PAUSE: HAND_PAUSE,
					RIVERMIND_BOT_DELAY: BOT_DELAY,
					RIVERMIND_PRACTICE_STACK: PRACTICE_STACK
				};
		this.#web = new Child(
			'the Node server',
			`${this.url}/healthz`,
			process.execPath,
			['build/start.js'],
			WEB,
			{
				...process.env,
				HOST: '127.0.0.1',
				PORT: String(port),
				ORIGIN: this.url,
				...tables
			}
		);
	}

	async start(): Promise<void> {
		await this.#tables?.start();
		await this.#web.start();
	}

	async stop(): Promise<void> {
		await this.#web.stop();
		await this.#tables?.stop();
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	async dispose(): Promise<void> {
		await this.stop();
	}
}
