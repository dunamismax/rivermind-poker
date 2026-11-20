// Decision time of the TypeScript bots (P4B.6, P5.7a): loads a serving bundle,
// plays heads-up hands of its blueprint against RiverMind Easy, the calling
// station, the random bot and itself, and reports the blueprint's decision
// time (p50, p95, p99, max) with the load time and the process's memory.
// The table's short thinking delay is not part of this; it is added on top.
//
//   node scripts/bots-bench.ts --bundle <dir> [--decisions 20000] [--seed 0]

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BlueprintPolicy } from '../src/lib/server/bots/blueprint.ts';
import { loadBundle } from '../src/lib/server/bots/bundle.ts';
import { PythonRandom } from '../src/lib/server/bots/mt.ts';
import { simpleBots } from '../src/lib/server/bots/parity.ts';
import { apply, handConfig, isOver, startHand } from '../src/lib/server/engine/state.ts';
import { seatView } from '../src/lib/server/engine/view.ts';
import { shuffle } from '../src/lib/server/engine/random.ts';

const argv = process.argv.slice(2);
const { values } = parseArgs({
	args: argv[0] === '--' ? argv.slice(1) : argv,
	options: {
		bundle: { type: 'string' },
		decisions: { type: 'string', default: '20000' },
		seed: { type: 'string', default: '0' }
	}
});
if (!values.bundle) {
	console.error('usage: node scripts/bots-bench.ts --bundle <dir> [--decisions 20000]');
	process.exit(2);
}

const loadStarted = performance.now();
const bundle = loadBundle(resolve(values.bundle));
const loadSeconds = (performance.now() - loadStarted) / 1000;
const blueprint = new BlueprintPolicy(bundle);
const bots = { ...simpleBots(), blueprint };
const opponents = ['heuristic', 'calling_station', 'random', 'blueprint'];
const rng = new PythonRandom(BigInt(values.seed));
const target = Number(values.decisions);
const times: number[] = [];
let hands = 0;
while (times.length < target) {
	const opponent = opponents[hands % opponents.length];
	const seats = hands % 2 ? ['blueprint', opponent] : [opponent, 'blueprint'];
	const stack = rng.randint(20, 200) * 100;
	const deck = shuffle(
		Array.from({ length: 52 }, (_, c) => c),
		rng
	);
	let state = startHand(handConfig(50, 100), [stack, stack], hands % 2, { deck });
	blueprint.newHand();
	while (!isOver(state)) {
		const seat = state.toAct as number;
		const policy = bots[seats[seat] as keyof typeof bots];
		const view = seatView(state, seat);
		const started = performance.now();
		const action = policy.act(view, rng);
		if (policy === blueprint) times.push(performance.now() - started);
		state = apply(state, action);
	}
	hands++;
}
times.sort((a, b) => a - b);
const at = (q: number) =>
	Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))] * 1000) / 1000;
const memory = process.memoryUsage();
const mb = (bytes: number) => Math.round(bytes / 2 ** 20);
console.log(
	JSON.stringify(
		{
			bundle: values.bundle,
			checkpoint: bundle.manifest.checkpoint.path ?? 'synthetic',
			load_seconds: Math.round(loadSeconds * 10) / 10,
			hands,
			decisions: times.length,
			decision_ms: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) },
			memory_mb: {
				rss: mb(memory.rss),
				array_buffers: mb(memory.arrayBuffers),
				heap: mb(memory.heapUsed)
			},
			stats: blueprint.stats,
			node: process.version
		},
		null,
		2
	)
);
