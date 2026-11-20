/**
 * Apply the Drizzle migrations in `web/drizzle/` (P4B.3).
 *
 * On ubuntu-vm the migration login role (`rivermind_poker_migration`) has no
 * rights of its own; it switches to the owner with `SET ROLE` from
 * `RIVERMIND_MIGRATION_ROLE`, as Alembic's environment does, so every object
 * is created as the owner (`deploy/setup-database.sh`).
 *
 * The first migration, `0000_baseline`, creates exactly the schema of
 * Alembic head {@link ALEMBIC_HEAD}. A database that Alembic has already
 * migrated there, such as the live one, is adopted instead: the baseline is
 * recorded as applied without running it, and no row or table changes. Any
 * later migration then runs as usual.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** The Alembic revision whose schema the baseline migration reproduces. */
export const ALEMBIC_HEAD = '0006';

/** Where Drizzle records applied migrations (its defaults). */
export const JOURNAL_SCHEMA = 'drizzle';
export const JOURNAL_TABLE = '__drizzle_migrations';

/** The migrations committed with the app. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../../drizzle', import.meta.url));

/** Held while migrating, so two deploys cannot migrate at once ("RMdb"). */
const ADVISORY_LOCK = 0x524d6462;

const ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

export interface MigrateOptions {
	/** The role to `SET ROLE` to first, such as the owner on ubuntu-vm. */
	role?: string;
	/** The migrations folder; {@link MIGRATIONS_FOLDER} by default. */
	folder?: string;
}

export interface MigrateResult {
	/** True when an Alembic-migrated database was adopted by recording the baseline. */
	adopted: boolean;
	/** The tags of the migrations that ran, oldest first. */
	applied: string[];
}

interface JournalEntry {
	tag: string;
	when: number;
}

function journalEntries(folder: string): JournalEntry[] {
	const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
		entries: JournalEntry[];
	};
	return journal.entries;
}

/** The newest `created_at` in Drizzle's journal, or null when nothing is recorded. */
async function lastApplied(client: pg.Client): Promise<number | null> {
	const table = await client.query<{ t: string | null }>('SELECT to_regclass($1) AS t', [
		`${JOURNAL_SCHEMA}.${JOURNAL_TABLE}`
	]);
	if (table.rows[0].t === null) return null;
	const result = await client.query<{ last: string | null }>(
		`SELECT max(created_at) AS last FROM "${JOURNAL_SCHEMA}"."${JOURNAL_TABLE}"`
	);
	const last = result.rows[0].last;
	return last === null ? null : Number(last);
}

/**
 * Record the baseline as applied on a database that Alembic migrated to
 * {@link ALEMBIC_HEAD} and Drizzle has never touched. Returns whether it did.
 */
async function adoptAlembicSchema(client: pg.Client, folder: string): Promise<boolean> {
	const alembic = await client.query<{ t: string | null }>(
		"SELECT to_regclass('alembic_version') AS t"
	);
	if (alembic.rows[0].t === null) return false;
	if ((await lastApplied(client)) !== null) return false;

	const versions = await client.query<{ version_num: string }>(
		'SELECT version_num FROM alembic_version'
	);
	const found = versions.rows.map((row) => row.version_num);
	if (found.length !== 1 || found[0] !== ALEMBIC_HEAD) {
		throw new Error(
			`Alembic is at ${found.join(', ') || 'no revision'}, not ${ALEMBIC_HEAD}: ` +
				`run alembic upgrade ${ALEMBIC_HEAD} first, or add a Drizzle migration for the newer revisions`
		);
	}
	const [baseline] = readMigrationFiles({ migrationsFolder: folder });
	await client.query('BEGIN');
	try {
		// The same journal table Drizzle's migrator creates.
		await client.query(`CREATE SCHEMA IF NOT EXISTS "${JOURNAL_SCHEMA}"`);
		await client.query(
			`CREATE TABLE IF NOT EXISTS "${JOURNAL_SCHEMA}"."${JOURNAL_TABLE}" ` +
				'(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)'
		);
		await client.query(
			`INSERT INTO "${JOURNAL_SCHEMA}"."${JOURNAL_TABLE}" (hash, created_at) VALUES ($1, $2)`,
			[baseline.hash, baseline.folderMillis]
		);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	}
	return true;
}

/** Bring the database at `url` up to the newest migration. */
export async function migrate(url: string, options: MigrateOptions = {}): Promise<MigrateResult> {
	const folder = options.folder ?? MIGRATIONS_FOLDER;
	const client = new pg.Client({ connectionString: url, application_name: 'rivermind-migrate' });
	await client.connect();
	try {
		if (options.role) {
			if (!ROLE_NAME.test(options.role)) {
				throw new Error(`bad RIVERMIND_MIGRATION_ROLE: ${JSON.stringify(options.role)}`);
			}
			await client.query(`SET ROLE "${options.role}"`);
		}
		await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK]);
		try {
			const adopted = await adoptAlembicSchema(client, folder);
			const before = await lastApplied(client);
			await drizzleMigrate(drizzle({ client }), {
				migrationsFolder: folder,
				migrationsSchema: JOURNAL_SCHEMA,
				migrationsTable: JOURNAL_TABLE
			});
			const applied = journalEntries(folder)
				.filter((entry) => before === null || entry.when > before)
				.map((entry) => entry.tag);
			return { adopted, applied };
		} finally {
			await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK]);
		}
	} finally {
		await client.end();
	}
}
