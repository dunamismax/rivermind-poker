/**
 * The {@link Site}, the tables, the API handler and the socket server of a
 * running Node server, made from its environment (P4B.5a, P4B.5b).
 *
 * Environment, as `serve-nl` reads its options:
 *   RIVERMIND_SECRET           the secret that signs session cookies, or
 *   RIVERMIND_SECRET_FILE      a file holding it, made (0600) if missing. The
 *                              live server's is /var/lib/rivermind-poker/secret;
 *                              without either, sessions last until a restart.
 *   DATABASE_URL               PostgreSQL for players, wallets, safety, hands and
 *                              the tables themselves, which are then restored at
 *                              start-up; without one everything lives in memory.
 *   RIVERMIND_ALLOWED_ORIGINS  other origins whose pages may use the API, comma-separated.
 *   RIVERMIND_PRACTICE_STACK   the chips a practice table gives (10,000).
 *   RIVERMIND_HAND_PAUSE       seconds between hands (3).
 *   RIVERMIND_BOT_DELAY        seconds a bot waits before acting (0.6).
 *   RIVERMIND_MAX_TABLES       the most tables open at once (200).
 *
 * With `RIVERMIND_API=1`, `server/index.ts` makes one at start-up, restores
 * the saved tables and serves the API ahead of SvelteKit's handler and the
 * sockets on `/ws`.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createDatabase, createPool } from '../db/index.ts';
import type { RunnerOptions } from '../table/runner.ts';
import { TableStore } from '../table/store.ts';
import { createApi, type ApiHandler } from './api.ts';
import type { Secret } from './auth.ts';
import { Site } from './site.ts';
import { createSocketServer, type SocketServer } from './socket.ts';
import { Tables } from './tables.ts';

export const SECRET_ENV = 'RIVERMIND_SECRET';
export const SECRET_FILE_ENV = 'RIVERMIND_SECRET_FILE';

type Env = Record<string, string | undefined>;

/** The session secret from `RIVERMIND_SECRET` or a file, made if missing, as `serve-nl` loads it. */
export function loadSecret(env: Env = process.env): Secret | null {
	const value = env[SECRET_ENV];
	if (value) return Buffer.from(value, 'utf8');
	const file = env[SECRET_FILE_ENV];
	if (!file) return null;
	if (!existsSync(file)) {
		mkdirSync(dirname(file), { recursive: true });
		try {
			const fd = openSync(file, 'wx', 0o600);
			writeSync(fd, randomBytes(32).toString('hex') + '\n');
			closeSync(fd);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
	}
	return Buffer.from(readFileSync(file, 'utf8').trim(), 'utf8');
}

export interface Runtime {
	site: Site;
	tables: Tables;
	api: ApiHandler;
	sockets: SocketServer;
	/** Restore the saved tables. Call before serving. */
	start(): Promise<void>;
	/** Stop the tables, letting changes in flight finish, and close the database pool, if any. */
	close(): Promise<void>;
}

/** A setting that must be a number no smaller than `least`, or missing. */
function numberFrom(env: Env, name: string, least: number): number | undefined {
	const text = env[name];
	if (text === undefined || text === '') return undefined;
	const value = Number(text);
	if (!Number.isFinite(value) || value < least) {
		throw new RangeError(`${name} must be a number of at least ${least}, not ${text}`);
	}
	return value;
}

export function createRuntime(env: Env = process.env): Runtime {
	let secret = loadSecret(env);
	if (!secret) {
		console.warn('No secret given: sessions will not survive a restart');
		secret = randomBytes(32);
	}
	const url = env.DATABASE_URL;
	const pool = url ? createPool(url) : null;
	if (!pool)
		console.warn('No DATABASE_URL: players, wallets and tables will not survive a restart');
	const db = pool ? createDatabase(pool) : null;
	const site = new Site({
		secret,
		db,
		practiceStack: numberFrom(env, 'RIVERMIND_PRACTICE_STACK', 1)
	});
	const runner: Partial<RunnerOptions> = {};
	const handPause = numberFrom(env, 'RIVERMIND_HAND_PAUSE', 0);
	const botDelay = numberFrom(env, 'RIVERMIND_BOT_DELAY', 0);
	if (handPause !== undefined) runner.handPause = handPause;
	if (botDelay !== undefined) runner.botDelay = botDelay;
	const tables = new Tables(site, {
		runner,
		maxTables: numberFrom(env, 'RIVERMIND_MAX_TABLES', 1),
		store: db ? new TableStore(db) : null
	});
	const allowedOrigins = (env.RIVERMIND_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
	return {
		site,
		tables,
		api: createApi(site, { allowedOrigins, tables }),
		sockets: createSocketServer(tables, { allowedOrigins }),
		start: () => tables.start(),
		close: async () => {
			await tables.stop();
			await pool?.end();
		}
	};
}
