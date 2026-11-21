// Apply the Drizzle migrations in drizzle/ to DATABASE_URL (P4B.3). With
// DB_OWNER_ROLE (or the older RIVERMIND_MIGRATION_ROLE) set, it first switches
// to that role with SET ROLE, as the deploy does on ubuntu-vm with
// /etc/web-apps/rivermind_poker/migration.env. A database that Alembic migrated
// to 0006 is adopted without changing it. Exits non-zero on any failure.
//
//   DATABASE_URL=postgresql://localhost/rivermind pnpm db:migrate
//
// `pnpm build` also bundles it as build/migrate.js, which plain Node runs from
// a release with no node_modules: `node build/migrate.js` reads the release's
// drizzle/ beside build/, as it reads web/drizzle/ from scripts/.

import { resolve } from 'node:path';
import { databaseUrl } from '../src/lib/server/db/index.ts';
import { migrate } from '../src/lib/server/db/migrate.ts';

try {
	const result = await migrate(databaseUrl(), {
		role: process.env.DB_OWNER_ROLE || process.env.RIVERMIND_MIGRATION_ROLE || undefined,
		folder: resolve(import.meta.dirname, '..', 'drizzle')
	});
	if (result.adopted) {
		console.log('Adopted the Alembic schema: recorded 0000_baseline as applied, changed nothing.');
	}
	console.log(
		result.applied.length ? `Applied ${result.applied.join(', ')}.` : 'The database is up to date.'
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
