// Replays the session recorded from serve-nl by
// test/server/export_table_contract.py against the TypeScript table server
// (P4B.5b): the same HTTP requests, socket messages, clock changes and turns,
// expecting the same answers. HTTP responses are compared as text; socket
// messages by the digest of their canonical JSON.
//
// When a digest differs, record the session again with every message
// (`python -m test.server.export_table_contract --full /tmp/full.json`) and
// set TABLE_CONTRACT_FULL to that file: the failure then names the field.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { ManualClock } from '../table/clock.ts';
import { digest, firstDifference } from '../table/parity.ts';
import type { SiteOptions } from './site.ts';
import { TestServer, type Message, type Socket, type TableMessage } from './tables.testing.ts';
import type { TableStorage } from '../table/store.ts';

interface Result {
	response?: { status: number; headers: Record<string, string>; body: string };
	received?: Record<string, string[]>;
	messages?: Record<string, unknown[]>;
	acted?: [socket: string, action: string, seq: number][];
}

export interface Step {
	do: 'http' | 'open' | 'send' | 'close' | 'advance' | 'auto';
	as?: string | null;
	method?: string;
	path?: string;
	body?: string;
	headers?: Record<string, string>;
	socket?: string;
	text?: string;
	seconds?: number;
	table?: string;
	turns?: number;
	result: Result;
}

export interface TableContract {
	secret: string;
	now: number;
	seed: number;
	players: Record<string, { id: string; address: string; cookie: string }>;
	steps: Step[];
}

export const tableContract = JSON.parse(
	readFileSync(new URL('./table-contract.json', import.meta.url), 'utf8')
) as TableContract;

const fullPath = process.env.TABLE_CONTRACT_FULL;
const full = fullPath ? (JSON.parse(readFileSync(fullPath, 'utf8')) as TableContract) : null;

const HEADERS = ['content-type', 'set-cookie', 'retry-after', 'allow'];
const numbered = (prefix: string) => {
	let n = 0;
	return () => `${prefix}-contract-${String(++n).padStart(2, '0')}`;
};

/**
 * A socket message without what the two servers word differently: an illegal
 * action's message describes the action and the legal ones, in Python's
 * `repr` there and in plain words here. Clients branch on the code.
 */
function comparable(message: Message): Message {
	return message.type === 'error' && message.code === 'illegal_action'
		? ({ ...message, message: '*' } as unknown as Message)
		: message;
}

/** Check, call up to ten big blinds, or fold: what both servers' tests play. */
function nextAction(view: p.TableView): string {
	const legal = view.you.legal as p.Legal;
	if (legal.can_check) return 'check';
	if (legal.call <= 10 * view.settings.big_blind || !legal.can_fold) return 'call';
	return 'fold';
}

export interface ContractOptions {
	site?: Partial<SiteOptions>;
	store?: TableStorage | null;
	/** Drops what a store decides for itself, such as stored times, from an HTTP body. */
	ignore?: (path: string, body: string) => string;
	/**
	 * Told where a socket's messages differ from the recording, in place of failing: for
	 * reading a deliberate change before the fixture is updated by hand (BUILD.md says why
	 * each time). `digests` are of every message that socket got in the step.
	 */
	differs?: (step: number, socket: string, digests: string[], messages: Message[]) => void;
	/** Given every message a socket got in a step, for fixtures written from the session (P5D.2). */
	seen?: (step: number, socket: string, messages: Message[]) => void;
}

/** The session's server: its clocks, decks, ids and players fixed as the recording's were. */
export async function contractServer(options: ContractOptions = {}): Promise<TestServer> {
	const contract = tableContract;
	const server = new TestServer({
		seed: contract.seed / 1000,
		now: () => contract.now,
		runner: { clock: new ManualClock(contract.now) },
		site: { secret: Buffer.from(contract.secret), ...options.site },
		tables: { tableIds: numbered('t'), inviteCodes: numbered('invite') },
		store: options.store ?? null
	});
	for (const player of Object.values(contract.players)) await server.site.players.claim(player.id);
	return server.start();
}

/** Plays the recorded steps one at a time against a server. */
export class Replay {
	readonly server: TestServer;
	private readonly sockets = new Map<string, Socket>();
	private readonly ignore: (path: string, body: string) => string;
	private readonly differs: ContractOptions['differs'];
	private readonly seen: ContractOptions['seen'];

	constructor(server: TestServer, options: ContractOptions = {}) {
		this.server = server;
		this.ignore = options.ignore ?? ((_path, body) => body);
		this.differs = options.differs;
		this.seen = options.seen;
	}

	private sorted(): [string, Socket][] {
		return [...this.sockets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	}

	private collect(got: Result, kept: Record<string, Message[]>): void {
		for (const [name, socket] of this.sorted()) {
			const messages = socket.drain().map(comparable);
			if (!messages.length) continue;
			((got.received ??= {})[name] ??= []).push(...messages.map(digest));
			(kept[name] ??= []).push(...messages);
		}
	}

	private async request(step: Step): Promise<Result['response']> {
		const who = step.as ? tableContract.players[step.as] : null;
		const headers: Record<string, string> = { host: 'testserver' };
		if (who) {
			headers.cookie = who.cookie;
			headers['x-forwarded-for'] = who.address;
		}
		Object.assign(headers, step.headers ?? {});
		const response = await this.server.request(step.method as string, step.path as string, {
			body: step.body,
			headers,
			peer: '127.0.0.1'
		});
		const kept: Record<string, string> = {};
		for (const name of HEADERS) {
			const value = response.headers.get(name);
			if (value !== null) kept[name] = value;
		}
		return { status: response.status, headers: kept, body: await response.text() };
	}

	async play(step: Step, index: number): Promise<void> {
		const server = this.server;
		const got: Result = {};
		const kept: Record<string, Message[]> = {};
		if (step.do === 'http') {
			got.response = await this.request(step);
		} else if (step.do === 'open') {
			const who = tableContract.players[step.as as string];
			const socket = server.socket(who.cookie, '127.0.0.1', who.address);
			this.sockets.set(step.socket as string, socket);
			socket.send({ type: 'hello', protocol: 2 });
		} else if (step.do === 'send') {
			this.sockets.get(step.socket as string)!.send(step.text as string);
		} else if (step.do === 'close') {
			this.sockets.get(step.socket as string)!.close();
			this.sockets.delete(step.socket as string);
		} else if (step.do === 'advance') {
			(server.clock as ManualClock).advance(step.seconds as number);
		} else {
			const table = step.table as string;
			got.acted = [];
			for (let turn = 0; turn < (step.turns as number); turn++) {
				let found: [string, Socket, TableMessage] | null = null;
				for (const [name, socket] of this.sorted()) {
					const latest = socket.latest.get(table);
					if (!latest || latest.view.you.legal === null) continue;
					if ((latest.view.turn?.seq ?? 0) > (socket.answered.get(table) ?? 0)) {
						found = [name, socket, latest];
						break;
					}
				}
				if (found === null) break;
				const [name, socket, latest] = found;
				const action = nextAction(latest.view);
				socket.act(table, latest, action);
				got.acted.push([name, action, latest.view.seq]);
				await server.settle();
				this.collect(got, kept);
			}
		}
		await server.settle();
		this.collect(got, kept);
		for (const [name, messages] of Object.entries(kept)) this.seen?.(index, name, messages);

		const want = step.result;
		const where = `step ${index} (${step.do} ${step.path ?? step.text ?? step.table ?? step.socket ?? ''})`;
		if (want.response) {
			const path = step.path as string;
			expect({ ...got.response, body: this.ignore(path, got.response!.body) }, where).toEqual({
				...want.response,
				body: this.ignore(path, want.response.body)
			});
		}
		expect(got.acted ?? [], where).toEqual(want.acted ?? []);
		const names = new Set([
			...Object.keys(want.received ?? {}),
			...Object.keys(got.received ?? {})
		]);
		for (const name of names) {
			const ours = got.received?.[name] ?? [];
			const theirs = want.received?.[name] ?? [];
			const at = ours.findIndex((d, i) => d !== theirs[i]);
			if (at === -1 && ours.length === theirs.length) continue;
			if (this.differs) {
				this.differs(index, name, ours, kept[name] ?? []);
				continue;
			}
			const mine = kept[name]?.[at === -1 ? ours.length : at];
			const python = full?.steps[index].result.messages?.[name]?.[at === -1 ? ours.length : at];
			const detail = full
				? firstDifference(mine, python)
				: `set TABLE_CONTRACT_FULL to see the field; ours: ${JSON.stringify(mine)?.slice(0, 600)}`;
			throw new Error(
				`${where}: socket ${name} message ${at} of ${ours.length} (Python sent ${theirs.length}) differs\n  ${detail}`
			);
		}
	}

	async playAll(): Promise<void> {
		for (const [index, step] of tableContract.steps.entries()) await this.play(step, index);
	}
}
