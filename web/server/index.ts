// Start the RiverMind Poker web server: `node build/start.js` (`pnpm start`) after
// `pnpm build`, which bundles this file there, or `node server/index.ts`.
//
// Environment:
//   PORT, HOST              where to listen (3000 and 127.0.0.1 by default)
//   RIVERMIND_BUILD_DIR     the adapter-node build (the bundle's own directory,
//                           or web/build from the source)
//   RIVERMIND_LEGACY_API    forward /api/* and /ws to this serve-nl, such as
//                           http://127.0.0.1:4316, until the P4B.7 cutover
//   SHUTDOWN_TIMEOUT        seconds a SIGTERM waits for open requests (10)
//   ORIGIN, PROTOCOL_HEADER, HOST_HEADER, ADDRESS_HEADER, XFF_DEPTH and
//   BODY_SIZE_LIMIT are read by SvelteKit's handler, as documented for adapter-node.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

const legacy = process.env.RIVERMIND_LEGACY_API;
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const app = createApp({
	handler,
	legacyApi: legacy ? new URL(legacy) : null,
	shutdownTimeoutMs: Number(process.env.SHUTDOWN_TIMEOUT ?? 10) * 1000
});

app.server.listen(port, host, () => {
	const forwarding = legacy ? `, forwarding /api and /ws to ${legacy}` : '';
	console.log(`RiverMind Poker listening on http://${host}:${port}${forwarding}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.once(signal, () => {
		console.log(`${signal}: finishing open requests`);
		app.close().then(
			() => process.exit(0),
			(error: unknown) => {
				console.error(error);
				process.exit(1);
			}
		);
	});
}
