// A deploy restarts the table server, never the voice service (P4C.5): the
// people in a table's voice room stay in it while one table server stops and
// the next restores the table from PostgreSQL, and the new one's tokens and
// seat lists work as the old one's did.
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { resetDatabase, testDatabaseUrl } from '../db/testing.ts';
import { TableStore } from '../table/store.ts';
import { Player, SECRET, TestServer, quietLog } from '../api/tables.testing.ts';
import { Voice } from '../api/voice.ts';
import { CLOSE, type ServerMessage } from '../../voice/signalling.ts';
import { Media } from './media.ts';
import { VoiceService } from './service.ts';
import { voiceKey } from './tokens.ts';

const url = testDatabaseUrl();

describe.skipIf(!url)('table voice across a restart of the table server', () => {
	let pool: ReturnType<typeof createPool>;
	let db: Database;
	let media: Media;

	beforeAll(async () => {
		await resetDatabase(url as string);
		await migrate(url as string);
		pool = createPool(url as string, { max: 8 });
		db = createDatabase(pool);
		await db.execute(
			sql`TRUNCATE players, ledger_entries, player_reports, player_relations, safety_signals, poker_tables RESTART IDENTITY CASCADE`
		);
		media = await Media.start({
			listenIps: ['127.0.0.1'],
			port: 0,
			announced: null,
			log: () => {}
		});
	});

	afterAll(async () => {
		media?.close();
		await pool?.end();
	});

	it('keeps everyone in voice, and the next table server takes over', async () => {
		const voice = new VoiceService({ key: voiceKey(SECRET), media, log: () => {} });
		const lists: number[] = [];
		const serve = async () => {
			let server: TestServer | null = null;
			const tableVoice = new Voice({
				secret: SECRET,
				link: {
					send: async (list) => {
						lists.push(list.seats.length);
						await voice.seats(list);
					}
				},
				blocksOf: (playerId) => server!.site.safety.blocksInvolving(playerId),
				now: () => Date.now() / 1000,
				log: quietLog()
			});
			server = await new TestServer({
				site: { db },
				store: new TableStore(db),
				tables: { voice: tableVoice }
			}).start();
			return { server, tableVoice };
		};

		// One socket in the voice room, as a page would hold it.
		const page = (token: string, table: string) => {
			const sent: ServerMessage[] = [];
			let closed: number | null = null;
			const session = voice.open({
				send: (text) => void sent.push(JSON.parse(text) as ServerMessage),
				close: (code) => {
					closed = code;
					session.closed();
				}
			});
			session.receive(JSON.stringify({ id: 1, type: 'hello', v: 1, table, token }));
			return { sent, closed: () => closed, session };
		};
		const token = async (player: Player, tableId: string) => {
			const response = await player.request('POST', `/api/tables/${tableId}/voice`);
			expect(response.status).toBe(200);
			return ((await response.json()) as { token: string }).token;
		};
		const welcomed = async (one: ReturnType<typeof page>) => {
			await expect.poll(() => one.sent.some((m) => 'id' in m && m.id === 1 && m.ok)).toBe(true);
		};

		const first = await serve();
		const players = [
			await Player.create(first.server),
			await Player.create(first.server),
			await Player.create(first.server)
		];
		const tableId = await players[0].newTable(3, null);
		for (const seat of [1, 2]) {
			const response = await players[seat].request('POST', `/api/tables/${tableId}/seat`, { seat });
			expect(response.status).toBe(200);
		}
		await first.server.settle();
		const pages = [];
		for (const player of players) {
			const one = page(await token(player, tableId), tableId);
			await welcomed(one);
			pages.push(one);
		}
		expect(voice.counts).toEqual({ rooms: 1, people: 3 });

		// The table server stops, as a deploy stops it: it sends no list.
		const sent = lists.length;
		await first.server.stop();
		await first.tableVoice.settled();
		expect(lists).toHaveLength(sent);
		expect(pages.map((one) => one.closed())).toEqual([null, null, null]);

		// The next one restores the table, and voice carries on as it was.
		const second = await serve();
		const again = players.map((player) => Player.from(second.server, player));
		expect(second.server.runner(tableId).table.people()).toBe(3);
		expect(voice.counts).toEqual({ rooms: 1, people: 3 });
		// Its tokens are good: a page that reloads comes back in its own seat.
		const back = page(await token(again[1], tableId), tableId);
		await welcomed(back);
		expect(pages[1].closed()).toBe(CLOSE.replaced);
		// Its seat lists are newer than the old server's: someone who stands up now is taken out.
		await second.server.runner(tableId).leave(players[2].playerId);
		await second.server.settle();
		await second.tableVoice.settled();
		expect(lists.at(-1)).toBe(2);
		expect(pages[2].closed()).toBe(CLOSE.unseated);
		expect(pages[0].closed()).toBeNull();
		expect(voice.counts).toEqual({ rooms: 1, people: 2 });
		back.session.closed();
		pages[0].session.closed();
		await second.server.stop();
	});
});
