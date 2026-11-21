// The public address the voice service announces in its ICE candidates
// (P4C.4). ubuntu-vm sits behind the home router, so the address a player's
// browser can reach is the router's, not the VM's. The site's own name already
// points there, kept current by the host's dynamic DNS, so the service reads
// it from DNS and looks again every minute: when the router's address changes,
// the media server starts again under the new one (media.ts `announce`).
import { promises as dns } from 'node:dns';
import { isIPv4 } from 'node:net';
import type { Log } from './log.ts';

export type Resolve = (host: string) => Promise<string[]>;

export type AddressWatchOptions = {
	host: string;
	resolve?: Resolve;
	everyMs?: number;
	log: Log;
	// Told each time the address is first known or changes.
	onchange: (address: string) => Promise<void> | void;
};

export class AddressWatch {
	#host: string;
	#resolve: Resolve;
	#everyMs: number;
	#log: Log;
	#onchange: (address: string) => Promise<void> | void;
	#timer: ReturnType<typeof setInterval> | null = null;
	#failing = false;
	current: string | null = null;

	constructor({ host, resolve, everyMs, log, onchange }: AddressWatchOptions) {
		this.#host = host;
		this.#resolve = resolve ?? ((name) => dns.resolve4(name));
		this.#everyMs = everyMs ?? 60_000;
		this.#log = log;
		this.#onchange = onchange;
	}

	// Look the name up now. A failed lookup keeps the address already known.
	async check(): Promise<string | null> {
		let addresses: string[];
		try {
			addresses = (await this.#resolve(this.#host)).filter((one) => isIPv4(one)).sort();
		} catch (error) {
			if (!this.#failing) {
				this.#log(`could not look up the announced name: ${(error as Error).message}`);
			}
			this.#failing = true;
			return this.current;
		}
		if (this.#failing) this.#log('the announced name resolves again');
		this.#failing = false;
		const address = addresses[0] ?? null;
		if (address === null || address === this.current) return this.current;
		const first = this.current === null;
		this.current = address;
		this.#log(first ? 'the public address is known' : 'the public address changed');
		await this.#onchange(address);
		return address;
	}

	start(): void {
		this.#timer ??= setInterval(() => void this.check(), this.#everyMs);
		this.#timer.unref();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
	}
}
