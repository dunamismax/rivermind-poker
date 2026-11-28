/**
 * Which kind of client a request came from, for the aggregate counts of P7.1 and
 * P7.1a (P5D.11): a page of the site or the iPhone app. The app says so in a
 * `RiverMind-Client` header, `ios/<build>`, on every HTTP request and on the `/ws`
 * handshake; a page sends none. The header names the app and its build number,
 * which every copy of that build shares, so it identifies nobody (Q-6).
 *
 * {@link ClientCounts} keeps counts by kind in memory, and nothing else: no id,
 * address or time. P7.1's metrics will read them.
 */

export const CLIENT_HEADER = 'rivermind-client';

export const CLIENT_KINDS = ['site', 'ios'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** The kind of client a `RiverMind-Client` header names: `ios/<build>` is the app, anything else the site. */
export function clientKind(header: string | null | undefined): ClientKind {
	return typeof header === 'string' && /^ios\/[0-9]{1,9}$/.test(header.trim()) ? 'ios' : 'site';
}

/** The app build a `RiverMind-Client` header names, or null for a page or a header that names none. */
export function appBuild(header: string | null | undefined): number | null {
	if (clientKind(header) !== 'ios') return null;
	return Number(header!.trim().slice(4));
}

/** What is counted. */
export const COUNTED = ['guest_made', 'session', 'socket', 'guest_deleted'] as const;
export type Counted = (typeof COUNTED)[number];

export type CountsByClient = Record<Counted, Record<ClientKind, number>>;

/** Counts of what each kind of client did since the process started. */
export class ClientCounts {
	private readonly counts: CountsByClient = Object.fromEntries(
		COUNTED.map((what) => [what, { site: 0, ios: 0 }])
	) as CountsByClient;

	add(what: Counted, client: ClientKind): void {
		this.counts[what][client] += 1;
	}

	/** A copy of every count. */
	snapshot(): CountsByClient {
		return Object.fromEntries(
			COUNTED.map((what) => [what, { ...this.counts[what] }])
		) as CountsByClient;
	}
}
