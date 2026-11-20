import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` writes a migration for each change to the schema.
// Nothing here connects to a database: `pnpm db:migrate` applies migrations.
export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	strict: true,
	verbose: true
});
