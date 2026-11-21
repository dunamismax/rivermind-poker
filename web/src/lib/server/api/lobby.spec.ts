// The lobby over HTTP and the socket (P4.3), ported from
// test/server/test_lobby.py (P4B.5b). People list the public tables with
// filters, quick-seat, take a bot's seat, hold seats, wait in line for a full
// table and join private tables with an invite code. Two people at one table
// play several hands together, each seeing only their own cards.
import { afterEach, describe, expect, it } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { RESERVE_SECONDS } from '../table/table.ts';
import {
	checkPrivacy,
	Player,
	Spy,
	TestServer,
	waitFor,
	type ServerOptions
} from './tables.testing.ts';

const servers: TestServer[] = [];

async function serve(options: ServerOptions = {}): Promise<TestServer> {
	const server = await new TestServer(options).start();
	servers.push(server);
	return server;
}

afterEach(async () => {
	while (servers.length) await servers.pop()!.stop();
});

async function lobby(player: Player, filters = ''): Promise<p.TableSummary[]> {
	const response = await player.request('GET', `/api/tables${filters}`);
	expect(response.status).toBe(200);
	return ((await response.json()) as p.TableListResponse).tables;
}

async function newTable(
	player: Player,
	body: Record<string, unknown>
): Promise<p.NewTableResponse> {
	const response = await player.request('POST', '/api/tables', body);
	expect(response.status, await response.clone().text()).toBe(201);
	return (await response.json()) as p.NewTableResponse;
}

async function takeSeat(
	player: Player,
	tableId: string,
	body: Record<string, unknown> = {},
	status = 200
): Promise<p.SeatResponse> {
	const response = await player.request('POST', `/api/tables/${tableId}/seat`, body);
	expect(response.status, await response.clone().text()).toBe(status);
	return (await response.json()) as p.SeatResponse;
}

async function waitlist(
	player: Player,
	tableId: string,
	body: Record<string, unknown> = {},
	status = 200
): Promise<p.WaitlistResponse> {
	const response = await player.request('POST', `/api/tables/${tableId}/waitlist`, body);
	expect(response.status, await response.clone().text()).toBe(status);
	return (await response.json()) as p.WaitlistResponse;
}

describe('the lobby', () => {
	it('lists public tables with filters', async () => {
		const server = await serve();
		const [alice, bob, carol] = [
			await Player.create(server),
			await Player.create(server),
			await Player.create(server)
		];
		expect((await server.request('GET', '/api/tables')).status).toBe(401);
		const open = await newTable(alice, { seats: 6, bots: 'random', big_blind: 100 });
		expect(open.invite).toBeNull();
		const hidden = await newTable(bob, { seats: 2, bots: null, big_blind: 50, private: true });
		expect(hidden.invite).toMatch(/^[A-Za-z0-9_-]{16}$/);
		const [row] = await lobby(carol);
		expect(row).toMatchObject({
			table_id: open.table_id,
			people: 1,
			bots: 5,
			free_seats: 0,
			bot_seats: 5,
			small_blind: 50,
			big_blind: 100,
			seat_count: 6,
			private: false,
			seated: false,
			hold: null,
			waitlist_position: null
		});
		const filtered = await lobby(carol, '?seats=6&big_blind=100&open=true');
		expect(filtered.map((t) => t.table_id)).toEqual([open.table_id]);
		expect(await lobby(carol, '?seats=2')).toEqual([]);
		expect(await lobby(carol, '?big_blind=200')).toEqual([]);
		// Each person sees the private table they are at, and only that one.
		const bobs = await lobby(bob);
		expect(Object.fromEntries(bobs.map((t) => [t.table_id, t.seated]))).toEqual({
			[open.table_id]: false,
			[hidden.table_id]: true
		});
		expect((await lobby(alice)).map((t) => t.table_id)).toEqual([open.table_id]);
		// Bob's table has a free seat but no bots.
		expect((await lobby(bob, '?seats=2'))[0].free_seats).toBe(1);
	});

	it('lets two people play together after one takes a bot seat', async () => {
		const server = await serve({ seed: 4 });
		const alice = await Player.create(server);
		const bob = await Player.create(server);
		const tableId = (await newTable(alice, { seats: 3, bots: 'random' })).table_id;
		const runner = server.runner(tableId);
		const spy = new Spy(runner);
		const a = await alice.socket();
		const b = await bob.socket();
		await a.join(tableId);
		await a.myTurn(tableId); // a hand is under way, waiting for Alice
		const seat = await takeSeat(bob, tableId, { buy_in: 5_000 });
		// The bot Bob displaced finishes the hand first; the seat is held for him.
		expect(seat.seated).toBe(false);
		expect(seat.hold!.ready).toBe(false);
		const held = seat.seat;
		await a.playUntil(tableId, (m) => m.view.seats[held] === null);
		expect(a.latest.get(tableId)!.view.holds[0]).toMatchObject({
			seat: held,
			name: bob.name,
			ready: true
		});
		const view = (await b.join(tableId)).view;
		expect(view.you.hold!.ready).toBe(true);
		expect(view.you.seat).toBeNull();
		b.send({ type: 'sit', table_id: tableId, seat: held, buy_in: 5_000 });
		const seated = await b.table((m) => m.view.you.seat === held);
		expect(seated.view.holds).toEqual([]);
		expect(seated.view.seats[held]!.kind).toBe('human');
		await a.table((m) => m.view.seats[held] !== null);
		// Both follow the table now and are in step: every change reaches both, one
		// message each. Play three hands; every message to either keeps the other's
		// cards hidden.
		const start = a.latest.get(tableId)!.view.hand!.hand_no;
		let hands = start;
		while (hands < start + 3) {
			for (const socket of [a, b]) {
				const latest = socket.latest.get(tableId);
				if (socket.isNewTurn(latest, tableId)) socket.play(tableId, latest!);
			}
			for (const socket of [a, b]) {
				const message = await socket.receive();
				expect(message.type).toBe('table');
				checkPrivacy(message, spy);
			}
			hands = a.latest.get(tableId)!.view.hand!.hand_no;
			expect(b.latest.get(tableId)!.view.seq).toBe(a.latest.get(tableId)!.view.seq);
		}
		const dealt = new Set(runner.table.handPlayers);
		expect(dealt.has(alice.playerId) && dealt.has(bob.playerId)).toBe(true);
	});

	it('quick-seats at the busiest matching table or starts one', async () => {
		const server = await serve();
		const [alice, bob, carol] = [
			await Player.create(server),
			await Player.create(server),
			await Player.create(server)
		];
		const tableId = (await newTable(alice, { seats: 6, bots: 'random', big_blind: 100 })).table_id;
		const quick = await bob.json<p.SeatResponse>('POST', '/api/quick-seat', {});
		expect(quick.table_id).toBe(tableId);
		// A hand is waiting for Alice, so Bob holds a bot's seat until it ends.
		expect(quick.seated || quick.hold !== null).toBe(true);
		const other = await carol.json<p.SeatResponse>('POST', '/api/quick-seat', { seats: 2 });
		expect(other.table_id).not.toBe(tableId);
		expect(other.seated).toBe(true);
		expect(server.runner(other.table_id).table.config.seatCount).toBe(2);
		// Quick seat again: Carol already sits at a 2-seat table and goes back to it.
		expect(await carol.json('POST', '/api/quick-seat', { seats: 2 })).toEqual(other);
		// The stakes follow the wallet: with 16,000 left, 100/200 is the largest she can afford.
		const dave = await Player.create(server);
		await server.site.wallet.debit(dave.playerId, 4_000, 'buy_in', null);
		const afforded = await dave.json<p.SeatResponse>('POST', '/api/quick-seat', { seats: 9 });
		expect(server.runner(afforded.table_id).table.config.bigBlind).toBe(100);
		const erin = await Player.create(server);
		await server.site.wallet.debit(erin.playerId, 17_000, 'buy_in', null);
		const small = await erin.json<p.SeatResponse>('POST', '/api/quick-seat', { seats: 4 });
		expect(server.runner(small.table_id).table.config.bigBlind).toBe(50);
	});

	it('keeps blocked players apart at quick seat', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		const bob = await Player.create(server);
		const tableId = (await newTable(alice, { seats: 6, bots: null })).table_id;
		await server.site.safety.setRelation(bob.playerId, alice.playerId, 'block');
		const quick = await bob.json<p.SeatResponse>('POST', '/api/quick-seat', { seats: 6 });
		expect(quick.table_id).not.toBe(tableId);
		expect((await lobby(bob)).find((t) => t.table_id === tableId)!.blocked).toBe(true);
		expect((await lobby(alice)).find((t) => t.table_id === tableId)!.blocked).toBe(false);
	});

	it('needs the invite for a private table', async () => {
		const server = await serve();
		const [alice, bob, carol] = [
			await Player.create(server),
			await Player.create(server),
			await Player.create(server)
		];
		const made = await newTable(alice, { seats: 3, bots: 'random', private: true });
		const tableId = made.table_id;
		const code = made.invite as string;
		expect(await lobby(bob)).toEqual([]);
		expect((await bob.request('GET', '/api/invites/not-a-code')).status).toBe(404);
		const found = await bob.request('GET', `/api/invites/${code}`);
		expect(found.status).toBe(200);
		expect(await found.json()).toMatchObject({ table_id: tableId, private: true });
		await takeSeat(bob, tableId, {}, 404);
		await takeSeat(bob, tableId, { invite: 'wrong' }, 404);
		await waitlist(bob, tableId, {}, 404);
		const c = await carol.socket();
		c.send({ type: 'join_table', table_id: tableId });
		expect((await c.error()).code).toBe('unknown_table');
		const held = await takeSeat(bob, tableId, { invite: code, hold_only: true });
		expect(held.seated).toBe(false);
		expect(held.hold).not.toBeNull();
		const b = await bob.socket();
		expect((await b.join(tableId)).view).toMatchObject({ private: true, invite: code });
		const a = await alice.socket();
		expect((await a.join(tableId)).view.invite).toBe(code);
	});

	it('has a waitlist for a full table, and held seats run out', async () => {
		const server = await serve({ seed: 2 });
		const [alice, bob, carol, dave] = [
			await Player.create(server),
			await Player.create(server),
			await Player.create(server),
			await Player.create(server)
		];
		const tableId = (await newTable(alice, { seats: 2, bots: null })).table_id;
		const table = server.runner(tableId).table;
		await waitlist(carol, tableId, {}, 400); // a seat is free: take it instead
		expect((await takeSeat(bob, tableId)).seated).toBe(true);
		await takeSeat(carol, tableId, {}, 409);
		expect((await waitlist(carol, tableId)).position).toBe(1);
		expect((await waitlist(dave, tableId)).position).toBe(2);
		expect((await waitlist(carol, tableId)).position).toBe(1); // asking again keeps the place
		expect((await lobby(dave))[0]).toMatchObject({ waitlist_position: 2, waitlist: 2 });
		expect(await lobby(dave, '?open=true')).toEqual([]);
		const a = await alice.socket();
		const b = await bob.socket();
		await a.join(tableId);
		await b.join(tableId);
		b.send({ type: 'leave_table', table_id: tableId });
		await b.until((m) => m.type === 'left_table');
		// Bob folds out of the hand; when it ends his seat is held for Carol.
		await a.playUntil(tableId, (m) => m.view.seats[1] === null && m.view.holds.length > 0);
		a.close();
		b.close();
		const hold = table.reservations.get(1)!;
		expect(hold.playerId).toBe(carol.playerId);
		expect(hold.until).not.toBeNull();
		const [row] = await lobby(carol);
		expect(row.hold).toMatchObject({ seat: 1, ready: true });
		expect((await lobby(dave))[0].waitlist_position).toBe(1);
		// Carol does not come back in time: the seat passes to Dave.
		server.clock.advance(RESERVE_SECONDS);
		await waitFor(() => table.reservations.get(1)?.playerId === dave.playerId);
		await takeSeat(carol, tableId, {}, 409);
		expect((await takeSeat(dave, tableId, { buy_in: 4_000 })).seated).toBe(true);
		expect(table.waitlist).toEqual([]);
		expect(table.reservations.size).toBe(0);
		// Giving up a place in line and a held seat over HTTP.
		expect((await waitlist(carol, tableId)).position).toBe(1);
		expect((await carol.request('DELETE', `/api/tables/${tableId}/waitlist`)).status).toBe(204);
		expect(table.waitlist).toEqual([]);
		// Someone without the chips for the table cannot wait for it.
		const erin = await Player.create(server);
		await server.site.wallet.debit(erin.playerId, 17_000, 'buy_in', null);
		const refused = await erin.request('POST', `/api/tables/${tableId}/waitlist`, {});
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({
			detail: 'You have 3,000 chips; this table needs at least 4,000.'
		});
	});

	it('gives a seat nobody takes back to a bot', async () => {
		const server = await serve({ seed: 7 });
		const alice = await Player.create(server);
		const bob = await Player.create(server);
		const tableId = (await newTable(alice, { seats: 3, bots: 'calling_station' })).table_id;
		const table = server.runner(tableId).table;
		const held = (await takeSeat(bob, tableId, { hold_only: true })).seat;
		const a = await alice.socket();
		await a.join(tableId);
		// The bot leaves when Alice's hand ends, and the empty seat waits for Bob.
		await a.playUntil(tableId, (m) => m.view.seats[held] === null);
		expect(table.reservations.get(held)!.until).not.toBeNull();
		expect((await bob.request('DELETE', `/api/tables/${tableId}/seat`)).status).toBe(204);
		const refilled = await a.table((m) => m.view.seats[held] !== null);
		expect(refilled.view.seats[held]!.kind).toBe('bot');
		expect(refilled.view.holds).toEqual([]);
	});

	it('closes a table nobody needed and refuses a new one when every table is in use', async () => {
		const server = await serve({ tables: { maxTables: 1 } });
		const alice = await Player.create(server);
		const bob = await Player.create(server);
		await newTable(alice, { seats: 2, bots: null });
		const full = await bob.request('POST', '/api/tables', { seats: 2 });
		expect(full.status).toBe(503);
		expect(await full.json()).toEqual({ detail: 'Every table is in use; try again later.' });
		expect((await bob.request('POST', '/api/practice')).status).toBe(503);
		expect(await bob.balance()).toBe(20_000); // nothing was paid for the table that never was
	});
});
