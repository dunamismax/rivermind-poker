// The TypeScript table server answers as serve-nl does (P4B.5b): a whole
// session recorded from the Python app by
// test/server/export_table_contract.py (the lobby, seating, the waitlist,
// practice, private tables, quick seat, the clock, reactions, reports and
// four people playing over their sockets) gets the same HTTP responses and
// the same socket messages here.
import { afterAll, describe, expect, it } from 'vitest';
import { contractServer, Replay, tableContract } from './table-contract.testing.ts';

describe('the table session recorded from serve-nl, in memory', async () => {
	const server = await contractServer();
	const replay = new Replay(server);
	afterAll(() => server.stop());

	it('answers every step as serve-nl did', async () => {
		await replay.playAll();
		expect(tableContract.steps.length).toBeGreaterThan(150);
		// Bob and Carol came from one address and shared two tables: both were noted.
		const signals = await server.site.safety.signals(10);
		expect(signals.map((s) => s.tableId).sort()).toEqual(['t-contract-01', 't-contract-03']);
		expect(server.tables.manager.tables.size).toBe(0);
	});
});
