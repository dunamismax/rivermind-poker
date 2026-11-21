// Safety, identity and hand histories at running tables (P4.1, P4.5, P4.6),
// ported from the table-dependent tests of test/server/test_safety.py,
// test_identity.py and test_hands.py (P4B.5b), through the server as a
// browser uses it.
import { afterEach, describe, expect, it } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { cardStr } from '../../engine/cards.ts';
import { replayRecord } from '../engine/history.ts';
import { addressTag, DEFAULT_LIMITS, REACTIONS, type Limits } from './safety.ts';
import { publicRef } from './auth.ts';
import { seatOf } from './hands.ts';
import { CLOSE_TRY_AGAIN } from './tables.ts';
import {
	Player,
	SECRET,
	TestServer,
	waitFor,
	type ServerOptions,
	type Socket,
	type TableMessage
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

class FakeClock {
	now = 1000;
	readonly read = (): number => this.now;
}

const limited = (clock: FakeClock, limits: Partial<Limits>): Limits => ({
	...DEFAULT_LIMITS,
	httpRate: 1e9,
	httpBurst: 1e9,
	newPlayerRate: 1e9,
	newPlayerBurst: 1e9,
	socketRate: 1e9,
	socketBurst: 1e9,
	reactionRate: 1e9,
	reactionBurst: 1e9,
	reportRate: 1e9,
	reportBurst: 1e9,
	...limits,
	clock: clock.read
});

async function newTable(player: Player, body: Record<string, unknown>): Promise<string> {
	const response = await player.request('POST', '/api/tables', body);
	expect(response.status).toBe(201);
	return ((await response.json()) as p.NewTableResponse).table_id;
}

const takeSeat = (player: Player, tableId: string, body: Record<string, unknown> = {}) =>
	player.json<p.SeatResponse>('POST', `/api/tables/${tableId}/seat`, body);

/** Alice and Bob seated at a two-seat table for people, Alice in seat 0 and Bob in seat 1. */
async function twoAtATable(server: TestServer): Promise<[Player, Player, string]> {
	const alice = await Player.create(server);
	const bob = await Player.create(server);
	const tableId = await newTable(alice, { seats: 2, bots: null });
	expect(await takeSeat(bob, tableId, { buy_in: 5_000 })).toMatchObject({ seated: true, seat: 1 });
	return [alice, bob, tableId];
}

const reaction = (socket: Socket) => socket.until<p.ReactionMessage>((m) => m.type === 'reaction');
const reactions = (socket: Socket) =>
	socket.messages.flatMap((m) => (m.type === 'reaction' ? [m.reaction as string] : []));

describe('identity at the table', () => {
	it("shows the player's handle in the seat", async () => {
		const server = await serve();
		const player = await Player.create(server);
		const tableId = await player.newTable(2);
		const socket = await player.socket();
		expect((await socket.join(tableId)).view.seats[0]!.name).toBe(player.name);
	});

	it('names people by ref, never by id', async () => {
		const server = await serve();
		const [alice, bob, tableId] = await twoAtATable(server);
		const a = await alice.socket();
		const view = (await a.join(tableId)).view;
		expect(view.seats.map((s) => s!.ref)).toEqual([
			publicRef(alice.playerId),
			publicRef(bob.playerId)
		]);
		expect(JSON.stringify(view.seats)).not.toContain(bob.playerId);
		const carol = await Player.create(server);
		const bots = await newTable(carol, { seats: 3, bots: 'random' });
		const c = await carol.socket();
		const seats = (await c.join(bots)).view.seats;
		expect(seats.map((s) => s!.ref === null)).toEqual([false, true, true]);
	});
});

describe('rate limits at the table', () => {
	it('refuse a socket sending too fast, then close it', async () => {
		const clock = new FakeClock();
		const server = await serve({
			limits: limited(clock, { socketRate: 1, socketBurst: 2, socketStrikes: 3 })
		});
		const alice = await Player.create(server);
		const tableId = await alice.newTable(2, 'random');
		const a = await alice.socket();
		await a.join(tableId);
		a.send({ type: 'refresh', table_id: tableId });
		a.send({ type: 'refresh', table_id: tableId });
		expect(await a.error()).toMatchObject({
			code: 'rate_limited',
			message: 'Too many messages: slow down.'
		});
		clock.now += 1;
		for (let i = 0; i < 4; i++) a.send({ type: 'refresh', table_id: tableId });
		// One more is allowed, then two refusals, and the third closes the socket.
		await waitFor(() => a.closeCode !== null);
		expect(a.closeCode).toBe(CLOSE_TRY_AGAIN);
		const errors = [...a.messages, ...a.drain()].flatMap((m) =>
			m.type === 'error' ? [m.message as string] : []
		);
		expect(errors.slice(1)).toEqual([
			'Too many messages: slow down.',
			'Too many messages: slow down.',
			'Too many messages: reload the page to keep playing.'
		]);
	});
});

describe('reactions, mutes and blocks', () => {
	it('show a seated person reacting, and hide it from whoever muted them', async () => {
		const clock = new FakeClock();
		const server = await serve({
			limits: limited(clock, { reactionRate: 0.5, reactionBurst: 2 })
		});
		const [alice, bob, tableId] = await twoAtATable(server);
		const carol = await Player.create(server);
		const [a, b, c] = [await alice.socket(), await bob.socket(), await carol.socket()];
		for (const socket of [a, b, c]) await socket.join(tableId);
		a.send({ type: 'react', table_id: tableId, reaction: 'nice_hand' });
		for (const socket of [a, b, c]) {
			expect(await reaction(socket)).toEqual({
				type: 'reaction',
				table_id: tableId,
				seat: 0,
				name: alice.name,
				ref: publicRef(alice.playerId),
				reaction: 'nice_hand',
				text: 'Nice hand'
			});
		}
		// Only the preset reactions, and only from a seat.
		a.send({ type: 'react', table_id: tableId, reaction: 'you stink' });
		expect((await a.error()).code).toBe('bad_request');
		c.send({ type: 'react', table_id: tableId, reaction: 'wow' });
		expect((await c.error()).code).toBe('not_seated');
		// Bob mutes Alice: he no longer hears her, Carol still does.
		const muted = await bob.request('PUT', '/api/relations', {
			table_id: tableId,
			seat: 0,
			kind: 'mute'
		});
		expect(muted.status).toBe(200);
		expect(await muted.json()).toEqual({
			players: [{ ref: publicRef(alice.playerId), name: alice.name, kind: 'mute' }]
		});
		a.send({ type: 'react', table_id: tableId, reaction: 'good_game' });
		expect((await reaction(a)).reaction).toBe('good_game');
		expect((await reaction(c)).reaction).toBe('good_game');
		b.send({ type: 'refresh', table_id: tableId });
		await b.table((m) => m.events.length === 0);
		expect(reactions(b)).toEqual(['nice_hand']);
		// Alice has spent her two reactions; the third waits for the bucket.
		a.send({ type: 'react', table_id: tableId, reaction: 'wow' });
		expect(await a.error()).toMatchObject({ code: 'rate_limited', table_id: tableId });
		clock.now += 2;
		a.send({ type: 'react', table_id: tableId, reaction: 'wow' });
		expect((await reaction(c)).reaction).toBe('wow');
		// Unmuting by the public reference brings her back.
		const ref = publicRef(alice.playerId);
		expect(await bob.json('DELETE', `/api/relations/${ref}`)).toEqual({ players: [] });
		expect((await bob.request('DELETE', `/api/relations/${ref}`)).status).toBe(404);
		clock.now += 2;
		a.send({ type: 'react', table_id: tableId, reaction: 'thanks' });
		expect((await reaction(b)).reaction).toBe('thanks');
	});

	it('need a person in the seat', async () => {
		const server = await serve();
		const [alice, , tableId] = await twoAtATable(server);
		const carol = await Player.create(server);
		const bots = await newTable(carol, { seats: 3, bots: 'random' });
		const cases: [Record<string, unknown>, number][] = [
			[{ table_id: tableId, seat: 0, kind: 'block' }, 400], // Alice's own seat
			[{ table_id: bots, seat: 1, kind: 'block' }, 400], // a bot
			[{ table_id: 'nope', seat: 1, kind: 'block' }, 404],
			[{ table_id: tableId, seat: 1, kind: 'hate' }, 400],
			[{ table_id: tableId, seat: 9, kind: 'mute' }, 400]
		];
		for (const [body, status] of cases) {
			const response = await alice.request('PUT', '/api/relations', body);
			expect(response.status, JSON.stringify(body)).toBe(status);
		}
		expect((await server.request('GET', '/api/relations')).status).toBe(401);
		expect(await alice.json('GET', '/api/relations')).toEqual({ players: [] });
	});

	it('keep blocked players apart at quick seat', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		const bob = await Player.create(server);
		const tableId = await newTable(alice, { seats: 6, bots: null });
		// Bob sits with Alice, blocks her and leaves; quick seat no longer sends him there.
		await takeSeat(bob, tableId, { buy_in: 5_000 });
		const table = server.runner(tableId).table;
		expect(table.seatOf(bob.playerId)).not.toBeNull();
		const blocked = await bob.json<p.RelationsResponse>('PUT', '/api/relations', {
			table_id: tableId,
			seat: 0,
			kind: 'block'
		});
		expect(blocked.players[0].kind).toBe('block');
		const lobby = async (player: Player) =>
			(await player.json<p.TableListResponse>('GET', '/api/tables')).tables;
		expect((await lobby(bob))[0].blocked).toBe(true);
		expect((await lobby(alice))[0].blocked).toBe(true); // a block keeps both apart
		const carol = await Player.create(server);
		expect((await lobby(carol))[0].blocked).toBe(false);
		const b = await bob.socket();
		await b.join(tableId);
		b.send({ type: 'leave_table', table_id: tableId });
		await b.until((m) => m.type === 'left_table');
		await waitFor(() => table.seatOf(bob.playerId) === null);
		const quick = await bob.json<p.SeatResponse>('POST', '/api/quick-seat', {
			seats: 6,
			buy_in: 5_000
		});
		expect(quick.table_id).not.toBe(tableId);
		// Carol is not blocked, so she joins Alice's busier table.
		const joined = await carol.json<p.SeatResponse>('POST', '/api/quick-seat', {
			seats: 6,
			buy_in: 5_000
		});
		expect(joined.table_id).toBe(tableId);
		// A block can change to a mute in place.
		const carolSeat = table.seatOf(carol.playerId);
		for (const kind of ['block', 'mute']) {
			const body = { table_id: tableId, seat: carolSeat, kind };
			const { players } = await alice.json<p.RelationsResponse>('PUT', '/api/relations', body);
			expect(players.map((x) => [x.name, x.kind])).toEqual([[carol.name, kind]]);
		}
	});
});

describe('reports', () => {
	it('are recorded once a day and limited', async () => {
		const clock = new FakeClock();
		const server = await serve({
			limits: limited(clock, { reportRate: 1 / 60, reportBurst: 3 })
		});
		const [alice, bob, tableId] = await twoAtATable(server);
		const report = async (reporter: Player, seat: number, reason: string, status = 201) => {
			const response = await reporter.request('POST', '/api/reports', {
				table_id: tableId,
				seat,
				reason
			});
			expect(response.status, await response.clone().text()).toBe(status);
			return (await response.json()) as Record<string, unknown>;
		};
		expect(await report(alice, 1, 'handle')).toEqual({ recorded: true });
		expect(await report(alice, 1, 'handle')).toEqual({ recorded: false }); // the same report counts once
		expect(await report(alice, 1, 'collusion')).toEqual({ recorded: true });
		await report(alice, 1, 'abuse', 429);
		expect((await report(alice, 0, 'abuse', 400)).detail).toBe('That is your own seat.');
		await report(bob, 0, 'rude', 400);
		await report(bob, 5, 'abuse', 404);
		const stored = await server.site.safety.reports(10);
		expect(stored.map((r) => [r.reason, r.targetId, r.targetHandle, r.tableId])).toEqual([
			['collusion', bob.playerId, bob.name, tableId],
			['handle', bob.playerId, bob.name, tableId]
		]);
		expect(stored.every((r) => r.reporterId === alice.playerId)).toBe(true);
	});
});

describe('collusion signals', () => {
	it('raise one signal for two people from one address at a table', async () => {
		// Every request of this test comes from the address "testclient".
		const server = await serve();
		const [alice, bob, tableId] = await twoAtATable(server);
		const signals = await server.site.safety.signals(10);
		expect(signals.length).toBe(1);
		expect(signals[0]).toMatchObject({ kind: 'same_address', tableId });
		expect(new Set(signals[0].playerIds)).toEqual(new Set([alice.playerId, bob.playerId]));
		expect(signals[0].detail).toMatchObject({
			address: addressTag(SECRET, 'testclient'),
			seats: [0, 1]
		});
		// Leaving and sitting again does not repeat it.
		const b = await bob.socket();
		await b.join(tableId);
		b.send({ type: 'leave_table', table_id: tableId });
		await b.until((m) => m.type === 'left_table');
		await waitFor(() => server.runner(tableId).table.seatOf(bob.playerId) === null);
		await takeSeat(bob, tableId, { buy_in: 5_000 });
		expect((await server.site.safety.signals(10)).length).toBe(1);
	});

	it('raise none for people from different addresses, or for bots', async () => {
		const server = await serve();
		const alice = await Player.create(server, '203.0.113.1');
		const bob = await Player.create(server, '203.0.113.2');
		server.site.noteAddress(alice.playerId, '203.0.113.1');
		const tableId = await newTable(alice, { seats: 2, bots: null });
		server.site.noteAddress(bob.playerId, '203.0.113.2');
		await takeSeat(bob, tableId, { buy_in: 5_000 });
		expect(await server.site.safety.signals(10)).toEqual([]);
		await newTable(await Player.create(server), { seats: 3, bots: 'random' });
		expect(await server.site.safety.signals(10)).toEqual([]);
	});

	it('offers the preset reactions in the config', async () => {
		const server = await serve();
		const config = (await (await server.request('GET', '/api/config')).json()) as p.ConfigResponse;
		expect(config.reactions.map((r) => r.kind)).toEqual(Object.keys(REACTIONS));
		expect(config.reactions.every((r) => r.text)).toBe(true);
	});
});

/** Play every turn of each socket until `hands` more hands have ended. */
async function playTogether(sockets: Socket[], tableId: string, hands: number): Promise<void> {
	const first = sockets[0];
	const start = first.latest.get(tableId)!.view.hand?.hand_no ?? 0;
	for (;;) {
		const view = first.latest.get(tableId)!.view;
		if (view.hand !== null && view.hand.hand_no > start + hands) return;
		for (const socket of sockets) {
			const latest = socket.latest.get(tableId);
			if (socket.isNewTurn(latest, tableId)) socket.play(tableId, latest as TableMessage);
		}
		for (const socket of sockets) await socket.receive();
	}
}

function cardsIn(value: unknown, found = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) cardsIn(item, found);
	} else if (typeof value === 'object' && value !== null) {
		const object = value as Record<string, unknown>;
		if (Object.keys(object).length === 2 && 'rank' in object && 'suit' in object) {
			found.add('23456789TJQKA'[(object.rank as number) - 2] + (object.suit as string)[0]);
		}
		for (const item of Object.values(object)) cardsIn(item, found);
	}
	return found;
}

describe('hand histories from the table', () => {
	const handsOf = (player: Player, query = '') =>
		player.json<p.HandListResponse>('GET', `/api/hands${query}`);

	it('show two people their own hands and only the cards shown', async () => {
		const server = await serve({ seed: 7 });
		const alice = await Player.create(server);
		const bob = await Player.create(server);
		const tableId = await newTable(alice, { seats: 2, bots: null });
		await takeSeat(bob, tableId, { buy_in: 5_000 });
		const [a, b] = [await alice.socket(), await bob.socket()];
		for (const socket of [a, b]) await socket.join(tableId);
		await playTogether([a, b], tableId, 6);
		a.close();
		b.close();

		const carol = await Player.create(server);
		expect(await handsOf(carol)).toEqual({ hands: [], more: false });
		const listed = new Map<string, p.HandSummary[]>();
		for (const player of [alice, bob]) {
			const body = await handsOf(player);
			const hands = body.hands;
			expect(hands.length).toBeGreaterThanOrEqual(6);
			expect(body.more).toBe(false);
			const numbers = hands.map((h) => h.hand_no);
			expect(numbers).toEqual([...numbers].sort((x, y) => y - x));
			for (const h of hands) {
				expect(h).toMatchObject({ table_id: tableId, seat_count: 2, practice: false });
				expect(h.cards.length).toBe(2);
			}
			listed.set(player.playerId, hands);
		}
		const mine = listed.get(alice.playerId)!;
		const theirs = listed.get(bob.playerId)!;
		expect(mine.map((h) => h.hand_id)).toEqual(theirs.map((h) => h.hand_id));
		// Heads-up, every chip one wins the other loses.
		mine.forEach((hand, i) => {
			expect(hand.net).toBe(-theirs[i].net);
			expect(hand.seat).not.toBe(theirs[i].seat);
		});

		let folded = 0;
		let shown = 0;
		for (const summary of mine) {
			const handId = summary.hand_id;
			const stored = (await server.site.hands.get(handId))!;
			const state = replayRecord(stored.record);
			for (const player of [alice, bob]) {
				const seat = seatOf(stored, player.playerId)!;
				const other = 1 - seat;
				const body = await player.json<p.HandDetail>('GET', `/api/hands/${handId}`);
				expect(body.hand.seat).toBe(seat);
				const own = state.holeCards[seat]!.map(cardStr);
				const hidden = state.holeCards[other]!.map(cardStr);
				const seen = cardsIn(body);
				for (const c of own) expect(seen.has(c)).toBe(true);
				const you = body.seats.find((s) => s.you)!;
				expect(you).toMatchObject({ seat, name: player.name });
				if (state.result!.shown.includes(other)) {
					shown += 1;
					for (const c of hidden) expect(seen.has(c)).toBe(true);
				} else {
					folded += 1;
					// A folded or mucked hand never shows.
					for (const c of hidden) expect(seen.has(c)).toBe(false);
					expect(body.seats.find((s) => s.seat === other)!.cards).toBeNull();
				}
				expect(body.text).toContain(player.name);
				expect(body.text).not.toContain('S0');
			}
			// Nobody else may open it.
			expect((await carol.request('GET', `/api/hands/${handId}`)).status).toBe(404);
		}
		expect(folded).toBeGreaterThan(0);
		expect(shown).toBeGreaterThan(0);
		expect((await alice.request('GET', '/api/hands/nope')).status).toBe(404);
		expect((await alice.request('GET', '/api/hands/999999')).status).toBe(404);
		expect((await server.request('GET', '/api/hands')).status).toBe(401);
	});

	it('page newest first', async () => {
		const server = await serve({ seed: 3 });
		const alice = await Player.create(server);
		const tableId = await alice.newTable(3, 'random');
		const a = await alice.socket();
		await a.join(tableId);
		await a.playUntil(tableId, (m) => m.view.hand !== null && m.view.hand.hand_no > 5);
		a.close();
		await server.settle();
		const everything = (await handsOf(alice, '?limit=50')).hands;
		expect(everything.length).toBeGreaterThanOrEqual(5);
		const first = await handsOf(alice, '?limit=2');
		expect(first.more).toBe(true);
		expect(first.hands.map((h) => h.hand_id)).toEqual(everything.slice(0, 2).map((h) => h.hand_id));
		const second = await handsOf(alice, `?limit=2&before=${first.hands[1].hand_id}`);
		expect(second.hands.map((h) => h.hand_id)).toEqual(
			everything.slice(2, 4).map((h) => h.hand_id)
		);
		// The limit is capped at 50.
		expect((await handsOf(alice, '?limit=500')).hands.length).toBe(everything.length);
		const body = await alice.json<p.HandDetail>('GET', `/api/hands/${everything[0].hand_id}`);
		const bots = body.seats.filter((s) => s.kind === 'bot');
		expect(bots.length).toBe(2);
		expect(bots.every((s) => s.bot === 'random')).toBe(true);
		expect(body.seats.reduce((total, s) => total + s.net, 0)).toBe(0); // chips are conserved
	});
});
