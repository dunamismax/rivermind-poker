// The site as the screenshot comparison sees it (`pnpm visual`): the built pages
// in front of the TypeScript table server, with everything that varies between
// runs pinned. Decks and bots are seeded, guests get handles from a fixed list,
// tables get numbered ids, and the clocks stand still, so a turn never times out
// and a finished hand stays on screen.
//
// Test-only. The live server (server/index.ts) has no seeding switch and never
// will (D-8); this file builds its own from the same parts, as Vitest's
// TestServer does.
//
//   PORT=8950 node e2e/visual/server.ts

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, type Handler } from '../../server/app.ts';
import { createApi } from '../../src/lib/server/api/api.ts';
import { guestName, newPlayerId } from '../../src/lib/server/api/auth.ts';
import type { PlayerRecord, PlayerStore } from '../../src/lib/server/api/players.ts';
import { UNLIMITED } from '../../src/lib/server/api/safety.ts';
import { Site } from '../../src/lib/server/api/site.ts';
import { createSocketServer } from '../../src/lib/server/api/socket.ts';
import { Tables } from '../../src/lib/server/api/tables.ts';
import { ManualClock } from '../../src/lib/server/table/clock.ts';
import { seededDealer } from '../../src/lib/server/table/runner.ts';
import { FIXED_TIME, HANDLES } from './fixed.ts';

/** Guests named from {@link HANDLES}, in order, for as long as the process. */
class FixedPlayers implements PlayerStore {
	private readonly byId = new Map<string, PlayerRecord>();
	private made = 0;

	private add(playerId: string, handle: string): PlayerRecord {
		const record = { playerId, handle };
		this.byId.set(playerId, record);
		return record;
	}

	async create(): Promise<PlayerRecord> {
		const handle = HANDLES[this.made] ?? `Guest ${this.made + 1}`;
		this.made += 1;
		return this.add(newPlayerId(), handle);
	}

	async claim(playerId: string): Promise<PlayerRecord> {
		return this.byId.get(playerId) ?? this.add(playerId, guestName(playerId));
	}

	async get(playerId: string): Promise<PlayerRecord | null> {
		return this.byId.get(playerId) ?? null;
	}

	async seen(): Promise<void> {}

	async rename(playerId: string): Promise<PlayerRecord> {
		const record = this.byId.get(playerId);
		if (!record) throw new Error(`unknown player ${playerId}`);
		return record;
	}
}

const port = Number(process.env.PORT ?? 8950);
const host = '127.0.0.1';
const origin = `http://${host}:${port}`;
const build = resolve(import.meta.dirname, '..', '..', 'build');
const { handler } = (await import(pathToFileURL(resolve(build, 'handler.js')).href)) as {
	handler: Handler;
};

const quiet = { info: () => {}, warn: () => {}, error: console.error };
const site = new Site({
	secret: Buffer.from('visual-secret-visual-secret-visu'),
	limits: UNLIMITED,
	players: new FixedPlayers(),
	clock: () => FIXED_TIME
});
let seed = 1;
let tableNo = 1;
const tables = new Tables(site, {
	log: quiet,
	tableIds: () => `visual-table-${tableNo++}`,
	inviteCodes: () => `visual-invite-${tableNo}`,
	runner: {
		// Bots answer at once; the pause after a hand never ends, so its result stays up.
		botDelay: 0,
		handPause: 1,
		sleep: () => new Promise<void>(() => {}),
		clock: new ManualClock(FIXED_TIME),
		dealer: () => seededDealer(seed++),
		log: quiet
	}
});
await tables.start();
const app = createApp({
	handler,
	api: createApi(site, { tables }),
	sockets: createSocketServer(tables),
	origin: new URL(origin),
	shutdownTimeoutMs: 1000
});
app.server.listen(port, host, () => console.log(`Visual test site on ${origin}`));
