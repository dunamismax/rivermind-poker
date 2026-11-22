/**
 * Safety and abuse controls (P4.5), ported from `rivermind/server/safety.py` (P4B.5a).
 *
 * - **Rate limits.** {@link RateLimiter} is a token bucket per key, and
 *   {@link Limits} holds the app's limits: unsafe HTTP requests per player
 *   (or per address without a session), new players per address, socket
 *   messages per connection, reactions and reports per player. Caddy limits
 *   the same endpoints per address in front of the app.
 * - **Handles.** {@link handleAllowed} checks every handle the server makes
 *   against blocked words, with letter swaps undone and spaced-out letters
 *   read together.
 * - **Reactions** are the only messages people send each other (Q-4).
 * - **Reports, mutes and blocks.** Players name each other by a public
 *   reference (`publicRef`), never their id. Blocking keeps quick seat from
 *   seating the two together.
 * - **Collusion signals.** Two people at one table from one address raise a
 *   `same_address` signal. Addresses are stored only as keyed hashes.
 * - **Voice reports** (P4C.8). Voice is never recorded, so a report of
 *   something said in voice carries no audio. Voice reports from three people
 *   at three different tables, from three different addresses, within a day
 *   suspend that guest's speaking for a day ({@link speakingDue}); they may
 *   still listen.
 *
 * {@link MemorySafety} keeps reports, relations and signals for a server
 * without a database, and {@link DatabaseSafety} keeps them in PostgreSQL.
 */
import { createHmac } from 'node:crypto';
import { and, asc, desc, eq, gt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/index.ts';
import {
	playerRelations,
	playerReports,
	players,
	safetySignals,
	voiceSuspensions,
	type ReportReason
} from '../db/schema.ts';
import { isLoopbackAddress, type Secret } from './auth.ts';
import { epochOf } from './time.ts';

/** Seconds on a monotonic clock. */
export type Clock = () => number;

export const monotonic: Clock = () => performance.now() / 1000;

/** Token buckets: each key may spend `burst` at once, refilled at `rate` per second. */
export class RateLimiter {
	readonly rate: number;
	readonly burst: number;
	readonly clock: Clock;
	private buckets = new Map<string, [tokens: number, then: number]>();
	private nextPrune: number;

	constructor(rate: number, burst: number, clock: Clock = monotonic) {
		if (!(rate > 0) || !(burst >= 1)) {
			throw new Error('a rate limit needs a positive rate and a burst of at least 1');
		}
		this.rate = rate;
		this.burst = burst;
		this.clock = clock;
		this.nextPrune = clock() + 60;
	}

	/** Spend `cost` from `key`'s bucket if it holds that much. */
	allow(key: string, cost = 1): boolean {
		const now = this.clock();
		const [held, then] = this.buckets.get(key) ?? [this.burst, now];
		let tokens = Math.min(this.burst, held + (now - then) * this.rate);
		const allowed = tokens >= cost;
		if (allowed) tokens -= cost;
		this.buckets.set(key, [tokens, now]);
		if (now >= this.nextPrune) this.prune(now);
		return allowed;
	}

	/** Seconds until `key` may spend one token. */
	retryAfter(key: string): number {
		const [held, then] = this.buckets.get(key) ?? [this.burst, this.clock()];
		const tokens = Math.min(this.burst, held + (this.clock() - then) * this.rate);
		return Math.max(0, (1 - tokens) / this.rate);
	}

	private prune(now: number): void {
		// A bucket that would be full again is the same as no bucket.
		const full = this.burst / this.rate;
		for (const [key, [, then]] of this.buckets) {
			if (now - then >= full) this.buckets.delete(key);
		}
		this.nextPrune = now + 60;
	}
}

/** The app's rate limits. Rates are per second. */
export interface Limits {
	/** Unsafe HTTP requests per player, or per address without a session. */
	httpRate: number;
	httpBurst: number;
	/** Players made (`POST /api/session` without a session) per address. */
	newPlayerRate: number;
	newPlayerBurst: number;
	/** Messages per socket after the hello. */
	socketRate: number;
	socketBurst: number;
	/** Refused messages in a row before the socket is closed. */
	socketStrikes: number;
	/** Reactions per player. */
	reactionRate: number;
	reactionBurst: number;
	/** Reports per player. */
	reportRate: number;
	reportBurst: number;
	/** Voice tokens (`POST /api/tables/{id}/voice`) per player, and per address (P4C.8). */
	voiceRate: number;
	voiceBurst: number;
	voiceAddressRate: number;
	voiceAddressBurst: number;
	clock: Clock;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
	httpRate: 2,
	httpBurst: 60,
	newPlayerRate: 0.5,
	newPlayerBurst: 30,
	socketRate: 10,
	socketBurst: 60,
	socketStrikes: 50,
	reactionRate: 1 / 3,
	reactionBurst: 3,
	reportRate: 1 / 60,
	reportBurst: 5,
	// A page asks for a token as it joins voice and each time it comes back:
	// ten at once, then one every six seconds.
	voiceRate: 1 / 6,
	voiceBurst: 10,
	// Several guests can share an address, as a household does.
	voiceAddressRate: 1 / 2,
	voiceAddressBurst: 30,
	clock: monotonic
});

/** No limits, for tests that send requests faster than people could. */
export const UNLIMITED: Readonly<Limits> = Object.freeze({
	...DEFAULT_LIMITS,
	httpRate: 1e9,
	httpBurst: 1e9,
	newPlayerRate: 1e9,
	newPlayerBurst: 1e9,
	socketRate: 1e9,
	socketBurst: 1e9,
	reactionRate: 1e9,
	reactionBurst: 1e9,
	reportRate: 1e9,
	reportBurst: 1e9,
	voiceRate: 1e9,
	voiceBurst: 1e9,
	voiceAddressRate: 1e9,
	voiceAddressBurst: 1e9
});

/** One {@link RateLimiter} per limit in {@link Limits}. */
export class Limiters {
	readonly limits: Readonly<Limits>;
	readonly http: RateLimiter;
	readonly newPlayer: RateLimiter;
	readonly reaction: RateLimiter;
	readonly report: RateLimiter;
	readonly voice: RateLimiter;
	readonly voiceAddress: RateLimiter;

	constructor(limits: Readonly<Limits> = DEFAULT_LIMITS) {
		this.limits = limits;
		const clock = limits.clock;
		this.http = new RateLimiter(limits.httpRate, limits.httpBurst, clock);
		this.newPlayer = new RateLimiter(limits.newPlayerRate, limits.newPlayerBurst, clock);
		this.reaction = new RateLimiter(limits.reactionRate, limits.reactionBurst, clock);
		this.report = new RateLimiter(limits.reportRate, limits.reportBurst, clock);
		this.voice = new RateLimiter(limits.voiceRate, limits.voiceBurst, clock);
		this.voiceAddress = new RateLimiter(limits.voiceAddressRate, limits.voiceAddressBurst, clock);
	}

	/** A bucket for one socket. */
	socket(): RateLimiter {
		return new RateLimiter(this.limits.socketRate, this.limits.socketBurst, this.limits.clock);
	}
}

// Network addresses

/**
 * The address a request came from.
 *
 * Caddy, on the same machine, puts the client's address last in
 * `X-Forwarded-For` (it replaces whatever the client sent). The header is
 * trusted only from a loopback peer, so a client reaching the app directly
 * cannot choose its own address.
 */
export function clientAddress(
	peer: string | null | undefined,
	forwardedFor: string | null | undefined
): string {
	const from = peer || 'unknown';
	if (forwardedFor && isLoopbackAddress(from)) {
		const last = forwardedFor.slice(forwardedFor.lastIndexOf(',') + 1).trim();
		if (last) return last;
	}
	return from;
}

/** A keyed hash of an address: equal addresses match, but the address is not stored. */
export function addressTag(secret: Secret, address: string): string {
	return createHmac('sha256', secret)
		.update(`address:${address}`, 'utf8')
		.digest('hex')
		.slice(0, 24);
}

// Handles

/** Fragments no word of a handle may contain once letter swaps are undone. */
const BLOCKED_WORDS = [
	'anal', 'anus', 'arse', 'bastard', 'bitch', 'bollock', 'boner', 'boob', 'cock', 'coon',
	'crap', 'cunt', 'dick', 'dildo', 'dyke', 'fag', 'fuck', 'gook', 'homo', 'jizz', 'kike',
	'nazi', 'nigg', 'nigr', 'penis', 'piss', 'porn', 'pussy', 'rape', 'retard', 'shit', 'slut',
	'spic', 'tits', 'twat', 'vagina', 'wank', 'whore', 'hitler', 'kkk'
]; // prettier-ignore
/** Ordinary words that contain a blocked fragment. */
const ALLOWED_WORDS = [
	'peacock',
	'cockatoo',
	'woodcock',
	'scunthorpe',
	'grape',
	'drape',
	'therapist',
	'cocktail'
];
const SWAPS: Record<string, string> = {
	'0': 'o',
	'1': 'i',
	'3': 'e',
	'4': 'a',
	'5': 's',
	'7': 't',
	'8': 'b',
	'@': 'a',
	$: 's',
	'!': 'i',
	'|': 'i'
};

/** The handle's words with accents dropped and letter swaps undone, and letters spelled out one by one joined. */
function words(text: string): string[] {
	const plain = text
		.normalize('NFKD')
		.replace(/[\u0080-\uffff]/g, '')
		.toLowerCase()
		.replace(/[0-9@$!|]/g, (c) => SWAPS[c] ?? c);
	const found: string[] = [];
	let spelled = '';
	for (const token of plain.split(/[^a-z]+/)) {
		if (token.length === 1) {
			spelled += token;
			continue;
		}
		if (spelled) {
			found.push(spelled);
			spelled = '';
		}
		if (token) found.push(token);
	}
	if (spelled) found.push(spelled);
	return found;
}

/**
 * Whether a handle is free of blocked words. Each word is checked on its own
 * (so `Lunar Seal` is not read as `lunarseal`), and letters spaced or dotted
 * apart (`f.u.c.k`) are read as one word.
 */
export function handleAllowed(handle: string): boolean {
	if (!handle.trim() || [...handle].length > 32) return false;
	for (let word of words(handle)) {
		for (const allowed of ALLOWED_WORDS) word = word.replaceAll(allowed, '');
		if (BLOCKED_WORDS.some((blocked) => word.includes(blocked))) return false;
	}
	return true;
}

// Reactions, reports and relations

/** Preset reactions (Q-4: no free-text chat in 1.0), in the order to offer them. */
export const REACTIONS = {
	hello: 'Hi!',
	nice_hand: 'Nice hand',
	well_played: 'Well played',
	good_game: 'Good game',
	unlucky: 'Unlucky',
	thanks: 'Thanks',
	wow: 'Wow',
	thinking: 'Thinking…'
} as const;
export type Reaction = keyof typeof REACTIONS;

export const REPORT_REASONS: readonly ReportReason[] = [
	'handle',
	'abuse',
	'collusion',
	'other',
	'voice'
];
export type { ReportReason };

export const RELATION_KINDS = ['mute', 'block'] as const;
/** `mute` hides their reactions; `block` also keeps quick seat from seating the two together. */
export type RelationKind = (typeof RELATION_KINDS)[number];

/** A player's report of the same person for the same reason counts once a day. */
export const REPORT_REPEAT_SECONDS = 24 * 3600;

export interface Report {
	reporterId: string;
	targetId: string;
	targetHandle: string;
	reason: ReportReason;
	tableId: string | null;
	handNo: number | null;
	/** Seconds since the epoch. */
	at: number;
	/** The reporter's address as a keyed hash ({@link addressTag}), where known (P4C.8). */
	reporterAddress?: string | null;
}

/** How many voice reports, from how many people, tables and addresses, suspend a guest's speaking (P4C.8). */
export const VOICE_REPORTS_TO_SUSPEND = 3;
/** The day within which they must come, and how long the suspension lasts. */
export const VOICE_REPORT_WINDOW_SECONDS = 24 * 3600;
export const VOICE_SUSPENSION_SECONDS = 24 * 3600;
/** How many of a guest's newest voice reports the rule looks through. */
const VOICE_REPORTS_LOOKED_AT = 30;

/**
 * Whether these voice reports against one guest suspend their speaking at
 * `at`: {@link VOICE_REPORTS_TO_SUSPEND} of them from the day before, each
 * from a different person, made at a different table and from a different
 * address. A report without a table or an address cannot count, so a few
 * friends at one table, or one person with several guests on one address,
 * cannot silence anyone.
 */
export function speakingDue(reports: readonly Report[], at: number): boolean {
	const counted = reports
		.filter(
			(one) =>
				one.reason === 'voice' &&
				one.tableId !== null &&
				!!one.reporterAddress &&
				one.at <= at &&
				at - one.at < VOICE_REPORT_WINDOW_SECONDS
		)
		.slice(-VOICE_REPORTS_LOOKED_AT);
	const apart = (chosen: Report[], one: Report) =>
		chosen.every(
			(other) =>
				other.reporterId !== one.reporterId &&
				other.tableId !== one.tableId &&
				other.reporterAddress !== one.reporterAddress
		);
	// The smallest search there is: a few reports, a few to choose.
	const choose = (from: number, chosen: Report[]): boolean => {
		if (chosen.length === VOICE_REPORTS_TO_SUSPEND) return true;
		for (let index = from; index < counted.length; index += 1) {
			if (apart(chosen, counted[index]) && choose(index + 1, [...chosen, counted[index]])) {
				return true;
			}
		}
		return false;
	};
	return choose(0, []);
}

export interface Relation {
	targetId: string;
	handle: string;
	kind: RelationKind;
}

export interface Signal {
	kind: 'same_address';
	tableId: string | null;
	playerIds: readonly string[];
	detail: Record<string, unknown>;
	at: number;
}

export interface SafetyStore {
	/** Record a report. False if the same one was made within a day. */
	report(report: Report): Promise<boolean>;
	/** Everyone `playerId` has muted or blocked, oldest first. */
	relations(playerId: string): Promise<Relation[]>;
	setRelation(playerId: string, targetId: string, kind: RelationKind): Promise<void>;
	removeRelation(playerId: string, targetId: string): Promise<void>;
	/** Players `playerId` blocked or was blocked by. */
	blocksInvolving(playerId: string): Promise<Set<string>>;
	signal(signal: Signal): Promise<void>;
	/** The newest reports first. */
	reports(limit: number): Promise<Report[]>;
	/** The newest signals first. */
	signals(limit: number): Promise<Signal[]>;
	/** Voice reports against `targetId` made since `since`, oldest first (P4C.8). */
	voiceReportsAgainst(targetId: string, since: number): Promise<Report[]>;
	/** Suspend `playerId`'s speaking in voice until `until`, unless it already lasts longer. */
	suspendSpeaking(playerId: string, until: number): Promise<void>;
	/** When `playerId`'s speaking suspension ends, if it has not ended by `at`. */
	speakingSuspendedUntil(playerId: string, at: number): Promise<number | null>;
	/** Speaking suspensions not ended by `at`, the latest to end first. */
	suspensions(at: number): Promise<{ playerId: string; until: number }[]>;
	/** End `playerId`'s speaking suspension now (a moderator's call). False if there was none. */
	liftSuspension(playerId: string): Promise<boolean>;
}

/**
 * Record a voice report's effect: when it completes {@link speakingDue}, the
 * guest's speaking is suspended for a day from now. Returns when the
 * suspension ends, or null when this report changed nothing.
 */
export async function suspendIfDue(
	store: SafetyStore,
	targetId: string,
	at: number
): Promise<number | null> {
	const reports = await store.voiceReportsAgainst(targetId, at - VOICE_REPORT_WINDOW_SECONDS);
	if (!speakingDue(reports, at)) return null;
	const until = at + VOICE_SUSPENSION_SECONDS;
	const before = await store.speakingSuspendedUntil(targetId, at);
	if (before !== null && before >= until) return null;
	await store.suspendSpeaking(targetId, until);
	return until;
}

/** Reports, relations and signals for a server without a database. */
export class MemorySafety implements SafetyStore {
	private readonly handles: (playerId: string) => string | null | undefined;
	private readonly kept: Report[] = [];
	private readonly related = new Map<string, Map<string, RelationKind>>();
	private readonly raised: Signal[] = [];
	private readonly suspended = new Map<string, number>();

	constructor(handles: (playerId: string) => string | null | undefined = () => null) {
		this.handles = handles;
	}

	async report(report: Report): Promise<boolean> {
		for (const old of this.kept) {
			if (
				old.reporterId === report.reporterId &&
				old.targetId === report.targetId &&
				old.reason === report.reason &&
				report.at - old.at < REPORT_REPEAT_SECONDS
			) {
				return false;
			}
		}
		this.kept.push({ ...report });
		return true;
	}

	async relations(playerId: string): Promise<Relation[]> {
		const mine = this.related.get(playerId) ?? new Map<string, RelationKind>();
		return [...mine].map(([targetId, kind]) => ({
			targetId,
			handle: this.handles(targetId) ?? '',
			kind
		}));
	}

	async setRelation(playerId: string, targetId: string, kind: RelationKind): Promise<void> {
		let mine = this.related.get(playerId);
		if (!mine) this.related.set(playerId, (mine = new Map()));
		mine.set(targetId, kind);
	}

	async removeRelation(playerId: string, targetId: string): Promise<void> {
		this.related.get(playerId)?.delete(targetId);
	}

	async blocksInvolving(playerId: string): Promise<Set<string>> {
		const found = new Set<string>();
		for (const [target, kind] of this.related.get(playerId) ?? []) {
			if (kind === 'block') found.add(target);
		}
		for (const [owner, theirs] of this.related) {
			if (theirs.get(playerId) === 'block') found.add(owner);
		}
		return found;
	}

	async signal(signal: Signal): Promise<void> {
		this.raised.push({ ...signal, playerIds: [...signal.playerIds] });
	}

	async reports(limit: number): Promise<Report[]> {
		return [...this.kept].reverse().slice(0, limit);
	}

	async signals(limit: number): Promise<Signal[]> {
		return [...this.raised].reverse().slice(0, limit);
	}

	async voiceReportsAgainst(targetId: string, since: number): Promise<Report[]> {
		return this.kept
			.filter((one) => one.targetId === targetId && one.reason === 'voice' && one.at > since)
			.map((one) => ({ ...one }));
	}

	async suspendSpeaking(playerId: string, until: number): Promise<void> {
		this.suspended.set(playerId, Math.max(until, this.suspended.get(playerId) ?? 0));
	}

	async speakingSuspendedUntil(playerId: string, at: number): Promise<number | null> {
		const until = this.suspended.get(playerId);
		return until !== undefined && until > at ? until : null;
	}

	async suspensions(at: number): Promise<{ playerId: string; until: number }[]> {
		return [...this.suspended]
			.filter(([, until]) => until > at)
			.map(([playerId, until]) => ({ playerId, until }))
			.sort((a, b) => b.until - a.until);
	}

	async liftSuspension(playerId: string): Promise<boolean> {
		return this.suspended.delete(playerId);
	}
}

/** Reports, relations and signals in PostgreSQL. */
export class DatabaseSafety implements SafetyStore {
	readonly db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	async report(report: Report): Promise<boolean> {
		const since = new Date((report.at - REPORT_REPEAT_SECONDS) * 1000);
		return this.db.transaction(async (tx) => {
			// One report a day per reporter, target and reason; the lock keeps two at once from both counting.
			await tx
				.select({ id: players.id })
				.from(players)
				.where(eq(players.id, report.reporterId))
				.for('update');
			const repeat = await tx
				.select({ id: playerReports.id })
				.from(playerReports)
				.where(
					and(
						eq(playerReports.reporterId, report.reporterId),
						eq(playerReports.targetId, report.targetId),
						eq(playerReports.reason, report.reason),
						gt(playerReports.createdAt, since)
					)
				)
				.limit(1);
			if (repeat.length) return false;
			await tx.insert(playerReports).values({
				reporterId: report.reporterId,
				targetId: report.targetId,
				targetHandle: report.targetHandle,
				reason: report.reason,
				tableId: report.tableId,
				handNo: report.handNo,
				createdAt: new Date(report.at * 1000),
				reporterAddress: report.reporterAddress ?? null
			});
			return true;
		});
	}

	async relations(playerId: string): Promise<Relation[]> {
		const rows = await this.db
			.select({
				targetId: playerRelations.targetId,
				handle: players.handle,
				kind: playerRelations.kind
			})
			.from(playerRelations)
			.innerJoin(players, eq(players.id, playerRelations.targetId))
			.where(eq(playerRelations.playerId, playerId))
			.orderBy(asc(playerRelations.createdAt));
		return rows;
	}

	async setRelation(playerId: string, targetId: string, kind: RelationKind): Promise<void> {
		await this.db
			.insert(playerRelations)
			.values({ playerId, targetId, kind })
			.onConflictDoUpdate({
				target: [playerRelations.playerId, playerRelations.targetId],
				set: { kind }
			});
	}

	async removeRelation(playerId: string, targetId: string): Promise<void> {
		await this.db
			.delete(playerRelations)
			.where(and(eq(playerRelations.playerId, playerId), eq(playerRelations.targetId, targetId)));
	}

	async blocksInvolving(playerId: string): Promise<Set<string>> {
		const rows = await this.db
			.select({ owner: playerRelations.playerId, target: playerRelations.targetId })
			.from(playerRelations)
			.where(
				and(
					eq(playerRelations.kind, 'block'),
					or(eq(playerRelations.playerId, playerId), eq(playerRelations.targetId, playerId))
				)
			);
		return new Set(rows.map((r) => (r.owner === playerId ? r.target : r.owner)));
	}

	async signal(signal: Signal): Promise<void> {
		await this.db.insert(safetySignals).values({
			kind: signal.kind,
			tableId: signal.tableId,
			playerIds: [...signal.playerIds],
			detail: signal.detail,
			createdAt: new Date(signal.at * 1000)
		});
	}

	async reports(limit: number): Promise<Report[]> {
		const rows = await this.db
			.select({
				reporterId: playerReports.reporterId,
				targetId: playerReports.targetId,
				targetHandle: playerReports.targetHandle,
				reason: playerReports.reason,
				tableId: playerReports.tableId,
				handNo: playerReports.handNo,
				at: epochOf(playerReports.createdAt)
			})
			.from(playerReports)
			.orderBy(desc(playerReports.id))
			.limit(limit);
		return rows;
	}

	async signals(limit: number): Promise<Signal[]> {
		const rows = await this.db
			.select({
				kind: safetySignals.kind,
				tableId: safetySignals.tableId,
				playerIds: safetySignals.playerIds,
				detail: safetySignals.detail,
				at: epochOf(safetySignals.createdAt)
			})
			.from(safetySignals)
			.orderBy(desc(safetySignals.id))
			.limit(limit);
		return rows;
	}

	async voiceReportsAgainst(targetId: string, since: number): Promise<Report[]> {
		return this.db
			.select({
				reporterId: playerReports.reporterId,
				targetId: playerReports.targetId,
				targetHandle: playerReports.targetHandle,
				reason: playerReports.reason,
				tableId: playerReports.tableId,
				handNo: playerReports.handNo,
				at: epochOf(playerReports.createdAt),
				reporterAddress: playerReports.reporterAddress
			})
			.from(playerReports)
			.where(
				and(
					eq(playerReports.targetId, targetId),
					eq(playerReports.reason, 'voice'),
					gt(playerReports.createdAt, new Date(since * 1000))
				)
			)
			.orderBy(asc(playerReports.id));
	}

	async suspendSpeaking(playerId: string, until: number): Promise<void> {
		const ends = new Date(until * 1000);
		await this.db
			.insert(voiceSuspensions)
			.values({ playerId, until: ends })
			.onConflictDoUpdate({
				target: voiceSuspensions.playerId,
				set: { until: sql`greatest(${voiceSuspensions.until}, excluded.until)` }
			});
	}

	async speakingSuspendedUntil(playerId: string, at: number): Promise<number | null> {
		const [row] = await this.db
			.select({ until: epochOf(voiceSuspensions.until) })
			.from(voiceSuspensions)
			.where(
				and(
					eq(voiceSuspensions.playerId, playerId),
					gt(voiceSuspensions.until, new Date(at * 1000))
				)
			);
		return row?.until ?? null;
	}

	async suspensions(at: number): Promise<{ playerId: string; until: number }[]> {
		return this.db
			.select({ playerId: voiceSuspensions.playerId, until: epochOf(voiceSuspensions.until) })
			.from(voiceSuspensions)
			.where(gt(voiceSuspensions.until, new Date(at * 1000)))
			.orderBy(desc(voiceSuspensions.until));
	}

	async liftSuspension(playerId: string): Promise<boolean> {
		const gone = await this.db
			.delete(voiceSuspensions)
			.where(eq(voiceSuspensions.playerId, playerId))
			.returning({ playerId: voiceSuspensions.playerId });
		return gone.length > 0;
	}
}

/** Every unordered pair of distinct ids, each sorted. */
export function pairs(ids: Iterable<string>): [string, string][] {
	const unique = [...new Set(ids)].sort();
	const found: [string, string][] = [];
	unique.forEach((a, i) => {
		for (const b of unique.slice(i + 1)) found.push([a, b]);
	});
	return found;
}
