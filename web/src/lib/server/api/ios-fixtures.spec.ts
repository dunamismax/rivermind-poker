// The iPhone app's protocol fixture (P5D.2): every socket message and HTTP body
// of the two recorded sessions, each with the protocol v2 type it is, for
// RiverMindKit's tests to decode and encode back to the same JSON
// (ProtocolFixtureTests.swift). The table session's socket messages are
// recorded only as digests, so they come from replaying it here, where the
// replay checks each against its digest: they are the recording's messages.
//
// This test fails while the committed fixture is stale. `pnpm ios:fixtures`
// writes it again.
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { canonical } from '../table/parity.ts';
import { ClientMessage, HelloMessage } from './protocol.ts';
import { contractServer, Replay, tableContract } from './table-contract.testing.ts';
import { parse } from './validate.ts';

const FIXTURE = new URL('../../../../../ios/RiverMindKit/Fixtures/protocol.json', import.meta.url);

interface Exchange {
	method: string;
	path: string;
	body?: string;
	response: { status: number; body: string };
}

/** The type of a response body, by route; every refusal is an `HttpError`. */
function responseType(method: string, path: string, status: number): string | null {
	if (status === 204) return null;
	if (status >= 400) return 'HttpError';
	const route = `${method} ${path.split('?')[0]}`
		.replace(/\/api\/tables\/[^/]+\//, '/api/tables/{id}/')
		.replace(/\/api\/hands\/[^/]+$/, '/api/hands/{id}')
		.replace(/\/api\/invites\/[^/]+$/, '/api/invites/{code}')
		.replace(/\/api\/relations\/[^/]+$/, '/api/relations/{ref}');
	const types: Record<string, string> = {
		'GET /api/config': 'ConfigResponse',
		'POST /api/session': 'SessionResponse',
		'GET /api/wallet': 'WalletResponse',
		'GET /api/hands': 'HandListResponse',
		'GET /api/hands/{id}': 'HandDetail',
		'GET /api/relations': 'RelationsResponse',
		'PUT /api/relations': 'RelationsResponse',
		'DELETE /api/relations/{ref}': 'RelationsResponse',
		'GET /api/tables': 'TableListResponse',
		'POST /api/tables': 'NewTableResponse',
		'GET /api/invites/{code}': 'TableSummary',
		'POST /api/tables/{id}/seat': 'SeatResponse',
		'POST /api/tables/{id}/waitlist': 'WaitlistResponse',
		'POST /api/quick-seat': 'SeatResponse',
		'POST /api/practice': 'PracticeResponse',
		'POST /api/reports': 'ReportResponse'
	};
	const type = types[route];
	if (!type) throw new Error(`no type for ${route} ${status}`);
	return type;
}

/** The type of a request body the server accepted, by route. */
function requestType(method: string, path: string): string | null {
	const route = `${method} ${path.split('?')[0]}`.replace(
		/\/api\/tables\/[^/]+\//,
		'/api/tables/{id}/'
	);
	const types: Record<string, string> = {
		'POST /api/session': 'SessionRequest',
		'POST /api/tables': 'NewTableRequest',
		'POST /api/tables/{id}/seat': 'SeatRequest',
		'POST /api/tables/{id}/waitlist': 'WaitlistRequest',
		'POST /api/quick-seat': 'QuickSeatRequest',
		'POST /api/practice': 'PracticeRequest',
		'POST /api/reports': 'ReportRequest',
		'PUT /api/relations': 'RelationRequest'
	};
	return types[route] ?? null;
}

class Fixture {
	private readonly keys = new Set<string>();
	readonly server: unknown[] = [];
	readonly client: unknown[] = [];
	readonly http: { type: string; route: string; status: number; body: unknown }[] = [];
	readonly requests: { type: string; route: string; body: unknown }[] = [];

	/** Adds a value once, however often the sessions sent it. */
	private once(kind: string, value: unknown): boolean {
		const key = `${kind} ${canonical(value)}`;
		if (this.keys.has(key)) return false;
		this.keys.add(key);
		return true;
	}

	message(message: unknown): void {
		if (this.once('server', message)) this.server.push(message);
	}

	sent(text: string): void {
		let value: unknown;
		try {
			value = JSON.parse(text);
			parse(ClientMessage, value);
		} catch {
			return; // the session also sends what the server refuses
		}
		if (this.once('client', value)) this.client.push(value);
	}

	exchange(exchange: Exchange): void {
		const { method, path, response } = exchange;
		const type = responseType(method, path, response.status);
		const route = `${method} ${path}`;
		if (type !== null && this.once(`http ${type}`, response.body)) {
			this.http.push({ type, route, status: response.status, body: JSON.parse(response.body) });
		}
		const asked = requestType(method, path);
		if (asked && exchange.body && response.status < 300) {
			const body: unknown = JSON.parse(exchange.body);
			if (body !== null && this.once(`request ${asked}`, body)) {
				this.requests.push({ type: asked, route, body });
			}
		}
	}

	text(): string {
		const list = (items: unknown[]) =>
			items.length ? `[\n${items.map((i) => JSON.stringify(i)).join(',\n')}\n]` : '[]';
		const note =
			'Written by web/src/lib/server/api/ios-fixtures.spec.ts (pnpm ios:fixtures) from the two recorded sessions. Do not edit.';
		return (
			`{"note":${JSON.stringify(note)},\n` +
			`"server":${list(this.server)},\n` +
			`"client":${list(this.client)},\n` +
			`"http":${list(this.http)},\n` +
			`"requests":${list(this.requests)}}\n`
		);
	}
}

describe('the iPhone app protocol fixture', async () => {
	const fixture = new Fixture();
	const contract = JSON.parse(
		readFileSync(new URL('./contract.json', import.meta.url), 'utf8')
	) as { cases: (Exchange & { headers?: Record<string, string> })[] };
	const server = await contractServer();
	const replay = new Replay(server, {
		seen: (_step, _socket, messages) => messages.forEach((m) => fixture.message(m))
	});
	afterAll(() => server.stop());

	it('holds every message and body of the recorded sessions', async () => {
		for (const exchange of contract.cases) fixture.exchange(exchange);
		fixture.sent(JSON.stringify(parse(HelloMessage, { type: 'hello', protocol: 2 })));
		for (const [index, step] of tableContract.steps.entries()) {
			await replay.play(step, index);
			if (step.do === 'send') fixture.sent(step.text as string);
			if (step.do === 'http') {
				fixture.exchange({
					method: step.method as string,
					path: step.path as string,
					body: step.body,
					response: step.result.response!
				});
			}
		}
		const kinds = new Set(fixture.server.map((m) => (m as { type: string }).type));
		// No table closes under a socket in the session: ProtocolFixtureTests.swift has one.
		expect([...kinds].sort()).toEqual(['error', 'left_table', 'reaction', 'table', 'welcome']);

		const text = fixture.text();
		if (process.env.IOS_FIXTURES === 'write') writeFileSync(FIXTURE, text);
		let committed = '';
		try {
			committed = readFileSync(FIXTURE, 'utf8');
		} catch {
			// missing: fails below
		}
		expect(committed === text, 'the iOS protocol fixture is stale: run pnpm ios:fixtures').toBe(
			true
		);
	});
});
