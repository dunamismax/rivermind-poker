import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { writeChampion } from '../src/lib/server/bots/testing.ts';
import { SIX_MAX_S1 } from '../src/lib/server/bots/abstraction.ts';
import { compileGraph, compileTree } from '../src/lib/server/bots/tree.ts';
import { MODELS } from './server.ts';

// Every test drives the production build, served by the real table server.
export default function globalSetup() {
	if (!process.env.E2E_SKIP_BUILD) execSync('pnpm build', { stdio: 'inherit' });
	// A small champion for the server to offer as RiverMind Hard (P5.7a): the real
	// trees with a seeded random strategy and one bucket a street, and the registry
	// extract the server checks it against. The registered champion's own bundle is
	// 450 MB and stays out of Git; Vitest loads that one where it is kept.
	rmSync(MODELS, { recursive: true, force: true });
	const { champion } = writeChampion(MODELS, [compileTree(50), compileTree(100)], {
		name: 'e2e-champion',
		medium: true
	});
	// And a six-seat one (P5.7), on the 50 big blind graph alone, so the trained
	// bots also fill tables of three to six seats.
	writeChampion(MODELS, [compileGraph(50, SIX_MAX_S1)], {
		name: 'e2e-six',
		medium: true,
		others: [champion]
	});
}
