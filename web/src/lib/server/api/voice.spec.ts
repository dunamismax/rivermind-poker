// Table voice from the table server's side (P4C.5): who gets a voice token,
// and the seat lists the voice service hears as people sit down, go bust,
// leave, block each other and tables close, on the whole table server with a
// manual clock.
import { afterEach, describe, expect, it } from 'vitest';
import { publicRef } from './auth.ts';
import { Player, SECRET, TestServer, quietLog } from './tables.testing.ts';
import { Voice } from './voice.ts';
import type { SeatList } from '../voice/seats.ts';
import { readToken, voiceKey } from '../voice/tokens.ts';
import { Action, legalActions } from '../engine/state.ts';
import type { TableRunner } from '../table/runner.ts';
import type { VoiceTokenResponse } from '../../voice/signalling.ts';

const NOW = 1_800_000_000;
let servers: TestServer[] = [];
afterEach(async () => {
	for (const server of servers) await server.stop();
	servers = [];
});

// A table server whose voice service is a list of what it was sent.
async function voiced(
	voiceOffered = false
): Promise<{ server: TestServer; voice: Voice; lists: SeatList[] }> {
	const lists: SeatList[] = [];
	let server: TestServer | null = null;
	const voice = new Voice({
		secret: SECRET,
		link: { send: async (list) => void lists.push(list) },
		blocksOf: (playerId) => server!.site.safety.blocksInvolving(playerId),
		now: () => NOW,
		log: quietLog()
	});
	server = await new TestServer({ tables: { voice }, voiceOffered }).start();
	servers.push(server);
	return { server, voice, lists };
}

async function sit(player: Player, tableId: string, seat: number): Promise<void> {
	const response = await player.request('POST', `/api/tables/${tableId}/seat`, { seat });
	expect(response.status, await response.text()).toBe(200);
}

const ask = (player: Player, tableId: string) =>
	player.request('POST', `/api/tables/${tableId}/voice`);

const seatsOf = (list: SeatList | undefined) => list?.seats ?? null;

// Everyone shoves, or calls a shove, until someone has no chips left.
async function untilBust(server: TestServer, runner: TableRunner): Promise<void> {
	for (let steps = 0; steps < 400; steps += 1) {
		await server.settle();
		const table = runner.table;
		const hand = table.hand;
		if (table.players().some(([, one]) => one.stack === 0) && !table.handInProgress) return;
		if (!hand || hand.toAct === null || !table.handInProgress) continue;
		const legal = legalActions(hand);
		const action =
			legal.raiseKind !== null
				? Action.of(legal.raiseKind, legal.maxTo)
				: legal.canCheck
					? Action.check()
					: Action.call();
		await runner.act(table.seats[hand.toAct]!.playerId, action);
	}
	throw new Error('nobody went bust');
}
const at = (player: Player, seat: number) => ({ seat, player: publicRef(player.playerId) });

describe('whether pages offer voice (P4C.6)', () => {
	it('says so only with a voice service and the word that pages can reach it', async () => {
		const offer = async (server: TestServer) => {
			const player = await Player.create(server);
			const response = await player.request('GET', '/api/voice');
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			return response.json();
		};
		expect(await offer((await voiced(true)).server)).toEqual({ offered: true });
		expect(await offer((await voiced(false)).server)).toEqual({ offered: false });
		const silent = await new TestServer({ voiceOffered: true }).start();
		servers.push(silent);
		expect(await offer(silent)).toEqual({ offered: false });
	});
});

describe('voice tokens', () => {
	it('go to people seated with someone else, naming the table, the seat and the public reference', async () => {
		const { server } = await voiced();
		const [alice, bob] = [await Player.create(server), await Player.create(server)];
		const tableId = await alice.newTable(3, null);
		await sit(bob, tableId, 2);
		const response = await ask(bob, tableId);
		expect(response.status).toBe(200);
		const body = (await response.json()) as VoiceTokenResponse;
		expect(body).toMatchObject({ table: tableId, seat: 2, url: '/voice' });
		expect(readToken(voiceKey(SECRET), body.token, tableId, NOW)).toMatchObject({
			table: tableId,
			seat: 2,
			player: publicRef(bob.playerId)
		});
		expect(body.token).not.toContain(bob.playerId);
	});

	it('go to nobody else: a spectator, someone alone with bots, a practice table, a bust', async () => {
		const { server } = await voiced();
		const [alice, bob, carol] = [
			await Player.create(server),
			await Player.create(server),
			await Player.create(server)
		];
		// Alone with bots.
		const withBots = await alice.newTable(3, 'random');
		expect((await ask(alice, withBots)).status).toBe(409);
		const tableId = await bob.newTable(2, null);
		await sit(alice, tableId, 1);
		expect((await ask(alice, tableId)).status).toBe(200);
		// Watching is not sitting.
		expect((await ask(carol, tableId)).status).toBe(403);
		// A practice table has one person and a bot, and no voice whatever its seats hold.
		const practice = (await carol.json<{ table_id: string }>('POST', '/api/practice', {})).table_id;
		expect((await ask(carol, practice)).status).toBe(403);
		// Gone bust: no chips and no rebuy coming, and the other is then alone.
		await untilBust(server, server.runner(tableId));
		expect((await ask(bob, tableId)).status).toBe(409);
		expect((await ask(alice, tableId)).status).toBe(409);
	});

	it('are refused when the server has no voice service', async () => {
		const server = await new TestServer().start();
		servers.push(server);
		const [alice, bob] = [await Player.create(server), await Player.create(server)];
		const tableId = await alice.newTable(2, null);
		await sit(bob, tableId, 1);
		expect((await ask(alice, tableId)).status).toBe(503);
	});
});

describe('what the voice service hears', () => {
	it('who is in voice each time it changes, and nothing for a table with one person', async () => {
		const { server, voice, lists } = await voiced();
		const [alice, bob, carol] = [
			await Player.create(server),
			await Player.create(server),
			await Player.create(server)
		];
		const tableId = await alice.newTable(4, null);
		await server.settle();
		await voice.settled();
		// One person: nobody to talk to, so nothing is sent.
		expect(lists).toEqual([]);
		await sit(bob, tableId, 1);
		await server.settle();
		await voice.settled();
		expect(lists.map(seatsOf)).toEqual([[at(alice, 0), at(bob, 1)]]);
		await sit(carol, tableId, 3);
		await server.settle();
		await voice.settled();
		expect(seatsOf(lists.at(-1))).toEqual([at(alice, 0), at(bob, 1), at(carol, 3)]);
		// carol leaves: the two left are the list.
		await server.runner(tableId).leave(carol.playerId);
		await server.settle();
		await voice.settled();
		expect(seatsOf(lists.at(-1))).toEqual([at(alice, 0), at(bob, 1)]);
		// Hands are played; who is in voice does not change until someone busts,
		// and then the other is alone and the room empties.
		const sent = lists.length;
		await untilBust(server, server.runner(tableId));
		await voice.settled();
		expect(lists).toHaveLength(sent + 1);
		expect(seatsOf(lists.at(-1))).toEqual([]);
		// Lists are ordered by when they were made.
		for (const [index, list] of lists.entries()) {
			expect(list.table).toBe(tableId);
			if (index) expect(list.at).toBeGreaterThan(lists[index - 1].at);
		}
	});

	it('a block, and an unblock, between two people at the table', async () => {
		const { server, voice, lists } = await voiced();
		const [alice, bob, carol] = [
			await Player.create(server),
			await Player.create(server),
			await Player.create(server)
		];
		const tableId = await alice.newTable(3, null);
		await sit(bob, tableId, 1);
		await sit(carol, tableId, 2);
		await server.settle();
		await voice.settled();
		expect(lists.at(-1)!.blocks).toEqual([]);
		const blocked = await bob.request('PUT', '/api/relations', {
			table_id: tableId,
			seat: 2,
			kind: 'block'
		});
		expect(blocked.status).toBe(200);
		await voice.settled();
		expect(lists.at(-1)!.blocks).toEqual([[publicRef(bob.playerId), publicRef(carol.playerId)]]);
		expect(seatsOf(lists.at(-1))).toHaveLength(3);
		// A mute is the listener's own business (a paused consumer): the list does not change.
		const sent = lists.length;
		await alice.request('PUT', '/api/relations', { table_id: tableId, seat: 1, kind: 'mute' });
		await voice.settled();
		expect(lists).toHaveLength(sent);
		const unblocked = await bob.request('DELETE', `/api/relations/${publicRef(carol.playerId)}`);
		expect(unblocked.status).toBe(200);
		await voice.settled();
		expect(lists.at(-1)!.blocks).toEqual([]);
	});

	it('an empty list when a table with people in voice closes, and none for practice', async () => {
		const { server, voice, lists } = await voiced();
		const [alice, bob] = [await Player.create(server), await Player.create(server)];
		const practice = (await alice.json<{ table_id: string }>('POST', '/api/practice', {})).table_id;
		const tableId = await bob.newTable(2, null);
		await sit(alice, tableId, 1);
		await server.settle();
		await voice.settled();
		expect(lists.map(({ table }) => table)).toEqual([tableId]);
		await server.tables.close(tableId, 'Closed for the test.');
		await server.tables.close(practice, 'Closed for the test.');
		await voice.settled();
		expect(lists.map(({ table, seats }) => [table, seats.length])).toEqual([
			[tableId, 2],
			[tableId, 0]
		]);
	});
});
