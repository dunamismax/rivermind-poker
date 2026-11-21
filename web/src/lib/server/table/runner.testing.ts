// Helpers for the runner and clock tests, the counterparts of those in
// test/server/test_runner.py.
import { expect } from 'vitest';
import { Action } from '../engine/state.ts';
import type { SeatView } from '../engine/view.ts';
import { ManualClock } from './clock.ts';
import {
	runnerOptions,
	seededDealer,
	type BotPolicy,
	type Listener,
	type Log,
	type RunnerOptions
} from './runner.ts';
import type { TableEvent } from './table.ts';

/** Let timers, sockets and every table's loop run. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const silent: Log = { info: () => {}, warn: () => {}, error: () => {} };

export function options(seed = 0, overrides: Partial<RunnerOptions> = {}): RunnerOptions {
	return runnerOptions({
		handPause: 0,
		botDelay: 0,
		sleep: tick,
		clock: new ManualClock(),
		dealer: () => seededDealer(seed),
		log: silent,
		...overrides
	});
}

/** A listener that keeps every published event and checks their order. */
export class Recorder {
	readonly events: TableEvent[] = [];

	readonly listen: Listener = (_runner, events) => {
		for (const event of events) {
			const last = this.events[this.events.length - 1];
			if (last !== undefined) expect(event.seq).toBe(last.seq + 1);
			this.events.push(event);
		}
	};

	kinds(kind: string): TableEvent[] {
		return this.events.filter((e) => e.kind === kind);
	}

	chipsBought(): number {
		let total = 0;
		for (const event of this.events) {
			if (event.kind === 'seated') total += event.data.stack as number;
			else if (event.kind === 'rebought') total += event.data.amount as number;
			else if (event.kind === 'left') total -= event.data.stack as number;
		}
		return total;
	}
}

/** Decides only when released. */
export class BlockingBot implements BotPolicy {
	readonly name = 'blocking';
	calls = 0;
	private waiting: (() => void)[] = [];
	private released = false;

	release(): void {
		this.released = true;
		for (const wake of this.waiting.splice(0)) wake();
	}

	async act(view: SeatView): Promise<Action> {
		this.calls += 1;
		if (!this.released) await new Promise<void>((resolve) => this.waiting.push(resolve));
		return view.legal?.canCheck ? Action.check() : Action.call();
	}
}
