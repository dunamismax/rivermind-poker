// The moderator's commands against DATABASE_URL (P4.5, P4B.8a): the newest
// reports and collusion signals, and a new random handle for a player.
//
//   DATABASE_URL=postgresql://localhost/rivermind pnpm moderation reports
//   pnpm moderation signals --limit 20
//   pnpm moderation rename p_0123abcd
//
// `pnpm build` also bundles it as build/moderation.js, which plain Node runs
// from a release with no node_modules. On ubuntu-vm, as root, with the web
// service's environment:
//
//   set -a; . /etc/web-apps/rivermind_poker/web.env; set +a
//   /opt/node-26/bin/node /srv/rivermindpoker.com/current/build/moderation.js reports
//
// Exits 2 for a command it does not understand and 1 for one that failed.

import { moderate, ModerationError, USAGE } from '../src/lib/server/api/moderation.ts';
import { DatabasePlayers } from '../src/lib/server/api/players.ts';
import { DatabaseSafety } from '../src/lib/server/api/safety.ts';
import { createDatabase, createPool, databaseUrl } from '../src/lib/server/db/index.ts';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
	console.log(USAGE);
	process.exitCode = args.length === 0 ? 2 : 0;
} else {
	let pool: ReturnType<typeof createPool> | undefined;
	try {
		pool = createPool(databaseUrl(), { max: 1 });
		const db = createDatabase(pool);
		const lines = await moderate(args, {
			players: new DatabasePlayers(db),
			safety: new DatabaseSafety(db)
		});
		for (const line of lines) console.log(line);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = error instanceof ModerationError && error.message === USAGE ? 2 : 1;
	} finally {
		await pool?.end();
	}
}
