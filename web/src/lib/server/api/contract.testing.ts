// The HTTP contract recorded from serve-nl (test/server/export_http_contract.py),
// for the contract tests to replay against the TypeScript API, in memory
// (contract.spec.ts) and on PostgreSQL (contract.db.spec.ts).
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { replayRecord } from '../engine/history.ts';
import type { ApiHandler } from './api.ts';
import type { FinishedHand } from './hands.ts';

export interface Case {
	name: string;
	method: string;
	path: string;
	url?: string;
	headers?: Record<string, string>;
	body?: string;
	random: boolean;
	response: { status: number; headers: Record<string, string>; body: string };
}

export interface Contract {
	secret: string;
	now: number;
	players: string[];
	hands: {
		table_id: string;
		table_name: string;
		hand_no: number;
		practice: boolean;
		record: Record<string, unknown>;
		seats: ({ player_id: string; name: string; bot: string | null } | null)[];
	}[];
	cases: Case[];
}

export const contract = JSON.parse(
	readFileSync(new URL('./contract.json', import.meta.url), 'utf8')
) as Contract;
const HEADERS = ['content-type', 'set-cookie', 'retry-after', 'allow'];

/** The contract's finished hands, as a table hands them over. */
export function contractHands(): (Contract['hands'][number] & { finished: FinishedHand })[] {
	return contract.hands.map((hand) => ({
		...hand,
		finished: {
			handNo: hand.hand_no,
			state: replayRecord(hand.record),
			seats: hand.seats.map((s) => s && { playerId: s.player_id, name: s.name, bot: s.bot })
		}
	}));
}

/** A new player's id, handle and cookie are random, so the recording keeps only their places. */
function normalize(c: Case, headers: Record<string, string>, body: string) {
	if (!c.random) return { headers, body };
	const kept = { ...headers };
	if (kept['set-cookie'])
		kept['set-cookie'] = kept['set-cookie'].replace(/^(rm_session=)[^;]*/, '$1*');
	return {
		headers: kept,
		body: JSON.stringify({ ...JSON.parse(body), player_id: '*', name: '*' })
	};
}

/**
 * Send a recorded request and check the answer. `ignore` drops fields whose
 * values the store decides, such as ledger times written by the database.
 */
export async function checkCase(
	api: ApiHandler,
	c: Case,
	ignore: (body: unknown) => unknown = (b) => b
) {
	const headers = new Headers(c.headers ?? {});
	const base = c.url ?? 'http://testserver';
	if (!headers.has('host')) headers.set('host', new URL(base).host);
	const request = new Request(base + c.path, { method: c.method, headers, body: c.body ?? null });
	const response = await api(request, { peer: 'testclient' });
	const got: Record<string, string> = {};
	for (const name of HEADERS) {
		const value = response.headers.get(name);
		if (value !== null) got[name] = value;
	}
	const answer = normalize(c, got, await response.text());
	const recorded = c.response.body;
	expect({ status: response.status, ...answer, body: ignore(answer.body) }).toEqual({
		status: c.response.status,
		headers: c.response.headers,
		body: ignore(recorded)
	});
}
