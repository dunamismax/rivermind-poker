// Start the RiverMind Poker web server: `node build/start.js` (`pnpm start`) after
// `pnpm build`, which bundles this file there, or `node server/index.ts`.
//
// Environment:
//   PORT, HOST              where to listen (3000 and 127.0.0.1 by default)
//   RIVERMIND_BUILD_DIR     the adapter-node build (the bundle's own directory,
//                           or web/build from the source)
//   RIVERMIND_API=1         answer /api/* and /ws with the TypeScript API and
//                           table server (P4B.5a, P4B.5b), set up as
//                           src/lib/server/api/runtime.ts says
//                           (RIVERMIND_SECRET_FILE, DATABASE_URL, ...).
//                           The live unit sets it.
//   RIVERMIND_CANDIDATE=1   run as a release candidate (deploy/update.sh): with
//                           RIVERMIND_API=1 it connects to the database, loads
//                           the champions and checks that every saved table can
//                           be restored, but never restores, deals or saves a
//                           table, and leaves /api/* and /ws unanswered, so it can
//                           start beside the live server on the same database.
//                           /healthz reports `database`, `tables` and `champions`.
//   SHUTDOWN_TIMEOUT        seconds a SIGTERM waits for open requests (10)
//   ORIGIN, PROTOCOL_HEADER, HOST_HEADER, ADDRESS_HEADER, XFF_DEPTH and
//   BODY_SIZE_LIMIT are read by SvelteKit's handler, as documented for adapter-node.
//
// /healthz reports the release's commit from REVISION beside build/ (written by
// deploy/update.sh), or null when there is none.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../src/lib/server/api/runtime.ts';
import { createApp, type Handler } from './app.ts';

// Bundled as build/start.js the handler sits beside this file; run from the source
// (node server/index.ts) it is in ../build.
const here = import.meta.dirname;
const build = resolve(
	process.env.RIVERMIND_BUILD_DIR ??
		(existsSync(resolve(here, 'handler.js')) ? here : resolve(here, '..', 'build'))
);
const { handler } = (await import(pathToFileURL(resolve(build, 'handler.js')).href)) as {
	handler: Handler;
};

function readRevision(file: string): string | null {
	if (!existsSync(file)) return null;
	const revision = readFileSync(file, 'utf8').split('\n')[0].trim();
	return /^[0-9a-f]{40}$/.test(revision) ? revision : null;
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const candidate = process.env.RIVERMIND_CANDIDATE === '1';
const runtime = process.env.RIVERMIND_API === '1' ? createRuntime() : null;
// Restore the open tables before taking a request, so nobody finds theirs missing.
// A candidate never does: the live server owns them.
if (!candidate) await runtime?.start();
const app = createApp({
	handler,
	revision: readRevision(resolve(build, '..', 'REVISION')),
	checks: runtime ? (candidate ? runtime.candidateChecks : runtime.checks) : {},
	shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT ?? 10) * 1000,
	api: candidate ? null : (runtime?.api ?? null),
	sockets: candidate ? null : (runtime?.sockets ?? null),
	origin: process.env.ORIGIN ? new URL(process.env.ORIGIN) : null
});

app.server.listen(port, host, () => {
	const serving = candidate
		? ', as a release candidate (no tables)'
		: runtime
			? ', serving the TypeScript API and tables'
			: '';
	console.log(`RiverMind Poker listening on http://${host}:${port}${serving}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.once(signal, () => {
		console.log(`${signal}: finishing open requests`);
		app
			.close()
			.then(() => runtime?.close())
			.then(
				() => process.exit(0),
				(error: unknown) => {
					console.error(error);
					process.exit(1);
				}
			);
	});
}
