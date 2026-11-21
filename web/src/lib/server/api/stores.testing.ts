// The checks every store must pass, in memory (stores.spec.ts) and on
// PostgreSQL (stores.db.spec.ts), ported from test/server/test_wallet.py,
// test/server/test_safety.py and test/db/test_{players,wallet,safety}.py.
import { expect, it } from 'vitest';
import { guestName, newPlayerId } from './auth.ts';
import type { PlayerStore } from './players.ts';
import type { SafetyStore } from './safety.ts';
import { InsufficientChips, STARTING_GRANT, TOP_UP_FLOOR, type Wallet } from './wallet.ts';

export const DAY = 24 * 3600;

export interface Stores {
	players: PlayerStore;
	wallet: Wallet;
	safety: SafetyStore;
	/** Each balance is the sum of its entries, and each entry follows from the one before. */
	checkLedgers(playerIds: string[]): Promise<void>;
}

export async function checkLedgersOf(wallet: Wallet, playerIds: string[]): Promise<void> {
	for (const id of playerIds) {
		const entries = (await wallet.entries(id, 10_000)).reverse();
		let running = 0;
		for (const entry of entries) {
			running += entry.amount;
			expect(entry.balanceAfter).toBe(running);
			expect(running).toBeGreaterThanOrEqual(0);
		}
		expect(await wallet.balance(id)).toBe(running);
	}
}

export function storeSuite(make: () => Promise<Stores>): void {
	it('pays a grant, then tops up below the floor once a day', async () => {
		const { players, wallet, checkLedgers } = await make();
		const player = (await players.create()).playerId;
		expect(await wallet.balance(player)).toBe(0);
		expect(await wallet.visit(player, 0)).toBe(STARTING_GRANT);
		expect(await wallet.visit(player, DAY * 5)).toBe(STARTING_GRANT); // above the floor
		await wallet.debit(player, STARTING_GRANT - 1_500, 'buy_in', 't1');
		expect(await wallet.visit(player, DAY * 5)).toBe(TOP_UP_FLOOR); // a day after the grant
		await wallet.debit(player, TOP_UP_FLOOR, 'buy_in', 't1');
		expect(await wallet.visit(player, DAY * 5.5)).toBe(0); // only once a day
		expect(await wallet.visit(player, DAY * 6)).toBe(TOP_UP_FLOOR);
		const short = await wallet.debit(player, TOP_UP_FLOOR + 1, 'rebuy', 't1').catch((e) => e);
		expect(short).toBeInstanceOf(InsufficientChips);
		expect(short.balance).toBe(TOP_UP_FLOOR);
		expect(short.message).toBe('You have 10,000 chips; that needs 10,001.');
		expect(await wallet.balance(player)).toBe(TOP_UP_FLOOR);
		await expect(wallet.debit(player, 0, 'buy_in')).rejects.toThrow(RangeError);
		await expect(wallet.debit(player, 1.5, 'buy_in')).rejects.toThrow(RangeError);
		await expect(wallet.credit(player, 5, 'gift' as never)).rejects.toThrow(RangeError);
		expect(await wallet.credit(player, 250, 'cash_out', 't1')).toBe(TOP_UP_FLOOR + 250);
		const entries = await wallet.entries(player);
		expect(entries.map((e) => e.kind)).toEqual([
			'cash_out',
			'top_up',
			'buy_in',
			'top_up',
			'buy_in',
			'grant'
		]);
		expect(entries[0]).toMatchObject({ amount: 250, balanceAfter: 10_250, tableId: 't1' });
		expect(entries.at(-1)).toMatchObject({ amount: STARTING_GRANT, tableId: null });
		expect((await wallet.entries(player, 2)).length).toBe(2);
		await checkLedgers([player]);
	});

	it('stores players with unique handles and claims Phase 3 players once', async () => {
		const { players } = await make();
		const first = await players.create();
		expect(await players.get(first.playerId)).toEqual(first);
		expect(await players.get('p_missing')).toBeNull();
		const legacy = newPlayerId();
		const claimed = await players.claim(legacy);
		expect(claimed).toEqual({ playerId: legacy, handle: guestName(legacy) });
		expect(await players.claim(legacy)).toEqual(claimed);
		await players.seen(first.playerId);
		const renamed = await players.rename(first.playerId);
		expect(renamed.handle).not.toBe(first.handle);
		expect(await players.get(first.playerId)).toEqual(renamed);
	});

	it('records a report once a day, and keeps mutes, blocks and signals', async () => {
		const { players, safety } = await make();
		const [alice, bob, carol] = [
			await players.create(),
			await players.create(),
			await players.create()
		];
		const report = {
			reporterId: alice.playerId,
			targetId: bob.playerId,
			targetHandle: bob.handle,
			reason: 'handle' as const,
			tableId: 't1',
			handNo: 4,
			at: 1_000_000
		};
		expect(await safety.report(report)).toBe(true);
		expect(await safety.report(report)).toBe(false); // the same report within a day counts once
		expect(await safety.report({ ...report, handNo: 9, at: 1_000_000 + 86_401 })).toBe(true);
		expect(await safety.report({ ...report, reason: 'abuse' })).toBe(true);
		expect(
			await safety.report({ ...report, reporterId: carol.playerId, tableId: null, handNo: null })
		).toBe(true);
		const stored = await safety.reports(10);
		expect(stored.map((r) => [r.reporterId, r.reason, r.handNo, r.at])).toEqual([
			[carol.playerId, 'handle', null, 1_000_000],
			[alice.playerId, 'abuse', 4, 1_000_000],
			[alice.playerId, 'handle', 9, 1_000_000 + 86_401],
			[alice.playerId, 'handle', 4, 1_000_000]
		]);
		expect(stored[0].targetHandle).toBe(bob.handle);

		await safety.setRelation(alice.playerId, bob.playerId, 'mute');
		await safety.setRelation(alice.playerId, carol.playerId, 'mute');
		await safety.setRelation(alice.playerId, bob.playerId, 'block'); // a mute becomes a block in place
		await safety.setRelation(carol.playerId, alice.playerId, 'block');
		await safety.setRelation(carol.playerId, bob.playerId, 'mute');
		expect(await safety.relations(alice.playerId)).toEqual([
			{ targetId: bob.playerId, handle: bob.handle, kind: 'block' },
			{ targetId: carol.playerId, handle: carol.handle, kind: 'mute' }
		]);
		expect(await safety.blocksInvolving(alice.playerId)).toEqual(
			new Set([bob.playerId, carol.playerId])
		);
		expect(await safety.blocksInvolving(bob.playerId)).toEqual(new Set([alice.playerId])); // a mute is not a block
		await safety.removeRelation(alice.playerId, bob.playerId);
		await safety.removeRelation(alice.playerId, carol.playerId);
		expect(await safety.relations(alice.playerId)).toEqual([]);
		expect(await safety.blocksInvolving(bob.playerId)).toEqual(new Set());

		const signal = {
			kind: 'same_address' as const,
			tableId: 't1',
			playerIds: [alice.playerId, bob.playerId],
			detail: { address: 'ab12', seats: [0, 1], hand_no: 3 },
			at: 2_000_000.5
		};
		await safety.signal(signal);
		expect(await safety.signals(10)).toEqual([signal]);
	});
}
