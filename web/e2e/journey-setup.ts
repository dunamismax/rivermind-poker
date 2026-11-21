import { migrate } from '../src/lib/server/db/migrate.ts';
import { resetDatabase, testDatabaseUrl } from '../src/lib/server/db/testing.ts';
import { TableServer } from './server.ts';

/** Where the journey tests find their server; unset when there is no test database. */
export const JOURNEY_URL_ENV = 'E2E_JOURNEY_URL';
const PORT = Number(process.env.E2E_JOURNEY_PORT ?? 8790);

// The player journey (P5.9) runs against the real Node server on a disposable
// PostgreSQL database: RIVERMIND_TEST_DATABASE_URL, the one Vitest's database
// tests use, emptied and migrated here. One server serves every browser
// project, as one serves every guest on the live site; two servers on one
// database would each restore and run the other's tables. Without the
// variable the journey is skipped locally; in CI it must be set.
//
// It runs after global-setup.ts, which builds the server and writes its champion.
export default async function journeySetup() {
	const url = testDatabaseUrl();
	if (!url) return;
	await resetDatabase(url);
	await migrate(url);
	const server = new TableServer(PORT, { databaseUrl: url });
	await server.start();
	process.env[JOURNEY_URL_ENV] = server.url;
	return () => server.dispose();
}
