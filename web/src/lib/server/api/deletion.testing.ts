// Deleting a guest and their data (P5D.11), the checks every server must pass,
// in memory (deletion.spec.ts) and on PostgreSQL (deletion.db.spec.ts).
//
// A guest asks with `DELETE /api/guest`. Their session ends at once and their
// sockets close; they leave every table, a hand under way keeping their seat
// until it ends, with their chips paid back to their wallet as any departure's
// are; and then their row goes, with their wallet and ledger, mutes, blocks,
// reports and signals. In the hands they played their seat becomes "Former
// guest", so the others dealt into those hands can still replay them.
import { expect, it } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { DELETED_NAME } from './hands.ts';
import { checkLedgersOf } from './stores.testing.ts';
import { GUEST_DELETED } from './tables.ts';
import { Player, type Socket, type TableMessage, type TestServer } from './tables.testing.ts';
import { STARTING_GRANT } from './wallet.ts';

const ended = (n: number) => (m: TableMessage) =>
	m.events.some((e) => e.kind === 'hand_ended' && e.hand_no === n);

export interface DeletionChecks {
	/** What the database still holds of a player, or nothing to check in memory. */
	traces?(playerId: string): Promise<Record<string, number>>;
}

/** Hold every erasure until `release` is called, to look at what came before it. */
function holdErasure(server: TestServer): () => void {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const erase = server.site.erase.bind(server.site);
	server.site.erase = async (playerId: string) => {
		await gate;
		return erase(playerId);
	};
	return release;
}

async function deleteGuest(player: Player): Promise<Response> {
	return player.request('DELETE', '/api/guest', { confirm: true });
}

/**
 * Alice, Bob and Carol at a three-seat table with no bots, each following it, one
 * hand played out. Three, so that Alice folding does not end the next hand.
 */
async function threeHanded(server: TestServer): Promise<{
	alice: Player;
	bob: Player;
	tableId: string;
	a: Socket;
	b: Socket;
	c: Socket;
}> {
	const alice = await Player.create(server);
	const bob = await Player.create(server);
	const carol = await Player.create(server);
	const tableId = await alice.newTable(3, null);
	for (const other of [bob, carol]) {
		const seated = await other.request('POST', `/api/tables/${tableId}/seat`, {});
		expect(seated.status, await seated.clone().text()).toBe(200);
	}
	const [a, b, c] = await Promise.all([alice.socket(), bob.socket(), carol.socket()]);
	for (const socket of [a, b, c]) await socket.join(tableId);
	await Promise.all([a, b, c].map((socket) => socket.playUntil(tableId, ended(1))));
	return { alice, bob, tableId, a, b, c };
}

export function deletionSuite(make: () => Promise<TestServer>, checks: DeletionChecks = {}): void {
	it('needs a session and a body that says so', async () => {
		const server = await make();
		const alice = await Player.create(server);
		expect((await alice.request('DELETE', '/api/guest')).status).toBe(400);
		const unsure = await alice.request('DELETE', '/api/guest', { confirm: false });
		expect(unsure.status).toBe(400);
		expect(((await unsure.json()) as p.HttpError).detail).toContain('confirm');
		const nobody = await server.request('DELETE', '/api/guest', { body: { confirm: true } });
		expect(nobody.status).toBe(401);
		expect((await alice.request('GET', '/api/wallet')).status).toBe(200);
	});

	it('erases a guest at no table at once, and the next visit is a new guest', async () => {
		const server = await make();
		const alice = await Player.create(server);
		const response = await deleteGuest(alice);
		expect(response.status).toBe(200);
		expect((await response.json()) as p.DeleteGuestResponse).toEqual({ erased: true });
		const cookie = response.headers.get('set-cookie') ?? '';
		expect(cookie).toMatch(/^rm_session=; Max-Age=0; Path=\/;/);
		expect((await alice.request('GET', '/api/wallet')).status).toBe(401);
		expect((await alice.request('GET', '/api/hands')).status).toBe(401);
		const socket = server.socket(alice.cookie);
		socket.send({ type: 'hello', protocol: 2 });
		expect(await socket.error()).toMatchObject({ code: 'unauthorized' });
		// The old cookie makes a new guest, with a new name and a fresh grant.
		const again = await alice.request('POST', '/api/session');
		const fresh = (await again.json()) as p.SessionResponse;
		expect(fresh.created).toBe(true);
		expect(fresh.player_id).not.toBe(alice.playerId);
		expect(fresh.balance).toBe(STARTING_GRANT);
		expect(await server.site.wallet.entries(alice.playerId)).toEqual([]);
		if (checks.traces) {
			expect(await checks.traces(alice.playerId)).toEqual({
				players: 0,
				ledger: 0,
				hands: 0
			});
		}
		// Deleting again finds no guest.
		expect((await deleteGuest(alice)).status).toBe(401);
	});

	it('closes their practice table, whose chips were never theirs', async () => {
		const server = await make();
		const alice = await Player.create(server);
		const started = (await alice.json<p.PracticeResponse>('POST', '/api/practice')).table_id;
		const socket = await alice.socket();
		await socket.join(started);
		await server.settle();
		const response = await deleteGuest(alice);
		expect((await response.json()) as p.DeleteGuestResponse).toEqual({ erased: true });
		expect(server.tables.manager.get(started)).toBeNull();
		expect(server.tables.practice.has(alice.playerId)).toBe(false);
		expect(socket.messages.concat(socket.drain())).toContainEqual(
			expect.objectContaining({ type: 'error', code: 'unauthorized', message: GUEST_DELETED })
		);
		expect(socket.closeCode).not.toBeNull();
	});

	it('takes a guest out of a hand under way, pays their chips back, then erases them', async () => {
		const server = await make();
		const { alice, bob, tableId, a, b, c } = await threeHanded(server);
		const runner = server.runner(tableId);
		const aliceSeat = runner.table.seatOf(alice.playerId)!;
		// Bob mutes and reports Alice.
		const relation = { table_id: tableId, seat: aliceSeat, kind: 'mute' };
		expect((await bob.request('PUT', '/api/relations', relation)).status).toBe(200);
		const report = { table_id: tableId, seat: aliceSeat, reason: 'abuse' };
		expect((await bob.request('POST', '/api/reports', report)).status).toBe(201);
		await b.table((m) => m.view.hand?.hand_no === 2 && m.view.hand.result === null);
		const release = holdErasure(server);

		const response = await deleteGuest(alice);
		expect(response.status).toBe(200);
		expect((await response.json()) as p.DeleteGuestResponse).toEqual({ erased: false });
		// The session is over at once, and her socket is told why and closed.
		expect((await alice.request('GET', '/api/wallet')).status).toBe(401);
		expect(a.messages.concat(a.drain())).toContainEqual(
			expect.objectContaining({ type: 'error', code: 'unauthorized' })
		);
		expect(a.closeCode).not.toBeNull();
		// Bob and Carol play the hand out; Alice checks or folds as a leaving player does, and goes.
		const left = (m: TableMessage) => m.events.some((e) => e.kind === 'left');
		await Promise.all([b.playUntil(tableId, left), c.playUntil(tableId, left)]);
		await server.settle();
		expect(runner.table.seatOf(alice.playerId)).toBeNull();
		// Her chips came back to her wallet, and every ledger adds up, hers included.
		const entries = await server.site.wallet.entries(alice.playerId, 100);
		expect(entries[0].kind).toBe('cash_out');
		await checkLedgersOf(server.site.wallet, [alice.playerId, bob.playerId]);

		release();
		await server.tables.erased();
		expect(await server.site.wallet.entries(alice.playerId)).toEqual([]);
		expect(await server.site.players.get(alice.playerId)).toBeNull();
		expect(await server.site.safety.reports(10)).toEqual([]);
		expect((await bob.json<p.RelationsResponse>('GET', '/api/relations')).players).toEqual([]);
		await checkLedgersOf(server.site.wallet, [bob.playerId]);
		// Bob's hands are whole, with Alice as a former guest.
		const list = await bob.json<p.HandListResponse>('GET', '/api/hands');
		expect(list.hands.map((h) => h.hand_no)).toEqual([2, 1]);
		for (const hand of list.hands) {
			const detail = await bob.json<p.HandDetail>('GET', `/api/hands/${hand.hand_id}`);
			const her = detail.seats.find((s) => s.seat === aliceSeat)!;
			expect(her).toMatchObject({ name: DELETED_NAME, kind: 'human', you: false });
			expect(detail.seats.find((s) => s.you)?.name).toBe(bob.name);
			expect(detail.text).not.toContain(alice.name);
		}
		if (checks.traces) {
			expect(await checks.traces(alice.playerId)).toEqual({ players: 0, ledger: 0, hands: 0 });
		}
	});

	it('gives up a held seat and a waitlist place', async () => {
		const server = await make();
		const host = await Player.create(server);
		const tableId = await host.newTable(2, 'random');
		const alice = await Player.create(server);
		const carol = await Player.create(server);
		// The bot's seat is taken by Carol between hands; Alice waits for the next.
		const seated = await carol.request('POST', `/api/tables/${tableId}/seat`, {});
		expect(seated.status, await seated.clone().text()).toBe(200);
		await server.settle();
		const waiting = await alice.request('POST', `/api/tables/${tableId}/waitlist`, {});
		expect(waiting.status, await waiting.clone().text()).toBe(200);
		const runner = server.runner(tableId);
		expect(runner.isMember(alice.playerId)).toBe(true);
		expect((await (await deleteGuest(alice)).json()) as p.DeleteGuestResponse).toEqual({
			erased: true
		});
		expect(runner.isMember(alice.playerId)).toBe(false);
	});
}
