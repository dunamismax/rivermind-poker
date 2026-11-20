/**
 * The disposable database for Vitest's database tests (`*.db.spec.ts`).
 *
 * Tests read `RIVERMIND_TEST_DATABASE_URL`, as the Python suite does, and
 * drop its `public` and `drizzle` schemas, so the database's name must
 * contain `test`. Without the variable the tests are skipped locally, but
 * in CI (`CI` set) they fail instead, so they can never be skipped silently.
 */
import pg from 'pg';

export const TEST_DATABASE_ENV = 'RIVERMIND_TEST_DATABASE_URL';

/** The database name in a `postgresql://` URL. */
export function databaseName(url: string): string {
	return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** `url`, unless its database name lacks `test`. */
export function checkTestDatabaseUrl(url: string): string {
	const name = databaseName(url);
	if (!name.includes('test')) {
		throw new Error(
			`refusing to reset database ${JSON.stringify(name)}: its name must contain 'test'`
		);
	}
	return url;
}

/** The test database URL, or undefined to skip the database tests. */
export function testDatabaseUrl(
	env: Record<string, string | undefined> = process.env
): string | undefined {
	const url = env[TEST_DATABASE_ENV];
	if (!url) {
		if (env.CI) throw new Error(`${TEST_DATABASE_ENV} must be set in CI`);
		return undefined;
	}
	return checkTestDatabaseUrl(url);
}

/** Run `sql` on a fresh connection to `url`. */
export async function execute(
	url: string,
	sql: string,
	values: unknown[] = []
): Promise<pg.QueryResult> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		return await client.query(sql, values);
	} finally {
		await client.end();
	}
}

/** Empty the test database: a new `public` schema and no Drizzle journal. */
export async function resetDatabase(url: string): Promise<void> {
	await execute(
		checkTestDatabaseUrl(url),
		'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public'
	);
}
