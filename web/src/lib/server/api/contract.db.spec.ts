// The HTTP contract recorded from serve-nl, against the TypeScript API on
// PostgreSQL (P4B.5a): the Drizzle stores answer every request as the
// Python server's memory stores did. Hands are written as serve-nl's
// TableStore writes them, so this also reads Python-shaped hand rows.
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createDatabase, createPool, type Database } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { handHistories, handPlayers, hands, pokerTables } from '../db/schema.ts';
import { resetDatabase, testDatabaseUrl } from '../db/testing.ts';
import type { JsonObject } from '../engine/history.ts';
import { createApi, type ApiHandler } from './api.ts';
import { checkCase, contract, contractHands } from './contract.testing.ts';
import { seatRecords } from './hands.ts';
import { UNLIMITED } from './safety.ts';
import { Site } from './site.ts';

const url = testDatabaseUrl();

/** Write a finished hand as `TableStore.save` does: the table, the hand, its record and its seats. */
async function storeHand(db: Database, hand: ReturnType<typeof contractHands>[number]) {
	const { state } = hand.finished;
	const when = sql`to_timestamp(${contract.now})`;
	await db
		.insert(pokerTables)
		.values({
			id: hand.table_id,
			name: hand.table_name,
			seatCount: state.startingStacks.length,
			smallBlind: state.config.smallBlind,
			bigBlind: state.config.bigBlind,
			minBuyIn: 20 * state.config.bigBlind,
			maxBuyIn: 100 * state.config.bigBlind,
			practice: hand.practice
		})
		.onConflictDoNothing();
	const [{ id }] = await db
		.insert(hands)
		.values({
			tableId: hand.table_id,
			handNo: hand.hand_no,
			button: state.button,
			startedAt: when as never,
			endedAt: when as never
		})
		.returning({ id: hands.id });
	await db
		.insert(handHistories)
		.values({ handId: id, format: 1, record: hand.record as JsonObject });
	await db.insert(handPlayers).values(
		seatRecords(hand.finished).map((s) => ({
			handId: id,
			seatNo: s.seat,
			playerId: s.playerId,
			displayName: s.name,
			botKind: s.bot,
			net: s.net
		}))
	);
}

/** The database stamps ledger entries with its own clock, so their times are left out. */
function withoutLedgerTimes(body: unknown): unknown {
	const parsed = JSON.parse(body as string) as { entries?: { at?: number }[] };
	for (const entry of parsed.entries ?? []) delete entry.at;
	return parsed;
}

describe.skipIf(!url)('the HTTP contract recorded from serve-nl, on PostgreSQL', () => {
	const database = url as string;
	let pool: ReturnType<typeof createPool>;
	let api: ApiHandler;

	beforeAll(async () => {
		await resetDatabase(database);
		await migrate(database);
		pool = createPool(database, { max: 4 });
		const db = createDatabase(pool);
		const site = new Site({
			secret: Buffer.from(contract.secret),
			db,
			limits: UNLIMITED,
			clock: () => contract.now
		});
		for (const id of contract.players) await site.players.claim(id);
		for (const hand of contractHands()) await storeHand(db, hand);
		api = createApi(site);
	});

	afterAll(async () => {
		await pool?.end();
	});

	for (const c of contract.cases) {
		it(c.name, () => checkCase(api, c, c.name === 'wallet' ? withoutLedgerTimes : undefined));
	}
});
