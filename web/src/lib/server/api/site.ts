/**
 * The site's players, wallets, safety records and hand histories, shared by
 * the HTTP API and, from P4B.5b, the table server and its sockets. It ports
 * the parts of `Server` in `rivermind/server/app.py` that need no running
 * table (P4B.5a).
 *
 * With a database every store is in PostgreSQL through Drizzle; without one
 * they live in memory for as long as the process, as `serve-nl` does.
 */
import type { Database } from '../db/index.ts';
import type * as p from '../../protocol-v2.ts';
import { BOT_LABELS } from '../table/runner.ts';
import { publicRef, readSession, type Secret } from './auth.ts';
import { DatabaseHands, MemoryHands, type HandArchive } from './hands.ts';
import { DatabasePlayers, MemoryPlayers, type PlayerRecord, type PlayerStore } from './players.ts';
import {
	addressTag,
	DatabaseSafety,
	DEFAULT_LIMITS,
	Limiters,
	MemorySafety,
	type Limits,
	type Relation,
	type RelationKind,
	type SafetyStore
} from './safety.ts';
import { wallClock } from './time.ts';
import { DatabaseWallet, MemoryWallet, type Wallet } from './wallet.ts';

/** The labels of the bots the site can offer, by kind. */
export { BOT_LABELS };
/** The bots every server runs, in the order offered. */
export const SIMPLE_BOTS: readonly string[] = ['random', 'calling_station', 'heuristic'];

/** A trained bot this server has loaded: the table sizes it plays and the model behind it (P5.7a). */
export interface TrainedBot {
	seats: readonly number[];
	/** The heads-up model, which pages before P5.7's six seats read. */
	champion: p.BotChampion;
	/** Each format's model with the table sizes it plays, when there is more than one. */
	champions?: readonly p.BotChampion[];
}
/** Table sizes as a reader says them: "2", "2 or 6", "2 to 6". */
export function sizes(seats: readonly number[]): string {
	if (seats.length <= 2) return seats.join(' or ');
	const run = seats.every((n, i) => i === 0 || n === seats[i - 1] + 1);
	return run ? `${seats[0]} to ${seats[seats.length - 1]}` : seats.join(', ');
}

export const STAKES: readonly (readonly [small: number, big: number])[] = [
	[25, 50],
	[50, 100],
	[100, 200],
	[500, 1000]
];
/** 100 big blinds of the practice blinds, given again whenever the guest runs out. */
export const PRACTICE_STACK = 10_000;
export const PRACTICE_BLINDS = [50, 100] as const;

export interface SiteOptions {
	/** Signs session cookies. Keep it private and stable: changing it signs everyone out. */
	secret: Secret;
	/** With a database every store is in PostgreSQL; without one, in memory. */
	db?: Database | null;
	players?: PlayerStore;
	wallet?: Wallet;
	safety?: SafetyStore;
	hands?: HandArchive;
	/** The app's rate limits; {@link DEFAULT_LIMITS} unless tests turn them off with `UNLIMITED`. */
	limits?: Readonly<Limits>;
	/** The bot kinds offered, in order; the simple bots, then the trained ones, by default. */
	bots?: readonly string[];
	/** The trained bots among them, by kind. */
	trained?: Readonly<Record<string, TrainedBot>>;
	practiceStack?: number;
	/** The wall clock in seconds since the epoch. */
	clock?: () => number;
}

export class Site {
	readonly secret: Secret;
	readonly players: PlayerStore;
	readonly wallet: Wallet;
	readonly safety: SafetyStore;
	readonly hands: HandArchive;
	/** The in-memory archive, when there is no database: tables add their hands to it. */
	readonly memoryHands: MemoryHands | null;
	readonly limiters: Limiters;
	readonly bots: readonly string[];
	readonly trained: Readonly<Record<string, TrainedBot>>;
	readonly practiceStack: number;
	readonly clock: () => number;
	/** Player id -> a keyed hash of the address they last came from (P4.5). */
	readonly addresses = new Map<string, string>();
	/** Player id -> the people they muted or blocked, by id, loaded on first use. */
	private readonly related = new Map<string, Map<string, Relation>>();
	/** Handles never change except by moderation, so player records are cached. */
	private readonly known = new Map<string, PlayerRecord>();

	constructor(options: SiteOptions) {
		const practiceStack = options.practiceStack ?? PRACTICE_STACK;
		if (!Number.isSafeInteger(practiceStack) || practiceStack < PRACTICE_BLINDS[1]) {
			throw new RangeError(
				`a practice stack is a whole number of chips, at least ${PRACTICE_BLINDS[1]}`
			);
		}
		const db = options.db ?? null;
		this.secret = options.secret;
		const memoryPlayers = db ? null : new MemoryPlayers();
		this.players = options.players ?? (db ? new DatabasePlayers(db) : memoryPlayers!);
		const clock = options.clock ?? wallClock;
		this.wallet = options.wallet ?? (db ? new DatabaseWallet(db) : new MemoryWallet(clock));
		this.safety =
			options.safety ??
			(db
				? new DatabaseSafety(db)
				: new MemorySafety((id) => this.known.get(id)?.handle ?? memoryPlayers?.handleOf(id)));
		this.memoryHands = options.hands || db ? null : new MemoryHands();
		this.hands = options.hands ?? (db ? new DatabaseHands(db) : this.memoryHands!);
		this.limiters = new Limiters(options.limits ?? DEFAULT_LIMITS);
		this.trained = options.trained ?? {};
		this.bots = options.bots ?? [...SIMPLE_BOTS, ...Object.keys(this.trained)];
		this.practiceStack = practiceStack;
		this.clock = clock;
	}

	/** Whether a bot of `kind` plays tables of `seats`: a trained bot plays only its format's size. */
	botPlays(kind: string, seats: number): boolean {
		return !Object.hasOwn(this.trained, kind) || this.trained[kind].seats.includes(seats);
	}

	/** The bots offered, as `GET /api/config` lists them. */
	botOptions(): p.BotOption[] {
		return this.bots.map((kind) => {
			const option: p.BotOption = { kind, label: BOT_LABELS[kind] ?? kind };
			if (Object.hasOwn(this.trained, kind)) {
				option.seats = [...this.trained[kind].seats];
				option.champion = this.trained[kind].champion;
				const champions = this.trained[kind].champions;
				if (champions) option.champions = champions.map((c) => ({ ...c }));
			}
			return option;
		});
	}

	/** The stored player with this id. */
	async player(playerId: string): Promise<PlayerRecord | null> {
		let record = this.known.get(playerId) ?? null;
		if (!record) {
			record = await this.players.get(playerId);
			if (record) this.known.set(playerId, record);
		}
		return record;
	}

	/** The player a genuine, unexpired session cookie belongs to, and when it was issued. */
	async sessionPlayer(
		cookie: string | null | undefined
	): Promise<{ player: PlayerRecord; issued: number } | null> {
		const session = readSession(this.secret, cookie, this.clock());
		if (!session) return null;
		const player = await this.player(session.playerId);
		return player ? { player, issued: session.issued } : null;
	}

	/** Remember a keyed hash of the address a player came from, for collusion signals. */
	noteAddress(playerId: string, address: string): void {
		this.addresses.set(playerId, addressTag(this.secret, address));
	}

	/** Everyone the player muted or blocked, by id, in the order they did it. */
	async relationsOf(playerId: string): Promise<Map<string, Relation>> {
		let mine = this.related.get(playerId);
		if (!mine) {
			const listed = await this.safety.relations(playerId);
			mine = new Map(listed.map((r) => [r.targetId, r]));
			this.related.set(playerId, mine);
		}
		return mine;
	}

	/** The relations already loaded for a player, without waiting: for filtering reactions. */
	loadedRelations(playerId: string): ReadonlyMap<string, Relation> | undefined {
		return this.related.get(playerId);
	}

	async setRelation(playerId: string, target: PlayerRecord, kind: RelationKind): Promise<void> {
		await this.safety.setRelation(playerId, target.playerId, kind);
		const mine = await this.relationsOf(playerId);
		// A changed relation keeps its place, as a dict entry does.
		mine.set(target.playerId, { targetId: target.playerId, handle: target.handle, kind });
	}

	/** Unmute or unblock the player with public reference `ref`. False if there was none. */
	async removeRelation(playerId: string, ref: string): Promise<boolean> {
		const mine = await this.relationsOf(playerId);
		for (const targetId of mine.keys()) {
			if (publicRef(targetId) === ref) {
				await this.safety.removeRelation(playerId, targetId);
				mine.delete(targetId);
				return true;
			}
		}
		return false;
	}
}
