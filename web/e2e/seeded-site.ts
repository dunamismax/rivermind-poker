// The site with seeded decks and bots, for a test that needs a hand to go one
// way every time: the TypeScript table server in memory, as e2e/server.ts runs
// it, except that each table deals from a seed (SEED for the first table, the
// next number for the next). e2e/seeded-server.ts serves it in front of the
// built pages for the browser tests and the iPhone app's checks, and the app's
// session fixture (ios-session.spec.ts) runs the same site in process, so the
// two are built from the same parts.
//
// Test-only. The live server (server/index.ts) has no seeding switch and never
// will (D-8).

import { createApp, type App, type Handler } from '../server/app.ts';
import { createApi } from '../src/lib/server/api/api.ts';
import { UNLIMITED } from '../src/lib/server/api/safety.ts';
import { Site } from '../src/lib/server/api/site.ts';
import { createSocketServer } from '../src/lib/server/api/socket.ts';
import { Tables } from '../src/lib/server/api/tables.ts';
import { seededDealer } from '../src/lib/server/table/runner.ts';

export interface SeededSiteOptions {
	/** The pages' handler: the build's, or none for a test that needs only the API and /ws. */
	handler: Handler;
	origin: URL;
	/** The first table's seed. */
	seed: number;
	/** A practice table's stack: three big blinds, as the other browser tests' server. */
	practiceStack?: number;
}

export async function seededSite({
	handler,
	origin,
	seed,
	practiceStack = 300
}: SeededSiteOptions): Promise<{ app: App; tables: Tables }> {
	const quiet = { info: () => {}, warn: () => {}, error: console.error };
	const site = new Site({
		secret: Buffer.from('seeded-secret-seeded-secret-seed'),
		limits: UNLIMITED,
		practiceStack
	});
	let next = seed;
	const tables = new Tables(site, {
		log: quiet,
		runner: {
			botDelay: 0.05,
			handPause: 0.4,
			dealer: () => seededDealer(next++),
			log: quiet
		}
	});
	await tables.start();
	const app = createApp({
		handler,
		api: createApi(site, { tables }),
		sockets: createSocketServer(tables),
		origin,
		shutdownTimeoutMs: 1000
	});
	return { app, tables };
}
