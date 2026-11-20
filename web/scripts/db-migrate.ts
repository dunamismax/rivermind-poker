// Apply the Drizzle migrations in web/drizzle/ to DATABASE_URL (P4B.3).
// With RIVERMIND_MIGRATION_ROLE set, it first switches to that role with
// SET ROLE, as the deploy does on ubuntu-vm with migration.env. A database
// that Alembic migrated to 0006 is adopted without changing it.
//
//   DATABASE_URL=postgresql://localhost/rivermind pnpm db:migrate

import { databaseUrl } from '../src/lib/server/db/index.ts';
import { migrate } from '../src/lib/server/db/migrate.ts';

try {
	const result = await migrate(databaseUrl(), {
		role: process.env.RIVERMIND_MIGRATION_ROLE || undefined
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
