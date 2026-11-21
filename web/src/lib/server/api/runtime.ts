/**
 * The {@link Site} and API handler of a running Node server, made from its
 * environment (P4B.5a).
 *
 * Environment, as `serve-nl` reads its options:
 *   RIVERMIND_SECRET           the secret that signs session cookies, or
 *   RIVERMIND_SECRET_FILE      a file holding it, made (0600) if missing. The
 *                              live server's is /var/lib/rivermind-poker/secret;
 *                              without either, sessions last until a restart.
 *   DATABASE_URL               PostgreSQL for players, wallets, safety and hands;
 *                              without one they live in memory.
 *   RIVERMIND_ALLOWED_ORIGINS  other origins whose pages may use the API, comma-separated.
 *   RIVERMIND_PRACTICE_STACK   the chips a practice table gives (10,000).
 *
 * With `RIVERMIND_API=1`, `server/index.ts` makes one at start-up and serves
 * its API ahead of SvelteKit's handler; the table server's sockets (P4B.5b) will share it.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createDatabase, createPool } from '../db/index.ts';
import { createApi, type ApiHandler } from './api.ts';
import type { Secret } from './auth.ts';
import { Site } from './site.ts';

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
	api: ApiHandler;
	/** Close the database pool, if any. */
	close(): Promise<void>;
}

export function createRuntime(env: Env = process.env): Runtime {
	let secret = loadSecret(env);
	if (!secret) {
		console.warn('No secret given: sessions will not survive a restart');
		secret = randomBytes(32);
	}
	const url = env.DATABASE_URL;
	const pool = url ? createPool(url) : null;
	if (!pool) console.warn('No DATABASE_URL: players and wallets will not survive a restart');
	const stack = env.RIVERMIND_PRACTICE_STACK;
	const site = new Site({
		secret,
		db: pool ? createDatabase(pool) : null,
		practiceStack: stack ? Number(stack) : undefined
	});
	const allowedOrigins = (env.RIVERMIND_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
	return { site, api: createApi(site, { allowedOrigins }), close: async () => pool?.end() };
}
