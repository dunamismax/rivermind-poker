// Clocks for action timers: a port of rivermind/server/clock.py (P4B.5b).
//
// A table reads the time from its clock, and its runner waits for a turn's
// deadline through the same clock. `SystemClock` uses wall-clock time, so a
// deadline saved before a restart still means the same moment after it.
// `ManualClock` only moves when a test calls `advance`, so timer tests never
// sleep.

/** A flag a runner waits on: set by a change, cleared before each step. */
export class Signal {
	private flag = false;
	private waiters: (() => void)[] = [];

	get isSet(): boolean {
		return this.flag;
	}

	set(): void {
		this.flag = true;
		const waiters = this.waiters;
		this.waiters = [];
		for (const wake of waiters) wake();
	}

	clear(): void {
		this.flag = false;
	}

	/** Call `wake` once, when the signal is next set. Returns a function that cancels it. */
	onSet(wake: () => void): () => void {
		if (this.flag) {
			wake();
			return () => {};
		}
		this.waiters.push(wake);
		return () => {
			const at = this.waiters.indexOf(wake);
			if (at !== -1) this.waiters.splice(at, 1);
		};
	}
}

export interface Clock {
	/** Seconds since the epoch. */
	now(): number;
	/**
	 * Wait until `signal` is set or the clock reaches `deadline`. Resolves true
	 * if the signal was set and false on reaching the deadline. With no
	 * deadline, waits for the signal only.
	 */
	wait(signal: Signal, deadline: number | null): Promise<boolean>;
}

/** The longest delay a Node timer takes; longer waits are taken in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export class SystemClock implements Clock {
	now(): number {
		return Date.now() / 1000;
	}

	wait(signal: Signal, deadline: number | null): Promise<boolean> {
		if (signal.isSet) return Promise.resolve(true);
		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | null = null;
			const cancel = signal.onSet(() => {
				if (timer !== null) clearTimeout(timer);
				resolve(true);
			});
			if (deadline === null) return;
			const tick = () => {
				const left = (deadline - this.now()) * 1000;
				if (left <= 0) {
					cancel();
					resolve(signal.isSet);
					return;
				}
				timer = setTimeout(tick, Math.min(left, MAX_TIMER_MS));
			};
			tick();
		});
	}
}

interface Waiter {
	deadline: number;
	id: number;
	reached: () => void;
}

/** A clock that moves only when told to. */
export class ManualClock implements Clock {
	private time: number;
	private waiters: Waiter[] = [];
	private ids = 0;

	constructor(start = 1_000_000) {
		this.time = start;
	}

	now(): number {
		return this.time;
	}

	wait(signal: Signal, deadline: number | null): Promise<boolean> {
		if (signal.isSet) return Promise.resolve(true);
		if (deadline !== null && deadline <= this.time) return Promise.resolve(false);
		return new Promise((resolve) => {
			let waiter: Waiter | null = null;
			const cancel = signal.onSet(() => {
				if (waiter !== null) this.waiters = this.waiters.filter((w) => w !== waiter);
				resolve(true);
			});
			if (deadline === null) return;
			waiter = {
				deadline,
				id: this.ids++,
				reached: () => {
					cancel();
					resolve(signal.isSet);
				}
			};
			this.waiters.push(waiter);
		});
	}

	/** How many waits have a deadline, for tests that wait for a runner to settle. */
	get waiting(): number {
		return this.waiters.length;
	}

	/** Move time forward, releasing every wait whose deadline has passed, earliest first. */
	advance(seconds: number): void {
		this.time += seconds;
		const due = this.waiters
			.filter((w) => w.deadline <= this.time)
			.sort((a, b) => a.deadline - b.deadline || a.id - b.id);
		this.waiters = this.waiters.filter((w) => w.deadline > this.time);
		for (const waiter of due) waiter.reached();
	}
}
