// The site with seeded decks and bots, for a browser test that needs a hand to
// go one way every time (practice.e2e.ts plays a guest out of chips). The
// built pages in front of the TypeScript table server, as e2e/server.ts runs
// it, in memory, except that each table deals from a seed: SEED for the first
// table, the next number for the next.
//
// Test-only. The live server (server/index.ts) has no seeding switch and never
// will (D-8); this file builds its own from the same parts, as the screenshot
// comparison's server does (e2e/visual/server.ts).
//
//   PORT=8840 SEED=1 node e2e/seeded-server.ts

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, type Handler } from '../server/app.ts';
import { createApi } from '../src/lib/server/api/api.ts';
import { UNLIMITED } from '../src/lib/server/api/safety.ts';
import { Site } from '../src/lib/server/api/site.ts';
import { createSocketServer } from '../src/lib/server/api/socket.ts';
import { Tables } from '../src/lib/server/api/tables.ts';
import { seededDealer } from '../src/lib/server/table/runner.ts';

const port = Number(process.env.PORT ?? 8840);
const host = '127.0.0.1';
const origin = `http://${host}:${port}`;
const build = resolve(import.meta.dirname, '..', 'build');
const { handler } = (await import(pathToFileURL(resolve(build, 'handler.js')).href)) as {
	handler: Handler;
};

const quiet = { info: () => {}, warn: () => {}, error: console.error };
const site = new Site({
	secret: Buffer.from('seeded-secret-seeded-secret-seed'),
	limits: UNLIMITED,
	// As the other browser tests' server: three big blinds.
	practiceStack: Number(process.env.PRACTICE_STACK ?? 300)
});
let seed = Number(process.env.SEED ?? 1);
const tables = new Tables(site, {
	log: quiet,
	runner: {
		botDelay: 0.05,
		handPause: 0.4,
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
app.server.listen(port, host, () => console.log(`Seeded test site on ${origin}`));
