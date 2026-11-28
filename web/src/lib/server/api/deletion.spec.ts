// Deleting a guest and their data (P5D.11), in memory. The checks are in
// deletion.testing.ts; deletion.db.spec.ts runs them on PostgreSQL.
import { afterEach, describe } from 'vitest';
import { deletionSuite } from './deletion.testing.ts';
import { TestServer } from './tables.testing.ts';

const servers: TestServer[] = [];

afterEach(async () => {
	while (servers.length) await servers.pop()!.stop();
});

describe('deleting a guest, in memory', () => {
	deletionSuite(async () => {
		const server = await new TestServer({ seed: 41 }).start();
		servers.push(server);
		return server;
	});
});
