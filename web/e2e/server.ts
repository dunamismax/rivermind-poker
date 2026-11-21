// Runs the site as the browser tests see it: the built Node server
// (`node build/start.js`) serving the pages, the API and the tables itself
// (P4B.5b), as the live site does. Tables live in memory; their durability is
// tested in Vitest against PostgreSQL. The one server the journey tests share
// (e2e/journey-setup.ts) keeps everything in the disposable test database.

import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WEB = resolve(import.meta.dirname, '..');

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

/**
 * The models directory global-setup fills with a small test champion, which the
 * Node server offers as RiverMind Hard (P5.7a).
 */
export const MODELS = join(
	tmpdir(),
	`rivermind-e2e-models-${process.env.E2E_MODELS_TAG ?? 'default'}`
);

// Quick bots and hands, so the tests play many of them, and a short practice
// stack, so a guest who calls every bet runs out within a minute or two.
const HAND_PAUSE = '0.4';
const BOT_DELAY = '0.05';
const PRACTICE_STACK = '300';

export class TableServer {
	/** The site's origin: the Node server. */
	readonly url: string;
	readonly #web: Child;

	/**
	 * @param databaseUrl A disposable, migrated database for the server to keep its players,
	 *   wallets, tables and hands in (the P5.9 journey). Without one, everything lives in memory.
	 */
	constructor(
		readonly port: number,
		{ databaseUrl = '' }: { databaseUrl?: string } = {}
	) {
		this.url = `http://127.0.0.1:${port}`;
		// Never a developer's database: only one a test names, and otherwise memory.
		const tables: NodeJS.ProcessEnv = {
			RIVERMIND_API: '1',
			DATABASE_URL: databaseUrl,
			RIVERMIND_HAND_PAUSE: HAND_PAUSE,
			RIVERMIND_BOT_DELAY: BOT_DELAY,
			RIVERMIND_PRACTICE_STACK: PRACTICE_STACK,
			RIVERMIND_MODELS: MODELS,
			RIVERMIND_CHAMPIONS: join(MODELS, 'champions.json')
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
		await this.#web.start();
	}

	async stop(): Promise<void> {
		await this.#web.stop();
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	async dispose(): Promise<void> {
		await this.stop();
	}
}
