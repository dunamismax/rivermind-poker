// Protocol v2 over the TypeScript table server (P4B.5b), ported from
// test/server/test_protocol_v2.py: every message must never show another
// seat's hidden cards and must survive reconnecting, at every seat count.
import { afterEach, describe, expect, it } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { COOKIE_NAME } from './auth.ts';
import { CLOSE_POLICY } from './socket.ts';
import {
	checkPrivacy,
	Player,
	Spy,
	TestServer,
	waitFor,
	type ServerOptions,
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

describe('the HTTP API with tables', () => {
	it('answers the config and refuses bad table requests', async () => {
		const server = await serve();
		const config = (await (await server.request('GET', '/api/config')).json()) as p.ConfigResponse;
		expect(config.protocol).toBe(2);
		expect(config.seat_counts).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
		expect(new Set(config.bots.map((bot) => bot.kind))).toEqual(
			new Set(['random', 'calling_station', 'heuristic'])
		);
		const player = await Player.create(server);
		expect((await server.request('POST', '/api/tables', { body: { seats: 6 } })).status).toBe(401);
		const bad = { cookie: `${COOKIE_NAME}=${player.session}0` };
		const forged = await server.request('POST', '/api/tables', {
			body: { seats: 6 },
			headers: bad
		});
		expect(forged.status).toBe(401);
		for (const body of [
			{ seats: 10 },
			{ seats: '6' },
			{ bots: 'nobody' },
			{ big_blind: 7 },
			{ buy_in: 1 },
			{ x: 1 }
		]) {
			const response = await player.request('POST', '/api/tables', body);
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect(typeof ((await response.json()) as p.HttpError).detail).toBe('string');
		}
	});
});

describe('sockets', () => {
	it('must say hello with a real session', async () => {
		const server = await serve();
		const player = await Player.create(server);

		let socket = server.socket();
		socket.send({ type: 'join_table', table_id: 'x' });
		expect((await socket.receive()).code).toBe('bad_request');
		await waitFor(() => socket.closeCode === CLOSE_POLICY);

		socket = server.socket(); // a short-deck page left open since the cutover
		socket.send({ type: 'join', table_id: 'old', token: 'x' });
		const closed = await socket.receive();
		expect(closed.code).toBe('unknown_table');
		expect(closed.message).toContain('no-limit');

		socket = server.socket(); // a Phase 3 page, which sent a token instead of a cookie
		socket.send({ type: 'hello', protocol: 2, token: 'p_x.abc' });
		expect(await socket.receive()).toMatchObject({ code: 'unauthorized' });

		socket = server.socket(); // no session cookie
		socket.send({ type: 'hello', protocol: 2 });
		expect((await socket.receive()).code).toBe('unauthorized');
		await waitFor(() => socket.closeCode === CLOSE_POLICY);

		socket = server.socket(`${COOKIE_NAME}=${player.session}0`); // a forged one
		socket.send({ type: 'hello', protocol: 2 });
		expect((await socket.receive()).code).toBe('unauthorized');

		socket = await player.socket();
		socket.send({ type: 'join_table', table_id: 'nope' });
		expect((await socket.receive()).code).toBe('unknown_table');
		socket.send({ type: 'dance' });
		expect(await socket.receive()).toMatchObject({
			code: 'bad_request',
			message: 'Invalid dance message.'
		});
		socket.send('not json');
		expect(await socket.receive()).toMatchObject({
			code: 'bad_request',
			message: 'Messages are JSON objects with a type.'
		});
		const tableId = await player.newTable(2);
		socket.send({ type: 'act', table_id: tableId, seq: 1, action: 'call' });
		expect((await socket.receive()).code).toBe('not_subscribed');
		socket.send({ type: 'join_table', table_id: tableId });
		const turn = await socket.myTurn(tableId);
		socket.send({ type: 'act', table_id: tableId, seq: turn.view.seq, action: 'raise' });
		expect((await socket.error()).code).toBe('bad_request'); // a raise needs an amount
		const legal = turn.view.you.legal as p.Legal;
		socket.send({
			type: 'act',
			table_id: tableId,
			seq: turn.view.seq,
			action: 'raise',
			amount: legal.max_to + 1
		});
		const refused = await socket.error();
		expect(refused).toMatchObject({ code: 'illegal_action', table_id: tableId });
	});

	it.each([2, 3, 4, 5, 6, 7, 8, 9])(
		'plays, reconnects and hides cards at %i seats',
		async (seats) => {
			const server = await serve({ seed: seats });
			const player = await Player.create(server);
			const tableId = await player.newTable(seats);
			const spy = new Spy(server.runner(tableId));
			let socket = await player.socket();
			const snapshot = await socket.join(tableId);
			expect(snapshot.view.you.seat).toBe(0);
			expect(snapshot.view.seats.filter((s) => s?.kind === 'bot').length).toBe(seats - 1);
			for (let turns = 0; turns < 12; turns++) socket.play(tableId, await socket.myTurn(tableId));
			const turn = await socket.myTurn(tableId); // leave mid-hand, on our turn
			const mine = turn.view.seats[0]?.cards;
			const handNo = turn.view.hand!.hand_no;
			const lastSeq = turn.view.seq;
			const first = socket.messages;
			socket.close();
			const state = server.runner(tableId).table.seats[0]!;
			await waitFor(() => !state.connected); // the server has seen the socket close

			socket = await player.socket();
			const again = await socket.join(tableId);
			const view = again.view;
			expect(view.seq).toBeGreaterThanOrEqual(lastSeq + 2); // the disconnect and the return are events
			// Their first view already shows them back: no moment of "Away" at their own seat.
			expect(view.seats[0]!.connected).toBe(true);
			if (view.hand!.hand_no === handNo && view.hand!.result === null) {
				expect(view.seats[0]!.cards).toEqual(mine); // the same hand, the same cards
				expect(view.you.legal).not.toBeNull();
				expect(view.turn!.seat).toBe(0);
			}
			await socket.playUntil(tableId, (m) => m.view.hand!.hand_no > handNo + 1);
			const hands = socket.messages;
			const events = hands.flatMap((m) =>
				m.type === 'table' ? (m as unknown as TableMessage).events : []
			);
			const seqs = events.map((e) => e.seq);
			expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i)); // in order, without gaps
			// Their own return is not news to them, so their hand log is not told of it.
			expect(events.map((e) => e.kind)).not.toContain('connected');
			for (const message of [...first, ...hands]) checkPrivacy(message, spy);
		}
	);

	it('keeps hidden cards hidden over many hands, including showdowns', async () => {
		const server = await serve({ seed: 42 });
		const player = await Player.create(server);
		const tableId = await player.newTable(6, 'calling_station');
		const spy = new Spy(server.runner(tableId));
		const socket = await player.socket();
		await socket.join(tableId);
		for (let i = 0; i < 60; i++) socket.play(tableId, await socket.myTurn(tableId));
		const tables = socket.messages.filter((m) => m.type === 'table') as unknown as TableMessage[];
		const showdowns = tables.filter((m) => m.view.hand?.result?.showdown);
		expect(showdowns.length).toBeGreaterThan(0);
		for (const message of socket.messages) checkPrivacy(message, spy);
		const shown = showdowns[showdowns.length - 1].view;
		for (const seat of shown.hand!.result!.shown) {
			expect(shown.seats[seat] === null || shown.seats[seat]!.cards !== null).toBe(true);
		}
	});

	it('refuses stale and duplicate actions', async () => {
		const server = await serve({ seed: 7 });
		const player = await Player.create(server);
		const tableId = await player.newTable(3, 'calling_station');
		const socket = await player.socket();
		await socket.join(tableId);
		const first = await socket.myTurn(tableId);
		const action = first.view.you.legal!.can_check ? 'check' : 'call';
		const old = { type: 'act', table_id: tableId, seq: first.view.seq, action };
		socket.act(tableId, first, action);
		socket.send(old); // sent twice: only one is applied
		expect(['not_your_turn', 'stale']).toContain((await socket.error()).code);
		const runner = server.runner(tableId);
		const next = await socket.myTurn(tableId);
		expect(next.view.turn!.seq).toBeGreaterThan(first.view.seq);
		const acted = next.view.hand!.actions.filter((a) => a.seat === 0).length;
		socket.send({ ...old, action: 'fold' }); // an action for the earlier turn
		expect((await socket.error()).code).toBe('stale');
		const hand = runner.table.hand!;
		expect(hand.toAct).toBe(0); // still our turn, nothing applied
		expect(hand.actions.filter((a) => a.seat === 0).length).toBe(acted);
		socket.act(tableId, next, next.view.you.legal!.can_check ? 'check' : 'fold');
		await socket.table((m) => m.events.some((e) => e.kind === 'action' && e.seat === 0));
	});

	it('lets only the seated player act for their seat', async () => {
		const server = await serve({ seed: 3 });
		const owner = await Player.create(server);
		const other = await Player.create(server);
		const tableId = await owner.newTable(4);
		const spy = new Spy(server.runner(tableId));
		const mine = await owner.socket();
		const theirs = await other.socket();
		await mine.join(tableId);
		await theirs.join(tableId);
		const turn = await mine.myTurn(tableId);
		theirs.send({ type: 'act', table_id: tableId, seq: turn.view.seq, action: 'fold' });
		expect((await theirs.error()).code).toBe('not_seated');
		theirs.send({ type: 'sit', table_id: tableId, seat: 0, buy_in: 10_000 });
		expect((await theirs.error()).code).toBe('seat_taken');
		expect(await other.balance()).toBe(20_000); // the refused buy-in came back
		const hand = server.runner(tableId).table.hand!;
		expect(hand.toAct).toBe(0);
		expect(hand.actions.length).toBe(turn.view.hand!.actions.length); // the other player changed nothing
		const botTurn = await mine.playUntil(
			tableId,
			(m) => m.view.turn !== null && m.view.turn.seat !== 0
		);
		mine.send({ type: 'act', table_id: tableId, seq: botTurn.view.seq, action: 'fold' });
		// Refused either way: the bot is still to act, or it has acted and the seq is old.
		expect(['not_your_turn', 'stale']).toContain((await mine.error()).code);
		const spectator = await theirs.table((m) => m.view.hand !== null);
		expect(spectator.view.you.seat).toBeNull();
		expect(spectator.view.you.legal).toBeNull();
		for (const message of [...mine.messages, ...theirs.messages]) checkPrivacy(message, spy);
	});

	it('follows several tables on one socket', async () => {
		const server = await serve({ seed: 5 });
		const player = await Player.create(server);
		const tables = [await player.newTable(2), await player.newTable(9, 'heuristic')];
		const socket = await player.socket();
		for (const tableId of tables) socket.send({ type: 'join_table', table_id: tableId });
		for (let round = 0; round < 3; round++) {
			for (const tableId of tables) socket.play(tableId, await socket.myTurn(tableId));
		}
		const seen = new Set(
			socket.messages.filter((m) => m.type === 'table').map((m) => m.table_id as string)
		);
		expect(seen).toEqual(new Set(tables));
	});

	it('sits out, rebuys and leaves over the socket', async () => {
		const server = await serve({ seed: 9 });
		const player = await Player.create(server);
		const tableId = await player.newTable(3, 'random', { buy_in: 5_000 });
		const socket = await player.socket();
		await socket.join(tableId);
		await socket.myTurn(tableId);
		socket.send({ type: 'rebuy', table_id: tableId, amount: 100_000 });
		expect((await socket.error()).code).toBe('insufficient_chips'); // 15,000 left
		socket.send({ type: 'rebuy', table_id: tableId, amount: 12_000 });
		expect((await socket.error()).code).toBe('bad_buy_in'); // and refunded
		socket.send({ type: 'rebuy', table_id: tableId, amount: 500 });
		const rebuy = await socket.table((m) => m.view.you.pending_rebuy === 500);
		expect(rebuy.events.some((e) => e.kind === 'rebuy_pending' && e.amount === 500)).toBe(true);
		socket.send({ type: 'sit_out', table_id: tableId });
		const pending = await socket.table((m) => m.view.you.sitting_out_next);
		expect(pending.events.some((e) => e.kind === 'sitting_out_next')).toBe(true);
		const out = await socket.playUntil(tableId, (m) => m.view.you.sitting_out);
		expect(out.view.you.pending_rebuy).toBe(0);
		const kinds = socket.messages.flatMap((m) =>
			m.type === 'table' ? (m as unknown as TableMessage).events.map((e) => e.kind) : []
		);
		expect(kinds.includes('rebought') || kinds.includes('rebuy_dropped')).toBe(true);
		socket.send({ type: 'sit_in', table_id: tableId });
		await socket.myTurn(tableId);
		socket.send({ type: 'leave_table', table_id: tableId });
		await socket.until((m) => m.type === 'left_table');
		// No person is left, so the table closes once the hand is over.
		await waitFor(() => server.tables.manager.get(tableId) === null);
		await server.tables.settled();
		const wallet = await player.json<p.WalletResponse>('GET', '/api/wallet');
		const entries = [...wallet.entries].reverse();
		expect(entries.slice(0, 4).map((e) => e.kind)).toEqual(['grant', 'buy_in', 'rebuy', 'refund']);
		expect(entries[entries.length - 1].kind).toBe('cash_out');
		expect(entries.reduce((total, e) => total + e.amount, 0)).toBe(wallet.balance);
	});
});
