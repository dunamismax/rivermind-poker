// The TypeScript HTTP API answers as serve-nl does (P4B.5a): every request
// recorded from the Python app by test/server/export_http_contract.py gets
// the same status, headers and body text here, byte for byte.
import { describe, it } from 'vitest';
import { createApi } from './api.ts';
import { checkCase, contract, contractHands } from './contract.testing.ts';
import { MemoryHands } from './hands.ts';
import { UNLIMITED } from './safety.ts';
import { Site } from './site.ts';

describe('the HTTP contract recorded from serve-nl, in memory', async () => {
	const hands = new MemoryHands();
	const site = new Site({
		secret: Buffer.from(contract.secret),
		limits: UNLIMITED,
		hands,
		clock: () => contract.now
	});
	for (const id of contract.players) await site.players.claim(id);
	for (const hand of contractHands()) {
		hands.add(hand.table_id, hand.table_name, hand.finished, hand.practice, contract.now);
	}
	// One server for the whole script, in order: later cases build on earlier ones.
	const api = createApi(site);
	for (const c of contract.cases) it(c.name, () => checkCase(api, c));
});
