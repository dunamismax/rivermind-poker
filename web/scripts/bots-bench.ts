// Decision time of the TypeScript bots (P4B.6, P5.7a, P5.7): loads serving
// bundles and plays hands of each one's blueprint against RiverMind Easy, the
// calling station, the random bot and itself: heads-up for a heads-up bundle,
// and for a multiway (format 2) bundle at a table of its size with three or
// more dealt in. It reports each blueprint's decision time (p50, p95, p99,
// max) and load time, and the process's memory with every bundle loaded at
// once, as the server holds them. The table's short thinking delay is not
// part of this; it is added on top. With --nine, a nine-seat model on the
// multiway bundle (P5.6, option 1) is timed too, at a table of nine with seven
// to nine dealt in.
//
//   node scripts/bots-bench.ts --bundle <dir> [--bundle <dir> …] [--nine <dir>] [--decisions 20000] [--seed 0]

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BlueprintPolicy } from '../src/lib/server/bots/blueprint.ts';
import { loadBundle, type Bundle } from '../src/lib/server/bots/bundle.ts';
import { PythonRandom } from '../src/lib/server/bots/mt.ts';
import { MultiwayBlueprintPolicy } from '../src/lib/server/bots/multiway.ts';
import { loadNineBundle, NineSeatPolicy } from '../src/lib/server/bots/nine.ts';
import { simpleBots } from '../src/lib/server/bots/parity.ts';
import type { Policy } from '../src/lib/server/bots/policies.ts';
import { apply, handConfig, isOver, startHand } from '../src/lib/server/engine/state.ts';
import { seatView } from '../src/lib/server/engine/view.ts';
import { shuffle } from '../src/lib/server/engine/random.ts';

const argv = process.argv.slice(2);
const { values } = parseArgs({
	args: argv[0] === '--' ? argv.slice(1) : argv,
	options: {
		bundle: { type: 'string', multiple: true },
		nine: { type: 'string' },
		decisions: { type: 'string', default: '20000' },
		seed: { type: 'string', default: '0' }
	}
});
if (!values.bundle?.length) {
	console.error(
		'usage: node scripts/bots-bench.ts --bundle <dir> [--bundle <dir> …] [--decisions 20000]'
	);
	process.exit(2);
}

const loaded: { path: string; bundle: Bundle; seconds: number }[] = [];
for (const path of values.bundle) {
	const loadStarted = performance.now();
	const bundle = loadBundle(resolve(path));
	loaded.push({ path, bundle, seconds: (performance.now() - loadStarted) / 1000 });
}
const target = Number(values.decisions);
const opponents = ['heuristic', 'calling_station', 'random', 'blueprint'];
const rng = new PythonRandom(BigInt(values.seed));
const mb = (bytes: number) => Math.round(bytes / 2 ** 20);

type Benched = Policy & { stats: Record<string, number>; newHand(): void };

function bench(
	{ path, bundle, seconds }: (typeof loaded)[number],
	nine: NineSeatPolicy | null = null
) {
	const multiway = bundle.graphs.length > 0;
	const blueprint: Benched =
		nine ?? (multiway ? new MultiwayBlueprintPolicy(bundle) : new BlueprintPolicy(bundle));
	const table = nine ? 9 : multiway ? bundle.seats : 2;
	const fewest = nine ? 7 : 3;
	const bots: Record<string, Policy> = { ...simpleBots(), blueprint };
	const times: number[] = [];
	let hands = 0;
	while (times.length < target) {
		const dealt = multiway ? rng.randint(fewest, table) : 2;
		// The measured blueprint sits in one seat; the others are each opponent in turn, the blueprint among them.
		const seats = Array.from({ length: table }, (_, s) =>
			s < dealt ? opponents[(hands + s) % opponents.length] : 'heuristic'
		);
		seats[hands % dealt] = 'blueprint';
		const stack = rng.randint(20, 200) * 100;
		const stacks = Array.from({ length: table }, (_, s) => (s < dealt ? stack : null));
		const deck = shuffle(
			Array.from({ length: 52 }, (_, c) => c),
			rng
		);
		let state = startHand(handConfig(50, 100), stacks, hands % dealt, { deck });
		blueprint.newHand();
		while (!isOver(state)) {
			const seat = state.toAct as number;
			const policy = bots[seats[seat]];
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
	return {
		bundle: nine ? `${values.nine} on ${path}` : path,
		abstraction: nine ? '9max-o1' : bundle.manifest.abstraction,
		checkpoint: bundle.manifest.checkpoint.path ?? 'synthetic',
		load_seconds: Math.round(seconds * 10) / 10,
		hands,
		decisions: times.length,
		decision_ms: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) },
		stats: blueprint.stats
	};
}

const results = loaded.map((l) => bench(l));
if (values.nine !== undefined) {
	const six = loaded.find((l) => l.bundle.graphs.length > 0);
	if (six === undefined)
		throw new Error('--nine needs the six-seat bundle it builds on as a --bundle');
	const started = performance.now();
	const early = loadNineBundle(resolve(values.nine), six.bundle);
	results.push(
		bench(
			{ ...six, seconds: (performance.now() - started) / 1000 },
			new NineSeatPolicy(six.bundle, early)
		)
	);
}
const memory = process.memoryUsage();
console.log(
	JSON.stringify(
		{
			results,
			memory_mb: {
				rss: mb(memory.rss),
				array_buffers: mb(memory.arrayBuffers),
				heap: mb(memory.heapUsed)
			},
			node: process.version
		},
		null,
		2
	)
);
