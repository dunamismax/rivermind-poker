// The voice service's own rate limits beyond each socket's (P4C.8): how often
// a player may say hello and how much they may send across all their sockets,
// and how often an address may open a socket. The table server limits the
// tokens that let anyone in (api.ts); these hold even for someone who has many.
//
// Addresses are never logged or kept as they are: a limit's key is a keyed
// hash of the address under a key made for the process, held in memory only.
import { createHmac, randomBytes } from 'node:crypto';

// A token bucket per key: `burst` at once, refilled at `rate` a second.
export class Buckets {
	readonly rate: number;
	readonly burst: number;
	#now: () => number;
	#buckets = new Map<string, { tokens: number; at: number }>();
	#pruned: number;

	constructor(rate: number, burst: number, now: () => number = () => performance.now() / 1000) {
		this.rate = rate;
		this.burst = burst;
		this.#now = now;
		this.#pruned = now();
	}

	allow(key: string, cost = 1): boolean {
		const now = this.#now();
		const held = this.#buckets.get(key);
		const tokens = Math.min(
			this.burst,
			held ? held.tokens + (now - held.at) * this.rate : this.burst
		);
		const allowed = tokens >= cost;
		this.#buckets.set(key, { tokens: allowed ? tokens - cost : tokens, at: now });
		// A bucket that would be full again is the same as none.
		if (now - this.#pruned >= 60) {
			for (const [one, bucket] of this.#buckets) {
				if ((now - bucket.at) * this.rate + bucket.tokens >= this.burst) this.#buckets.delete(one);
			}
			this.#pruned = now;
		}
		return allowed;
	}
}

// What a player and an address may do. A page says hello as it joins voice and
// each time it comes back; a household shares an address.
export const PLAYER_HELLOS = { burst: 20, perSecond: 1 / 3 };
export const PLAYER_MESSAGES = { burst: 120, perSecond: 40 };
export const ADDRESS_SOCKETS = { burst: 30, perSecond: 1 / 2 };

// The address a handshake came from, for its limit. Caddy, on the same
// machine, puts the client's address last in X-Forwarded-For; the header is
// believed only from a loopback peer, so nobody reaching the service directly
// can choose theirs. Null for this machine itself, a loopback peer with no
// such header (the checks, a development server passing /voice on), which
// nothing limits: the service listens on loopback alone, behind Caddy.
export function addressOf(
	peer: string | undefined,
	forwardedFor: string | undefined
): string | null {
	const from = peer ?? 'unknown';
	const loopback = from === '::1' || from.startsWith('127.') || from.startsWith('::ffff:127.');
	if (forwardedFor && loopback) {
		const last = forwardedFor.slice(forwardedFor.lastIndexOf(',') + 1).trim();
		if (last) return last;
	}
	return loopback ? null : from;
}

const processKey = randomBytes(32);

// The key an address's limit is kept under: equal addresses match, and the
// address itself is held nowhere.
export const addressKey = (address: string): string =>
	createHmac('sha256', processKey).update(address, 'utf8').digest('base64url');
