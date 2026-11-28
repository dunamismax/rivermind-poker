// The iPhone app's recorded sessions, replayed against this server (P5D.11). An app
// build stays on phones for weeks, so a server change must keep serving every build
// from `OLDEST_APP_BUILD` on. Each build that changes what it sends records its own
// session (`app-sessions/build-<n>.json`, AppSessionRecordingTests.swift), and here:
//
// - every HTTP request it made is made again, as it made it (the ids it learned from
//   earlier answers put back in), and must get the status it got then;
// - its table socket plays as it did (check or call at its turns until two hands have
//   ended, then the rest of what it sent), each message built from the one the build
//   sent, with only the table, the `seq` and the action filled in;
// - and every answer and server message must still hold what the build read: each field
//   that was always there is there, with a JSON type the build has seen it take. Fields
//   it never saw, and kinds of message or event it never saw, are free: the app ignores
//   unknown fields and decodes unknown kinds as themselves (docs/ios.md).
//
// Raising `OLDEST_APP_BUILD` retires the recordings of the builds below it.
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { OLDEST_APP_BUILD } from './site.ts';
import { TestServer, type Message, type Socket, type TableMessage } from './tables.testing.ts';

const DIRECTORY = new URL('./app-sessions/', import.meta.url);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface HttpStep {
	request: { method: string; path: string; body: Json };
	status: number;
	response: Json;
}
interface SocketStep {
	socket: string;
	sent: Record<string, Json>[];
	received: Record<string, Json>[];
}
interface Recording {
	build: number;
	steps: (HttpStep | SocketStep)[];
}

export function recordings(): Recording[] {
	return readdirSync(DIRECTORY)
		.filter((name) => /^build-\d+\.json$/.test(name))
		.map((name) => JSON.parse(readFileSync(new URL(name, DIRECTORY), 'utf8')) as Recording)
		.sort((a, b) => a.build - b.build);
}

// What a build read: a value's JSON types, an object's fields and whether each was
// always there, and an array's items, told apart by their `type` or `kind` where they
// have one.

type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

interface Shape {
	types: Set<JsonType>;
	fields: Map<string, { shape: Shape; always: boolean }>;
	/** Array items by their `type` or `kind`, or under '' when they have none. */
	items: Map<string, Shape>;
}

function jsonType(value: Json): JsonType {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	return typeof value as JsonType;
}

function variant(value: Json): string {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return '';
	const tag = value.type ?? value.kind ?? value.notice;
	return typeof tag === 'string' ? tag : '';
}

function emptyShape(): Shape {
	return { types: new Set(), fields: new Map(), items: new Map() };
}

/** The shape of every value in `values`, merged. */
export function shapeOf(values: readonly Json[]): Shape {
	const shape = emptyShape();
	const objects: Record<string, Json>[] = [];
	const items: Json[] = [];
	for (const value of values) {
		shape.types.add(jsonType(value));
		if (Array.isArray(value)) items.push(...value);
		else if (value !== null && typeof value === 'object') objects.push(value);
	}
	const keys = new Set(objects.flatMap((o) => Object.keys(o)));
	for (const key of keys) {
		const present = objects.filter((o) => Object.hasOwn(o, key));
		shape.fields.set(key, {
			shape: shapeOf(present.map((o) => o[key])),
			always: present.length === objects.length
		});
	}
	const byVariant = new Map<string, Json[]>();
	for (const item of items) {
		const tag = variant(item);
		byVariant.set(tag, [...(byVariant.get(tag) ?? []), item]);
	}
	for (const [tag, list] of byVariant) shape.items.set(tag, shapeOf(list));
	return shape;
}

/** Where `value` no longer holds what `shape` says the build read, by path. */
export function mismatches(shape: Shape, value: Json, path = '$'): string[] {
	// A field the build only ever saw as null tells nothing of its other type.
	if (shape.types.size === 1 && shape.types.has('null')) return [];
	const type = jsonType(value);
	if (!shape.types.has(type)) return [`${path}: ${type}, where build saw ${[...shape.types]}`];
	const found: string[] = [];
	if (type === 'object') {
		const object = value as Record<string, Json>;
		for (const [key, field] of shape.fields) {
			if (!Object.hasOwn(object, key)) {
				if (field.always) found.push(`${path}.${key}: missing`);
				continue;
			}
			found.push(...mismatches(field.shape, object[key], `${path}.${key}`));
		}
	} else if (type === 'array') {
		(value as Json[]).forEach((item, i) => {
			const known = shape.items.get(variant(item));
			if (known) found.push(...mismatches(known, item, `${path}[${i}]`));
		});
	}
	return found;
}

/** Each placeholder the recording holds (`<practice>`, `<hand>`) and what it is now. */
class Names {
	private readonly values = new Map<string, string>();

	/** Learn the placeholders in a recorded answer from the answer given now. */
	learn(recorded: Json, now: Json): void {
		if (typeof recorded === 'string' && /^<\w+>$/.test(recorded) && typeof now === 'string') {
			if (!this.values.has(recorded)) this.values.set(recorded, now);
		} else if (Array.isArray(recorded) && Array.isArray(now)) {
			recorded.forEach((item, i) => this.learn(item, now[i] ?? null));
		} else if (recorded && now && typeof recorded === 'object' && typeof now === 'object') {
			for (const [key, item] of Object.entries(recorded)) {
				this.learn(item, (now as Record<string, Json>)[key] ?? null);
			}
		}
	}

	fill<T extends Json>(value: T): T {
		if (typeof value === 'string') return (this.values.get(value) ?? value) as T;
		if (Array.isArray(value)) return value.map((item) => this.fill(item)) as T;
		if (value !== null && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, this.fill(item)])
			) as T;
		}
		return value;
	}

	path(path: string): string {
		const [route, query] = path.split('?', 2);
		const filled = route
			.split('/')
			.map((part) => encodeURIComponent(this.values.get(part) ?? part))
			.join('/');
		return query === undefined ? filled : `${filled}?${query}`;
	}
}

const servers: TestServer[] = [];

afterEach(async () => {
	while (servers.length) await servers.pop()!.stop();
});

/** Replays a recording; returns every place an answer no longer holds what the build read. */
async function replay(recording: Recording): Promise<string[]> {
	const server = await new TestServer({ seed: 7 }).start();
	servers.push(server);
	const names = new Names();
	const client = `ios/${recording.build}`;
	let session: string | null = null;
	const found: string[] = [];

	for (const [index, step] of recording.steps.entries()) {
		if ('socket' in step) {
			found.push(
				...(await replaySocket(server, step, names, session)).map((m) => `#${index} ${m}`)
			);
			continue;
		}
		const headers: Record<string, string> = { 'rivermind-client': client };
		if (session) headers.cookie = `rm_session=${session}`;
		const path = names.path(step.request.path);
		const response = await server.request(step.request.method, path, {
			headers,
			body: step.request.body === null ? undefined : names.fill(step.request.body)
		});
		const cookie = /rm_session=([^;]*)/.exec(response.headers.get('set-cookie') ?? '');
		if (cookie) session = cookie[1] || null;
		const what = `#${index} ${step.request.method} ${step.request.path}`;
		const text = await response.text();
		if (response.status !== step.status) {
			found.push(`${what}: ${response.status}, where build got ${step.status}: ${text}`);
			continue;
		}
		if (step.response === null) continue;
		const now = JSON.parse(text) as Json;
		found.push(...mismatches(shapeOf([step.response]), now).map((m) => `${what} ${m}`));
		names.learn(step.response, now);
		await server.settle();
	}
	return found;
}

/** Plays the socket as the build did, from the messages it sent, and checks what comes back. */
async function replaySocket(
	server: TestServer,
	step: SocketStep,
	names: Names,
	session: string | null
): Promise<string[]> {
	const first = new Map<string, Record<string, Json>>();
	for (const message of step.sent) {
		if (!first.has(String(message.type))) first.set(String(message.type), message);
	}
	const lastAct = step.sent.map((m) => m.type).lastIndexOf('act');
	const after = step.sent.slice(lastAct + 1).filter((m) => m.type !== 'leave_table');
	const template = (type: string): Record<string, Json> => {
		const message = first.get(type);
		if (!message) throw new Error(`the recording sent no ${type}`);
		return names.fill(message);
	};

	const socket: Socket = server.socket(session ? `rm_session=${session}` : null);
	const send = (message: Record<string, Json>) => socket.send(message);
	send(template('hello'));
	const join = template('join_table');
	const tableId = String(join.table_id);
	send(join);

	let ended = 0;
	let acted = -1;
	for (let i = 0; i < 5_000 && ended < 2; i++) {
		const message = (await socket.receive()) as Message;
		if (message.type !== 'table') continue;
		const table = message as unknown as TableMessage;
		ended += table.events.filter((e) => e.kind === 'hand_ended').length;
		const view = table.view;
		const legal = view.you.legal;
		if (ended >= 2 || !legal || !view.hand || view.seq === acted) continue;
		acted = view.seq;
		send({
			...template('act'),
			table_id: tableId,
			seq: view.seq,
			action: legal.can_check ? 'check' : 'call'
		});
	}
	for (const message of after) send({ ...names.fill(message), table_id: tableId });
	await server.settle();
	// The build closed its socket as it sent leave_table, so what came after is not held to it.
	socket.drain();
	const received = socket.messages as unknown as Json[];
	if (first.has('leave_table')) send(template('leave_table'));
	await server.settle();

	// Each kind of message is held to what the build saw of that kind.
	const byType = new Map<string, Json[]>();
	for (const message of step.received) {
		const type = String(message.type);
		byType.set(type, [...(byType.get(type) ?? []), message]);
	}
	const found: string[] = [];
	const seen = new Set<string>();
	for (const message of received) {
		const type = variant(message);
		seen.add(type);
		const recorded = byType.get(type);
		if (recorded) found.push(...mismatches(shapeOf(recorded), message).map((m) => `${type} ${m}`));
	}
	for (const type of byType.keys()) {
		if (!seen.has(type)) found.push(`no ${type} message came, where the build got one`);
	}
	return found;
}

describe('the iPhone app builds this server still serves', () => {
	const all = recordings();

	it('include a recording of the oldest one', () => {
		expect(all.map((r) => r.build)).toContain(OLDEST_APP_BUILD);
	});

	for (const recording of all.filter((r) => r.build >= OLDEST_APP_BUILD)) {
		it(`build ${recording.build}: every request is served as it was, with what the build read`, async () => {
			expect(await replay(recording)).toEqual([]);
		}, 60_000);
	}

	it('catches a field the build read that has gone', () => {
		const shape = shapeOf([{ table_id: 't', seat: 0, view: { seq: 3, hand: null } }]);
		expect(mismatches(shape, { table_id: 'u', seat: 1, view: { seq: 4, hand: { n: 1 } } })).toEqual(
			[]
		);
		expect(mismatches(shape, { table_id: 'u', view: { seq: '4' } })).toEqual([
			'$.seat: missing',
			'$.view.seq: string, where build saw number',
			'$.view.hand: missing'
		]);
		const events = shapeOf([
			[
				{ kind: 'action', seat: 1 },
				{ kind: 'board', cards: [] }
			]
		]);
		expect(mismatches(events, [{ kind: 'board' }, { kind: 'new_kind', x: 1 }])).toEqual([
			'$[0].cards: missing'
		]);
	});
});
