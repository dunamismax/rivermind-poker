// One-click practice at any balance (P6.0b), ported from
// test/server/test_practice.py (P4B.5b). A guest, even one with no chips,
// starts a heads-up hand against the labelled RiverMind Easy bot with one
// request. The practice table belongs to that guest alone, is not listed,
// returns the same table when asked again, never touches the wallet or its
// ledger, refills a guest who ran out and marks its hands as practice. An
// abandoned one closes when the server needs room.
import { afterEach, describe, expect, it } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { CallingStationPolicy, HeuristicPolicy } from '../bots/policies.ts';
import { PRACTICE_STACK, Site } from './site.ts';
import { PRACTICE_IDLE_SECONDS } from './tables.ts';
import {
	Player,
	SECRET,
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

async function practice(player: Player): Promise<p.PracticeResponse> {
	const response = await player.request('POST', '/api/practice');
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as p.PracticeResponse;
}

const wallet = (player: Player) => player.json<p.WalletResponse>('GET', '/api/wallet');
const handNo = (message: TableMessage): number => message.view.hand?.hand_no ?? 0;

describe('practice', () => {
	it('seats a new guest heads-up against Easy without touching the wallet', async () => {
		const server = await serve({ seed: 3 });
		const alice = await Player.create(server);
		const before = await wallet(alice);
		const started = await practice(alice);
		expect(started).toMatchObject({
			created: true,
			seat: 0,
			bot: 'heuristic',
			stack: PRACTICE_STACK
		});
		const tableId = started.table_id;
		const runner = server.runner(tableId);
		expect(runner.practice).toBe(alice.playerId);
		expect(runner.private).toBe(true);
		expect(runner.invite).toBeNull();
		// The bot folds its first hand unseen, so the guest joins in the second, on the small blind.
		await server.settle();
		const a = await alice.socket();
		const view = (await a.join(tableId)).view;
		expect(view.practice).toBe(true);
		expect(view.settings.seat_count).toBe(2);
		expect(view.name).toBe('Practice vs RiverMind Easy');
		const [you, bot] = view.seats;
		expect(you).toMatchObject({ kind: 'human', stack: PRACTICE_STACK, bet: 50 });
		expect(view.hand!.hand_no).toBe(2);
		expect(bot).toMatchObject({ kind: 'bot', bot: 'heuristic' });
		expect(bot!.name).toMatch(/^RiverMind Easy/);
		// The first hand is dealt at once: no buy-in, no other step.
		await a.playUntil(tableId, (m) => handNo(m) >= 1);
		await a.playUntil(tableId, (m) => handNo(m) > 3);
		expect(await wallet(alice)).toEqual(before);
		a.send({ type: 'leave_table', table_id: tableId });
		await a.until((m) => m.type === 'left_table' || m.type === 'table_closed');
		await waitFor(() => server.tables.manager.get(tableId) === null);
		await server.tables.settled();
		// Practice chips stay at the table: leaving pays nothing into the wallet.
		expect(await wallet(alice)).toEqual(before);
		expect(before.entries.map((e) => e.kind)).toEqual(['grant']);
		const played = (await alice.json<p.HandListResponse>('GET', '/api/hands')).hands;
		expect(played.length).toBeGreaterThanOrEqual(3);
		expect(played.every((hand) => hand.practice)).toBe(true);
		expect(server.tables.practice.size).toBe(0);
	});

	it('lets a guest with no chips practise', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		await server.site.wallet.debit(alice.playerId, await alice.balance(), 'buy_in', null);
		expect(await alice.balance()).toBe(0);
		// A wallet-backed table refuses them until their next top-up.
		expect((await alice.request('POST', '/api/quick-seat', {})).status).toBe(400);
		const tableId = (await practice(alice)).table_id;
		const a = await alice.socket();
		await a.join(tableId);
		await a.playUntil(tableId, (m) => handNo(m) > 1);
		expect(await alice.balance()).toBe(0);
	});

	it('returns the same table when asked again, or twice at once', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		const first = await practice(alice);
		const again = await practice(alice);
		expect(again).toMatchObject({ table_id: first.table_id, created: false });

		const bob = await Player.create(server);
		const record = (await server.site.player(bob.playerId))!;
		const [one, two] = await Promise.all([
			server.tables.startPractice(record),
			server.tables.startPractice(record)
		]);
		expect(one.table_id).toBe(two.table_id);
		expect([one.created, two.created].sort()).toEqual([false, true]);
		const guests = [...server.tables.manager.tables.values()].flatMap((r) => r.practice ?? []);
		expect(guests.sort()).toEqual([alice.playerId, bob.playerId].sort());
	});

	it('shows a practice table to its guest alone', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		const mallory = await Player.create(server);
		const tableId = (await practice(alice)).table_id;
		for (const player of [alice, mallory]) {
			expect((await player.json<p.TableListResponse>('GET', '/api/tables')).tables).toEqual([]);
		}
		expect((await mallory.request('POST', `/api/tables/${tableId}/seat`, {})).status).toBe(404);
		expect((await mallory.request('POST', `/api/tables/${tableId}/waitlist`, {})).status).toBe(404);
		// Not even its own guest can buy into it with wallet chips.
		expect((await alice.request('POST', `/api/tables/${tableId}/seat`, {})).status).toBe(400);
		const m = await mallory.socket();
		m.send({ type: 'join_table', table_id: tableId });
		expect((await m.error()).code).toBe('unknown_table');
		// Quick seat never sends anyone to a practice table, its guest included.
		const seat = await alice.json<p.SeatResponse>('POST', '/api/quick-seat', { seats: 2 });
		expect(seat.table_id).not.toBe(tableId);
		const a = await alice.socket();
		await a.join(tableId);
		a.send({ type: 'sit', table_id: tableId, seat: 1, buy_in: 4_000 });
		expect((await a.error()).code).toBe('bad_request');
	});

	it('gives a guest who busts a fresh practice stack', async () => {
		// A practice bot that calls every shove, so the guest busts within a few hands.
		const server = await serve({ tables: { bots: { heuristic: new CallingStationPolicy() } } });
		const alice = await Player.create(server);
		const before = await wallet(alice);
		const tableId = (await practice(alice)).table_id;
		const a = await alice.socket();
		await a.join(tableId);
		// Refilling with chips left is refused.
		a.send({ type: 'rebuy', table_id: tableId, amount: PRACTICE_STACK });
		expect((await a.error()).code).toBe('bad_request');
		const busted = (m: TableMessage) =>
			m.view.seats[0]!.stack === 0 && (m.view.hand === null || m.view.hand.result !== null);
		let steps = 0;
		for (; steps < 200; steps++) {
			const latest = a.latest.get(tableId)!;
			if (busted(latest)) break;
			if (a.isNewTurn(latest, tableId)) {
				const legal = latest.view.you.legal!;
				if (legal.raise_kind !== null) a.act(tableId, latest, legal.raise_kind, legal.max_to);
				else a.act(tableId, latest, 'call');
			}
			await a.receive();
		}
		expect(steps).toBeLessThan(200); // the guest busted
		const bust = handNo(a.latest.get(tableId)!);
		a.send({ type: 'rebuy', table_id: tableId, amount: 1 });
		const refilled = await a.table((m) => m.view.seats[0]!.stack > 0);
		expect(refilled.view.seats[0]!.stack).toBe(PRACTICE_STACK);
		await a.playUntil(tableId, (m) => handNo(m) > bust);
		expect(await wallet(alice)).toEqual(before);
	});

	it('closes an abandoned practice table when the server needs room', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		const bob = await Player.create(server);
		const old = (await practice(alice)).table_id;
		const runner = server.runner(old);
		const guest = runner.table.seats[0]!;
		expect(guest.bot).toBeNull();
		const quiet = () => guest.sittingOut && !runner.table.handInProgress;
		const guestsTurn = () => {
			const turn = runner.table.turn;
			return turn !== null && turn.seat === 0 && turn.final > server.clock.now();
		};
		// Nobody follows the table: the guest times out until they are sat out, and then it
		// goes quiet. Each step waits for the guest's own turn before moving the clock.
		let steps = 0;
		for (; steps < 50; steps++) {
			await waitFor(() => quiet() || guestsTurn());
			if (quiet()) break;
			server.clock.advance(60);
		}
		expect(steps).toBeLessThan(50); // the absent guest was sat out
		server.clock.advance(PRACTICE_IDLE_SECONDS + 1);
		await practice(bob);
		await waitFor(() => server.tables.manager.get(old) === null);
		await server.tables.settled();
		const again = await practice(alice);
		expect(again.created).toBe(true);
		expect(again.table_id).not.toBe(old);
	});

	it('falls back to a bot the server runs', async () => {
		const server = await serve({ tables: { bots: { easy: new HeuristicPolicy() } } });
		const alice = await Player.create(server);
		expect((await practice(alice)).bot).toBe('easy');
	});

	it('takes its stack from a server setting', async () => {
		const server = await serve({ site: { practiceStack: 1_000 } });
		const config = (await (await server.request('GET', '/api/config')).json()) as p.ConfigResponse;
		expect(config.practice_stack).toBe(1_000);
		const alice = await Player.create(server);
		const started = await practice(alice);
		expect(started.stack).toBe(1_000);
		const settings = server.runner(started.table_id).table.config;
		expect([settings.minBuyIn, settings.maxBuyIn]).toEqual([1_000, 1_000]);
		for (const bad of [0, 99, 1.5]) {
			expect(() => new Site({ secret: SECRET, practiceStack: bad })).toThrow(RangeError);
		}
	});
});
