// The site with seeded decks and bots (e2e/seeded-site.ts), in front of the built
// pages: for a browser test that needs a hand to go one way every time
// (practice.e2e.ts plays a guest out of chips) and for the iPhone app's session
// check (ios/test.sh). Each table deals from a seed: SEED for the first table,
// the next number for the next.
//
//   PORT=8840 SEED=1 node e2e/seeded-server.ts

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Handler } from '../server/app.ts';
import { seededSite } from './seeded-site.ts';

const port = Number(process.env.PORT ?? 8840);
const host = '127.0.0.1';
const origin = `http://${host}:${port}`;
const build = resolve(import.meta.dirname, '..', 'build');
const { handler } = (await import(pathToFileURL(resolve(build, 'handler.js')).href)) as {
	handler: Handler;
};

const { app } = await seededSite({
	handler,
	origin: new URL(origin),
	seed: Number(process.env.SEED ?? 1),
	practiceStack: Number(process.env.PRACTICE_STACK ?? 300)
});
app.server.listen(port, host, () => console.log(`Seeded test site on ${origin}`));
