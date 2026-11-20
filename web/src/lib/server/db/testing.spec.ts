import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from './migrate.ts';
import { checkTestDatabaseUrl, databaseName, testDatabaseUrl } from './testing.ts';

describe('the test database', () => {
	it('must have test in its name', () => {
		expect(checkTestDatabaseUrl('postgresql://localhost/rivermind_test')).toBe(
			'postgresql://localhost/rivermind_test'
		);
		expect(() => checkTestDatabaseUrl('postgresql://u:p@localhost:5432/rivermind_poker')).toThrow(
			/refusing to reset database "rivermind_poker"/
		);
		expect(
			databaseName('postgresql://u:p@127.0.0.1:5432/rivermind_poker_test?sslmode=disable')
		).toBe('rivermind_poker_test');
	});

	it('is skipped locally without the variable but required in CI', () => {
		expect(testDatabaseUrl({})).toBeUndefined();
		expect(() => testDatabaseUrl({ CI: 'true' })).toThrow(/must be set in CI/);
		expect(() =>
			testDatabaseUrl({ RIVERMIND_TEST_DATABASE_URL: 'postgresql://localhost/rivermind' })
		).toThrow(/must contain 'test'/);
	});
});

describe('the migrations', () => {
	const journal = JSON.parse(
		readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')
	) as { entries: { tag: string; when: number }[] };

	it('start from the baseline and have a file for every journal entry', () => {
		const tags = journal.entries.map((entry) => entry.tag);
		expect(tags[0]).toBe('0000_baseline');
		const files = readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith('.sql'));
		expect(files.sort()).toEqual(tags.map((tag) => `${tag}.sql`).sort());
		const whens = journal.entries.map((entry) => entry.when);
		expect(whens).toEqual([...whens].sort((a, b) => a - b));
	});

	it('never name a schema, so the tables follow search_path into app on ubuntu-vm', () => {
		for (const entry of journal.entries) {
			const sql = readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8');
			expect(sql, entry.tag).not.toMatch(/"public"\./);
		}
	});
});
