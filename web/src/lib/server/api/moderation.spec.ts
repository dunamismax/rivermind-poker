// The moderator's commands (P4.5, P4B.8a) on the memory stores: what each
// prints, and what it refuses.
import { describe, expect, it } from 'vitest';
import { moderate, ModerationError, USAGE, when } from './moderation.ts';
import { MemoryPlayers } from './players.ts';
import { handleAllowed, MemorySafety } from './safety.ts';

async function site() {
	const players = new MemoryPlayers();
	const safety = new MemorySafety();
	const [alice, bob] = [await players.create(), await players.create()];
	return {
		players,
		safety,
		alice,
		bob,
		run: (...args: string[]) => moderate(args, { players, safety })
	};
}

describe('moderation', () => {
	it('writes a time as a UTC minute', () => {
		expect(when(Date.UTC(2026, 10, 21, 16, 5, 59) / 1000)).toBe('2026-11-21 16:05 UTC');
	});

	it('lists reports newest first, naming both players, the table and the hand', async () => {
		const { safety, alice, bob, run } = await site();
		const report = { reporterId: alice.playerId, targetId: bob.playerId, targetHandle: bob.handle };
		await safety.report({ ...report, reason: 'abuse', tableId: null, handNo: null, at: 1_000_000 });
		await safety.report({
			...report,
			reason: 'collusion',
			tableId: 't_9',
			handNo: 12,
			at: 2_000_000
		});
		expect(await run('reports')).toEqual([
			`${when(2_000_000)}  collusion  ${bob.handle} (${bob.playerId})  by ${alice.handle} (${alice.playerId}) at table t_9, hand 12`,
			`${when(1_000_000)}  abuse      ${bob.handle} (${bob.playerId})  by ${alice.handle} (${alice.playerId})`
		]);
		expect(await run('reports', '--limit', '1')).toHaveLength(1);
		// A reporter the players table no longer holds is still named by id.
		await safety.report({
			...report,
			reporterId: 'p_gone',
			reason: 'abuse',
			tableId: null,
			handNo: null,
			at: 3_000_000
		});
		expect((await run('reports'))[0]).toMatch(/ {2}by p_gone$/);
	});

	it('lists signals newest first with their players and detail', async () => {
		const { safety, alice, bob, run } = await site();
		expect(await run('signals')).toEqual([]);
		await safety.signal({
			kind: 'same_address',
			tableId: 't_3',
			playerIds: [alice.playerId, bob.playerId],
			detail: { address: 'a1b2' },
			at: 1_500_000
		});
		expect(await run('signals')).toEqual([
			`${when(1_500_000)}  same_address  table t_3  ${alice.playerId}, ${bob.playerId}  {"address":"a1b2"}`
		]);
	});

	it('gives a player a new handle that passes the filter, and says so', async () => {
		const { players, bob, run } = await site();
		const [line] = await run('rename', bob.playerId);
		const renamed = await players.get(bob.playerId);
		expect(renamed!.handle).not.toBe(bob.handle);
		expect(handleAllowed(renamed!.handle)).toBe(true);
		expect(line).toBe(`${bob.playerId}: ${bob.handle} -> ${renamed!.handle}`);
		await expect(run('rename', 'p_nobody')).rejects.toThrow('No player p_nobody.');
	});

	it('answers anything else with the usage', async () => {
		const { run } = await site();
		for (const args of [
			[],
			['delete'],
			['reports', '--limit'],
			['reports', '--limit', '0'],
			['reports', '--limit', 'ten'],
			['reports', 'extra'],
			['signals', '--limit', '5', 'more'],
			['rename'],
			['rename', 'p_1', 'p_2'],
			['rename', '--all']
		]) {
			const failure = await run(...args).then(
				() => null,
				(error: unknown) => error
			);
			expect(failure, args.join(' ')).toBeInstanceOf(ModerationError);
			expect((failure as Error).message).toBe(USAGE);
		}
	});
});
