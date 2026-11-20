// Random self-play speed of the TypeScript engine on one core, measured the
// way `python -m rivermind.engine.bench` measures the Python engine (P4B.4):
// every seat starts each hand with 100 big blinds at 50/100, the button moves
// each hand and actions come from the fuzzer's `randomAction`. The `engine`
// mode times only startHand, legalActions and apply; the `view` mode also
// builds a SeatView for every decision.
//
//   node scripts/engine-bench.ts [--seats 2,6,9] [--hands 20000] [--repeats 5] [--seed 0] [--mode engine]

import os from 'node:os';
import { parseArgs } from 'node:util';
import { randomAction } from '../src/lib/server/engine/fuzz.ts';
import { seededRandom } from '../src/lib/server/engine/random.ts';
import { apply, handConfig, legalActions, startHand } from '../src/lib/server/engine/state.ts';
import { seatView } from '../src/lib/server/engine/view.ts';

const TARGET_SIX_SEAT_HANDS_PER_SECOND = 2_000;

// `pnpm engine:… -- --hands 10` passes the `--` through; drop it.
const argv = process.argv.slice(2);
const { values } = parseArgs({
	args: argv[0] === '--' ? argv.slice(1) : argv,
	options: {
		seats: { type: 'string', default: '2,6,9' },
		hands: { type: 'string', default: '20000' },
		repeats: { type: 'string', default: '5' },
		seed: { type: 'string', default: '0' },
		mode: { type: 'string', default: 'engine' }
	}
});
if (values.mode !== 'engine' && values.mode !== 'view') throw new Error('--mode is engine or view');

function play(numSeats: number, hands: number, seed: number): [number, number, number] {
	const rng = seededRandom(seed);
	const config = handConfig(50, 100);
	const stacks = new Array(numSeats).fill(10_000);
	let actions = 0;
	let showdowns = 0;
	const started = performance.now();
	for (let hand = 0; hand < hands; hand++) {
		let state = startHand(config, stacks, hand % numSeats, { rng });
		while (state.toAct !== null) {
			if (values.mode === 'view') seatView(state, state.toAct);
			state = apply(state, randomAction(state, legalActions(state), rng));
			actions++;
		}
		if (state.result!.showdown) showdowns++;
	}
	return [(performance.now() - started) / 1000, actions, showdowns];
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const hands = Number(values.hands);
const repeats = Number(values.repeats);
const seed = Number(values.seed);
// One unmeasured round lets the JIT compile the hot paths first.
play(6, Math.min(hands, 2_000), seed + 1_000);
const results: Record<string, unknown> = {};
for (const numSeats of values.seats.split(',').map(Number)) {
	const rates: [number, number, number, number][] = [];
	for (let repeat = 0; repeat < repeats; repeat++) {
		const [seconds, actions, showdowns] = play(numSeats, hands, seed + repeat);
		rates.push([hands / seconds, actions / seconds, actions, showdowns]);
	}
	const best = rates.reduce((a, b) => (b[0] > a[0] ? b : a));
	results[String(numSeats)] = {
		hands_per_second_median: Math.round(median(rates.map((r) => r[0]))),
		hands_per_second_best: Math.round(best[0]),
		actions_per_second_median: Math.round(median(rates.map((r) => r[1]))),
		actions_per_hand: Math.round((best[2] / hands) * 100) / 100,
		showdown_share: Math.round((best[3] / hands) * 1000) / 1000
	};
}
const six = results['6'] as { hands_per_second_median: number } | undefined;
console.log(
	JSON.stringify(
		{
			mode: values.mode,
			hands_per_repeat: hands,
			repeats,
			seed,
			node: process.version,
			machine: `${os.type()} ${os.arch()}`,
			seat_counts: results,
			target_six_seat_hands_per_second: TARGET_SIX_SEAT_HANDS_PER_SECOND,
			meets_target:
				six === undefined ? null : six.hands_per_second_median >= TARGET_SIX_SEAT_HANDS_PER_SECOND
		},
		null,
		2
	)
);
