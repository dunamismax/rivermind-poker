// The moderator's commands on PostgreSQL (P4.5, P4B.8a), run as a moderator
// runs them: `node scripts/moderation.ts` with DATABASE_URL, reading what the
// site's own stores wrote.
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { resetDatabase, testDatabaseUrl } from '../db/testing.ts';
import { USAGE, when } from './moderation.ts';
import { DatabasePlayers } from './players.ts';
import { DatabaseSafety, handleAllowed, suspendIfDue } from './safety.ts';

const url = testDatabaseUrl();
const SCRIPT = resolve(import.meta.dirname, '../../../../scripts/moderation.ts');

/** Run the script, and return how it exited and what it printed. */
function run(
	args: string[],
	databaseUrl: string | undefined
): Promise<{ code: number; out: string; err: string }> {
	const env = { ...process.env, DATABASE_URL: databaseUrl ?? '' };
	return new Promise((done) => {
		execFile(process.execPath, [SCRIPT, ...args], { env }, (error, out, err) => {
			done({ code: error ? Number(error.code ?? 1) : 0, out, err });
		});
	});
}

describe.skipIf(!url)('moderation on PostgreSQL', () => {
	const database = url as string;
	let pool: ReturnType<typeof createPool>;
	let db: Database;

	beforeAll(async () => {
		await resetDatabase(database);
		await migrate(database);
		pool = createPool(database, { max: 4 });
		db = createDatabase(pool);
	});

	afterAll(async () => {
		await pool?.end();
	});

	beforeEach(async () => {
		await db.execute(
			sql`TRUNCATE players, ledger_entries, player_reports, player_relations, safety_signals, voice_suspensions CASCADE`
		);
	});

	it('lists the reports and signals the site stored, and renames a player', async () => {
		const players = new DatabasePlayers(db);
		const safety = new DatabaseSafety(db);
		const [alice, bob] = [await players.create(), await players.create()];
		await safety.report({
			reporterId: alice.playerId,
			targetId: bob.playerId,
			targetHandle: bob.handle,
			reason: 'collusion',
			tableId: null,
			handNo: null,
			at: 1_700_000_000
		});
		await safety.signal({
			kind: 'same_address',
			tableId: null,
			playerIds: [alice.playerId, bob.playerId],
			detail: { address: 'a1b2c3' },
			at: 1_700_000_060
		});

		const reports = await run(['reports'], database);
		expect(reports).toMatchObject({ code: 0, err: '' });
		expect(reports.out).toBe(
			`${when(1_700_000_000)}  collusion  ${bob.handle} (${bob.playerId})  by ${alice.handle} (${alice.playerId})\n`
		);

		const signals = await run(['signals', '--limit', '5'], database);
		expect(signals).toMatchObject({ code: 0, err: '' });
		expect(signals.out).toContain(`${when(1_700_000_060)}  same_address  table -  `);
		expect(signals.out).toContain(alice.playerId);
		expect(signals.out).toContain(bob.playerId);
		expect(signals.out).toContain('{"address":"a1b2c3"}');

		const renamed = await run(['rename', bob.playerId], database);
		expect(renamed).toMatchObject({ code: 0, err: '' });
		const after = await players.get(bob.playerId);
		expect(after!.handle).not.toBe(bob.handle);
		expect(handleAllowed(after!.handle)).toBe(true);
		expect(renamed.out).toBe(`${bob.playerId}: ${bob.handle} -> ${after!.handle}\n`);
		// The report keeps the handle the player had when it was made.
		expect((await run(['reports'], database)).out).toContain(`${bob.handle} (${bob.playerId})`);
	}, 60_000);

	it('keeps voice reports with an address hash, suspends speaking, and lists and lifts it (P4C.8)', async () => {
		const players = new DatabasePlayers(db);
		const safety = new DatabaseSafety(db);
		const target = await players.create();
		const reporters = [await players.create(), await players.create(), await players.create()];
		const now = Date.now() / 1000;
		for (const [index, reporter] of reporters.entries()) {
			expect(
				await safety.report({
					reporterId: reporter.playerId,
					targetId: target.playerId,
					targetHandle: target.handle,
					reason: 'voice',
					tableId: `table-${index}`,
					handNo: null,
					at: now - 60 + index,
					reporterAddress: `${index}`.repeat(24)
				})
			).toBe(true);
		}
		// An abuse report and an old voice report are not among them.
		await safety.report({
			reporterId: reporters[0].playerId,
			targetId: target.playerId,
			targetHandle: target.handle,
			reason: 'abuse',
			tableId: 'table-0',
			handNo: null,
			at: now - 30
		});
		const recent = await safety.voiceReportsAgainst(target.playerId, now - 3600);
		expect(recent.map((one) => [one.tableId, one.reporterAddress])).toEqual([
			['table-0', '0'.repeat(24)],
			['table-1', '1'.repeat(24)],
			['table-2', '2'.repeat(24)]
		]);
		expect(await safety.voiceReportsAgainst(target.playerId, now)).toEqual([]);

		expect(await safety.speakingSuspendedUntil(target.playerId, now)).toBeNull();
		const until = await suspendIfDue(safety, target.playerId, now);
		expect(until).toBe(now + 24 * 3600);
		expect(await safety.speakingSuspendedUntil(target.playerId, now)).toBeCloseTo(until!, 3);
		// A shorter one never shortens it.
		await safety.suspendSpeaking(target.playerId, now + 60);
		expect(await safety.speakingSuspendedUntil(target.playerId, now)).toBeCloseTo(until!, 3);
		expect(await safety.speakingSuspendedUntil(target.playerId, until! + 1)).toBeNull();

		const listed = await run(['suspensions'], database);
		expect(listed).toMatchObject({ code: 0, err: '' });
		expect(listed.out).toBe(`until ${when(until!)}  ${target.handle} (${target.playerId})\n`);
		const lifted = await run(['lift', target.playerId], database);
		expect(lifted).toMatchObject({
			code: 0,
			out: `${target.playerId} may speak in voice again.\n`
		});
		expect(await safety.speakingSuspendedUntil(target.playerId, now)).toBeNull();
		expect((await run(['lift', target.playerId], database)).code).toBe(1);
		expect((await run(['reports'], database)).out).toContain(`voice      ${target.handle}`);
	}, 60_000);

	it('says what went wrong, and exits non-zero', async () => {
		const missing = await run(['rename', 'p_nobody'], database);
		expect(missing).toMatchObject({ code: 1, out: '', err: 'No player p_nobody.\n' });
		const unknown = await run(['purge'], database);
		expect(unknown).toMatchObject({ code: 2, out: '', err: `${USAGE}\n` });
		const bare = await run([], database);
		expect(bare).toMatchObject({ code: 2, out: `${USAGE}\n` });
		const help = await run(['--help'], undefined);
		expect(help).toMatchObject({ code: 0, out: `${USAGE}\n` });
		const noDatabase = await run(['reports'], undefined);
		expect(noDatabase.code).toBe(1);
		expect(noDatabase.err).toContain('DATABASE_URL');
	}, 60_000);
});
