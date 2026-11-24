/**
 * The {@link Site}, the tables, the API handler and the socket server of a
 * running Node server, made from its environment (P4B.5a, P4B.5b).
 *
 * Environment, named as `serve-nl` named its options:
 *   RIVERMIND_SECRET           the secret that signs session cookies, or
 *   RIVERMIND_SECRET_FILE      a file holding it, made (0600) if missing. The
 *                              live server's is /var/lib/rivermind-poker/secret;
 *                              without either, sessions last until a restart.
 *   DATABASE_URL               PostgreSQL for players, wallets, safety, hands and
 *                              the tables themselves, which are then restored at
 *                              start-up; without one everything lives in memory.
 *   RIVERMIND_ALLOWED_ORIGINS  other origins whose pages may use the API, comma-separated.
 *   RIVERMIND_VOICE_URL        the voice service on loopback, such as http://127.0.0.1:4323
 *                              (P4C.5): with it, seated people get voice tokens and the
 *                              voice service hears who each table has in voice.
 *   RIVERMIND_VOICE_OFFER=1    pages offer table voice (GET /api/voice, P4C.6). Set it
 *                              only where a page reaches the voice service on /voice:
 *                              Caddy's route (P4C.9), or RIVERMIND_VOICE_PROXY in
 *                              development and the browser tests (server/index.ts).
 *   RIVERMIND_PRACTICE_STACK   the chips a practice table gives (10,000).
 *   RIVERMIND_HAND_PAUSE       seconds between hands (3).
 *   RIVERMIND_BOT_DELAY        seconds a bot waits before acting (0.6).
 *   RIVERMIND_MAX_TABLES       the most tables open at once (200).
 *   RIVERMIND_MODELS           the directory of promoted models, each in
 *                              `<name>/bundle` as `rivermind-poker blueprint promote`
 *                              keeps them (/srv/rivermind-poker/models/champions on
 *                              the live server). With it, the heads-up champion of
 *                              the registry plays as RiverMind Hard, once its bundle
 *                              has been checked against the registry (P5.7a), and as
 *                              half of RiverMind Medium where the registry records
 *                              Medium's evaluation for it (P5.7). The six-seat
 *                              champion, when the registry has one, plays their hands
 *                              of three to six players at tables of three to six
 *                              seats; their hands of two stay the heads-up one's.
 *                              Without it, or if the check fails, the site runs
 *                              without that bot or format.
 *   RIVERMIND_CHAMPIONS        a registry extract to check bundles against instead of
 *                              the one this build was made with; for tests that serve
 *                              a synthetic bundle.
 *
 * With `RIVERMIND_API=1`, `server/index.ts` makes one at start-up, restores
 * the saved tables and serves the API ahead of SvelteKit's handler and the
 * sockets on `/ws`. A release candidate (`RIVERMIND_CANDIDATE=1`) makes one
 * too but never starts it: it only answers `candidateChecks` on /healthz.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	championFor,
	ChampionPolicy,
	HARD,
	loadChampion,
	loadNineChampion,
	MEDIUM,
	MediumPolicy,
	MULTIWAY_LEAST,
	readRegistry,
	REGISTRY,
	type Champion,
	type ChampionEvaluation,
	type ChampionRegistry,
	type LoadedChampion,
	type LoadedNine
} from '../bots/champions.ts';
import { SEATS as NINE_SEATS } from '../bots/nine.ts';
import { defaultBots } from '../bots/policies.ts';
import type * as p from '../../protocol-v2.ts';
import { createDatabase, createPool } from '../db/index.ts';
import {
	BOT_LABELS,
	consoleLog,
	type BotPolicy,
	type Log,
	type RunnerOptions
} from '../table/runner.ts';
import { TableStore } from '../table/store.ts';
import { createApi, type ApiHandler } from './api.ts';
import type { Secret } from './auth.ts';
import { Site, sizes, type TrainedBot } from './site.ts';
import { createSocketServer, type SocketServer } from './socket.ts';
import { Tables } from './tables.ts';
import { Voice, httpVoiceLink } from './voice.ts';
import { voiceKey } from '../voice/tokens.ts';

export const SECRET_ENV = 'RIVERMIND_SECRET';
export const SECRET_FILE_ENV = 'RIVERMIND_SECRET_FILE';

type Env = Record<string, string | undefined>;

/** The session secret from `RIVERMIND_SECRET` or a file, made if missing, as `serve-nl` loads it. */
export function loadSecret(env: Env = process.env): Secret | null {
	const value = env[SECRET_ENV];
	if (value) return Buffer.from(value, 'utf8');
	const file = env[SECRET_FILE_ENV];
	if (!file) return null;
	if (!existsSync(file)) {
		mkdirSync(dirname(file), { recursive: true });
		try {
			const fd = openSync(file, 'wx', 0o600);
			writeSync(fd, randomBytes(32).toString('hex') + '\n');
			closeSync(fd);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
	}
	return Buffer.from(readFileSync(file, 'utf8').trim(), 'utf8');
}

export interface Runtime {
	site: Site;
	tables: Tables;
	api: ApiHandler;
	sockets: SocketServer;
	/** Restore the saved tables. Call before serving. */
	start(): Promise<void>;
	/** Stop the tables, letting changes in flight finish, and close the database pool, if any. */
	close(): Promise<void>;
	/** /healthz's checks for the live server: `database`, a query through the pool, when there is one. */
	checks: Record<string, () => Promise<boolean>>;
	/**
	 * A release candidate's checks (RIVERMIND_CANDIDATE=1): `database`, `tables`
	 * (every saved open table can be restored, {@link Tables.restorable}) and,
	 * with RIVERMIND_MODELS, `champions` (every champion the registry has for a
	 * format the server plays was loaded).
	 */
	candidateChecks: Record<string, () => Promise<boolean>>;
}

/** A setting that must be a number no smaller than `least`, or missing. */
function numberFrom(env: Env, name: string, least: number): number | undefined {
	const text = env[name];
	if (text === undefined || text === '') return undefined;
	const value = Number(text);
	if (!Number.isFinite(value) || value < least) {
		throw new RangeError(`${name} must be a number of at least ${least}, not ${text}`);
	}
	return value;
}

/**
 * A champion as `GET /api/config` describes it: the gate's matchups for the
 * strategy the site serves, and with `seats` the table sizes it plays.
 */
export function describeChampion(champion: Champion, seats?: readonly number[]): p.BotChampion {
	const served =
		champion.evaluations.find((e) => e.candidate === 'bundle') ?? champion.evaluations[0];
	return described(
		champion,
		(served?.results ?? []).filter((r) => r.gate),
		seats
	);
}

/** The opponents a Medium's description names: the gate's two bots and its own champion. */
const LEVEL_OPPONENTS = ['heuristic', 'calling_station', HARD];

/** RiverMind Medium as `GET /api/config` describes it: its own evaluation at 100 big blinds (P5.7). */
export function describeMedium(champion: Champion, seats?: readonly number[]): p.BotChampion {
	const evaluation: ChampionEvaluation | undefined = champion.levels?.medium?.evaluation;
	const rows = (evaluation?.results ?? []).filter((r) => r.stack_bb === 100);
	return described(
		champion,
		LEVEL_OPPONENTS.flatMap((kind) => rows.filter((r) => r.opponent === kind)),
		seats
	);
}

function described(
	champion: Champion,
	rows: ChampionEvaluation['results'],
	seats?: readonly number[]
): p.BotChampion {
	return {
		...(seats ? { seats: [...seats] } : {}),
		name: champion.name,
		promoted: champion.promoted,
		iterations: champion.iterations,
		stack_bb: rows[0]?.stack_bb ?? 100,
		results: rows.map((r) => ({
			opponent: r.opponent,
			label:
				r.opponent === 'champion'
					? 'the champion before it'
					: (BOT_LABELS[r.opponent] ?? r.opponent),
			hands: r.hands,
			bb_per_100: r.bb_per_100,
			ci95: [...r.ci95]
		}))
	};
}

export interface Trained {
	/** The trained bots' policies, by kind, to add to the simple bots. */
	bots: Record<string, BotPolicy>;
	trained: Record<string, TrainedBot>;
	/** Champions the registry has for a format this server plays whose bundle could not be loaded. */
	failed?: string[];
}

/** The multiway table sizes the server serves a champion for; heads-up is always served. */
export const MULTIWAY_SERVED = [6];

/**
 * The trained bots this server can run (P5.7a, P5.7): the registry's heads-up
 * champion as RiverMind Hard, when `RIVERMIND_MODELS` holds its bundle and
 * every file is the registered one, and with it the six-seat champion for
 * hands of three to six players. RiverMind Medium is the same for each
 * champion whose Medium is recorded. A bundle that is missing or fails the
 * check is reported and left out, so the site still starts: without the
 * heads-up champion there is no trained bot, and without the six-seat one
 * they play two seats only.
 */
export function loadTrained(env: Env = process.env, log: Log = consoleLog): Trained {
	const found: Trained = { bots: {}, trained: {} };
	const models = env.RIVERMIND_MODELS;
	if (!models) return found;
	let registry: ChampionRegistry;
	let heads: LoadedChampion;
	try {
		registry = env.RIVERMIND_CHAMPIONS ? readRegistry(env.RIVERMIND_CHAMPIONS) : REGISTRY;
		const champion = championFor(registry, 2);
		if (champion === null) {
			log.warn('RIVERMIND_MODELS is set, but the registry has no heads-up champion');
			return found;
		}
		const started = performance.now();
		heads = { champion, bundle: loadChampion(models, champion) };
		logLoaded(heads, log, started);
	} catch (error) {
		log.error(
			`Could not load the champion from ${models}; ${BOT_LABELS[HARD]} is not offered`,
			error
		);
		return found;
	}
	const failed: string[] = [];
	let multi: LoadedChampion | null = null;
	for (const seats of MULTIWAY_SERVED) {
		const champion = championFor(registry, seats);
		if (champion === null) continue;
		try {
			const started = performance.now();
			multi = { champion, bundle: loadChampion(models, champion) };
			logLoaded(multi, log, started);
		} catch (error) {
			failed.push(champion.name);
			log.error(
				`Could not load the ${champion.format} champion ${champion.name} from ${models}; ` +
					`the trained bots play two seats only`,
				error
			);
		}
	}
	let nine: LoadedNine | null = null;
	const nineChampion = championFor(registry, NINE_SEATS);
	if (nineChampion !== null && multi !== null && nineChampion.builds_on !== multi.champion.name) {
		// A newer six-seat champion: the nine-seat model must be trained again on it before it is served.
		log.warn(
			`The ${nineChampion.format} model ${nineChampion.name} builds on ${nineChampion.builds_on}, ` +
				`not the six-seat champion ${multi.champion.name}; the trained bots play at most six seats`
		);
	} else if (nineChampion !== null) {
		try {
			if (multi === null)
				throw new Error(`it builds on ${nineChampion.builds_on}, which is not loaded`);
			const started = performance.now();
			nine = { champion: nineChampion, bundle: loadNineChampion(models, nineChampion, multi) };
			const seconds = ((performance.now() - started) / 1000).toFixed(1);
			log.info(
				`${BOT_LABELS[HARD]} plays ${nineChampion.name}: early table ${nine.bundle.path} checked against the registry in ${seconds} s ` +
					`(early.u8 ${nineChampion.bundle.files['early.u8']}, on ${multi.champion.name})`
			);
		} catch (error) {
			failed.push(nineChampion.name);
			log.error(
				`Could not load the ${nineChampion.format} model ${nineChampion.name} from ${models}; ` +
					`the trained bots play at most ${multi?.champion.seats ?? 2} seats`,
				error
			);
		}
	}
	if (failed.length) found.failed = failed;
	const one = heads.champion;
	// Medium first, so the bots are offered from the easiest up.
	if (MediumPolicy.recorded(one)) {
		const mediumMulti = multi !== null && MediumPolicy.recorded(multi.champion) ? multi : null;
		const mediumNine =
			mediumMulti !== null && nine !== null && MediumPolicy.recorded(nine.champion) ? nine : null;
		const policy = new MediumPolicy(one, heads.bundle, mediumMulti, mediumNine);
		found.bots[MEDIUM] = policy;
		found.trained[MEDIUM] = trainedBot(
			policy.seats,
			heads,
			mediumMulti,
			describeMedium,
			mediumNine
		);
		log.info(
			`${BOT_LABELS[MEDIUM]} plays half its hands as ${one.name}` +
				(mediumMulti ? ` (or ${mediumMulti.champion.name} with three or more dealt in` : '') +
				(mediumNine ? `, ${mediumNine.champion.name} with seven or more` : '') +
				(mediumMulti ? ')' : '') +
				` and half as ${BOT_LABELS.heuristic}`
		);
		if (multi !== null && mediumMulti === null) {
			log.info(
				`${BOT_LABELS[MEDIUM]} plays two seats only: the registry records no evaluation of it for ${multi.champion.name}`
			);
		} else if (nine !== null && mediumNine === null) {
			log.info(
				`${BOT_LABELS[MEDIUM]} plays at most six seats: the registry records no evaluation of it for ${nine.champion.name}`
			);
		}
	} else {
		log.info(
			`${BOT_LABELS[MEDIUM]} is not offered: the registry records no evaluation of it for ${one.name}`
		);
	}
	const hard = new ChampionPolicy(one, heads.bundle, multi, nine);
	found.bots[HARD] = hard;
	found.trained[HARD] = trainedBot(hard.seats, heads, multi, describeChampion, hard.nine);
	log.info(
		`${BOT_LABELS[HARD]} plays tables of ${sizes(hard.seats)} seats: ${one.name} with two dealt in` +
			(multi ? `, ${multi.champion.name} with three or more` : '') +
			(hard.nine ? `, ${hard.nine.champion.name} with seven or more` : '')
	);
	return found;
}

function logLoaded({ champion, bundle }: LoadedChampion, log: Log, started: number): void {
	const seconds = ((performance.now() - started) / 1000).toFixed(1);
	log.info(
		`${BOT_LABELS[HARD]} plays ${champion.name}: bundle ${bundle.path} checked against the registry in ${seconds} s ` +
			`(strategy.u8 ${champion.bundle.files['strategy.u8']}, table set ${champion.bundle.table_set})`
	);
}

/** A trained bot as `GET /api/config` lists it: the heads-up champion's description first, as pages before P5.7's six seats read it. */
function trainedBot(
	seats: readonly number[],
	heads: LoadedChampion,
	multi: LoadedChampion | null,
	describe: (champion: Champion, seats?: readonly number[]) => p.BotChampion,
	nine: LoadedNine | null = null
): TrainedBot {
	const bot: TrainedBot = { seats: [...seats], champion: describe(heads.champion) };
	if (multi !== null) {
		bot.champions = [
			describe(heads.champion, [2]),
			describe(
				multi.champion,
				seats.filter((n) => n >= MULTIWAY_LEAST && n <= multi.champion.seats)
			),
			...(nine === null
				? []
				: [
						describe(
							nine.champion,
							seats.filter((n) => n > multi.champion.seats)
						)
					])
		];
	}
	return bot;
}

export function createRuntime(env: Env = process.env): Runtime {
	let secret = loadSecret(env);
	if (!secret) {
		console.warn('No secret given: sessions will not survive a restart');
		secret = randomBytes(32);
	}
	const url = env.DATABASE_URL;
	const pool = url ? createPool(url) : null;
	if (!pool)
		console.warn('No DATABASE_URL: players, wallets and tables will not survive a restart');
	const db = pool ? createDatabase(pool) : null;
	const { bots: trainedBots, trained, failed } = loadTrained(env);
	const site = new Site({
		secret,
		db,
		trained,
		practiceStack: numberFrom(env, 'RIVERMIND_PRACTICE_STACK', 1)
	});
	const runner: Partial<RunnerOptions> = {};
	const handPause = numberFrom(env, 'RIVERMIND_HAND_PAUSE', 0);
	const botDelay = numberFrom(env, 'RIVERMIND_BOT_DELAY', 0);
	if (handPause !== undefined) runner.handPause = handPause;
	if (botDelay !== undefined) runner.botDelay = botDelay;
	const log = consoleLog;
	const voice = env.RIVERMIND_VOICE_URL
		? new Voice({
				secret,
				link: httpVoiceLink(env.RIVERMIND_VOICE_URL, voiceKey(secret), log),
				blocksOf: (playerId) => site.safety.blocksInvolving(playerId),
				silencedUntil: (playerId) => site.safety.speakingSuspendedUntil(playerId, site.clock()),
				now: () => Date.now() / 1000,
				log
			})
		: null;
	const tables = new Tables(site, {
		bots: { ...defaultBots(), ...trainedBots },
		runner,
		maxTables: numberFrom(env, 'RIVERMIND_MAX_TABLES', 1),
		store: db ? new TableStore(db) : null,
		voice
	});
	const checks: Record<string, () => Promise<boolean>> = {};
	if (pool) checks.database = async () => (await pool.query('select 1 as ok')).rows[0]?.ok === 1;
	const candidateChecks: Record<string, () => Promise<boolean>> = {
		...checks,
		tables: () => tables.restorable()
	};
	if (env.RIVERMIND_MODELS) {
		candidateChecks.champions = async () => HARD in trainedBots && !failed?.length;
	}
	const allowedOrigins = (env.RIVERMIND_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
	return {
		site,
		tables,
		api: createApi(site, {
			allowedOrigins,
			tables,
			voiceOffered: env.RIVERMIND_VOICE_OFFER === '1'
		}),
		sockets: createSocketServer(tables, { allowedOrigins }),
		checks,
		candidateChecks,
		start: () => tables.start(),
		close: async () => {
			await tables.stop();
			await pool?.end();
		}
	};
}
