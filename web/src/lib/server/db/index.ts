/**
 * Connections to the site database through node-postgres (D-4, P4B.3).
 *
 * Kept free of `$lib` imports, so the migration script and other Node
 * scripts can import it directly.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export { schema };

/**
 * Connections per process. Each idle connection costs PostgreSQL a backend
 * of a few megabytes, and the table server's requests are short, so ten is
 * plenty for one Node process inside its 2 GB unit and leaves the host's
 * other sites their share of `max_connections`.
 */
export const POOL_SIZE = 10;

export interface PoolOptions {
	/** The most connections open at once; {@link POOL_SIZE} by default. */
	max?: number;
}

/** A connection pool for a `postgresql://` URL such as `DATABASE_URL`. */
export function createPool(url: string, options: PoolOptions = {}): pg.Pool {
	return new pg.Pool({
		connectionString: url,
		max: options.max ?? POOL_SIZE,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 5_000,
		application_name: 'rivermind-poker-web'
	});
}

/** A Drizzle database over a pool or a single client. */
export function createDatabase(client: pg.Pool | pg.Client) {
	return drizzle({ client, schema });
}

export type Database = ReturnType<typeof createDatabase>;

/** `DATABASE_URL`, or an error that says how to set it. */
export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
	const url = env.DATABASE_URL;
	if (!url) {
		throw new Error(
			'set DATABASE_URL to a PostgreSQL URL, such as postgresql://localhost/rivermind'
		);
	}
	return url;
}
