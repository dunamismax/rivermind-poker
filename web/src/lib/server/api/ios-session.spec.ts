// The iPhone app's session fixture (P5D.3): what a client that plays the seeded
// practice table as the app will (check or call at every turn, refill once out of
// chips, play two more hands, leave) receives from the server. The site is
// e2e/seeded-site.ts, the one e2e/seeded-server.ts serves to the app's checks, and
// TableConnectionSessionTests.swift plays the same script there through the app's
// own connection and expects the same record.
//
// What is recorded starts at the second hand: the first may be dealt before or
// after the socket joins, so which of its events a client sees depends on timing.
// From then on the table waits on the client at each of its turns and on its bot
// otherwise, so the events, their order and the views at the client's turns are a
// function of the seed. Two sites are played here to show it.
//
// This test fails while the committed fixture is stale. `pnpm ios:fixtures` writes it again.
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { seededSite } from '../../../../e2e/seeded-site.ts';
import type * as p from '../../protocol-v2.ts';

const FIXTURE = new URL('../../../../../ios/RiverMindKit/Fixtures/session.json', import.meta.url);
/** The seed whose practice table puts a guest who checks or calls out of chips in its fourth hand (practice.e2e.ts). */
export const SESSION_SEED = 10;
const GUEST = '<guest>';

export interface TurnRecord {
	hand_no: number;
	street: p.Street;
	board: p.Card[];
	pot: number;
	current_bet: number;
	legal: p.Legal;
	cards: p.Card[] | null;
	stacks: (number | null)[];
	action: 'check' | 'call';
}

export interface SessionRecord {
	/** Whether the first view already showed the guest's own seat as connected (`Tables.join`). */
	connected_in_first_view: boolean;
	/** The hand the guest ran out of chips in and refilled after. */
	refill_hand: number;
	/** Every event from the second hand to the end of the second hand after the refill. */
	events: p.TableEvent[];
	/** The views at the guest's turns, from the second hand on. */
	turns: TurnRecord[];
}

/** An event with the guest's random name taken out. */
function normalize(event: p.TableEvent, name: string): p.TableEvent {
	return event.name === name ? { ...event, name: GUEST } : event;
}

/** Plays the script against a site at `origin` and returns what it saw. */
async function play(origin: string): Promise<SessionRecord> {
	const started = await fetch(`${origin}/api/session`, { method: 'POST' });
	const cookie = started.headers
		.getSetCookie()
		.find((c) => c.startsWith('rm_session='))!
		.split(';')[0];
	const guest = (await started.json()) as p.SessionResponse;
	const practice = (await (
		await fetch(`${origin}/api/practice`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: '{}'
		})
	).json()) as p.PracticeResponse;
	const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws`, { headers: { cookie } });
	const table = practice.table_id;

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('the session did not finish')), 60_000);
		const events: p.TableEvent[] = [];
		const turns: TurnRecord[] = [];
		let first: boolean | null = null;
		let recording = false;
		let hand = 0;
		let refill: number | null = null;
		let acted = -1;
		const finish = (record: SessionRecord) => {
			clearTimeout(timer);
			socket.send(JSON.stringify({ type: 'leave_table', table_id: table }));
			socket.close();
			resolve(record);
		};
		socket.on('open', () => {
			socket.send(JSON.stringify({ type: 'hello', protocol: 2 }));
			socket.send(JSON.stringify({ type: 'join_table', table_id: table }));
		});
		socket.on('error', reject);
		socket.on('message', (data) => {
			const message = JSON.parse(String(data)) as p.ServerMessage;
			if (message.type === 'error') return reject(new Error(message.message));
			if (message.type !== 'table') return;
			const view = message.view;
			const seat = view.you.seat;
			if (first === null) first = seat !== null && view.seats[seat]?.connected === true;
			for (const event of message.events) {
				if (event.kind === 'hand_started') hand = event.hand_no ?? hand;
				if (!recording && event.kind === 'hand_started' && hand >= 2) recording = true;
				if (recording) events.push(normalize(event, guest.name));
				if (event.kind === 'hand_ended' && refill !== null && hand > refill + 1) {
					return finish({
						connected_in_first_view: first,
						refill_hand: refill,
						events,
						turns
					});
				}
			}
			if (seat === null) return;
			const over = view.hand === null || view.hand.result !== null;
			if (refill === null && over && view.seats[seat]?.stack === 0) {
				refill = view.hand?.hand_no ?? hand;
				socket.send(
					JSON.stringify({ type: 'rebuy', table_id: table, amount: view.settings.max_buy_in })
				);
				return;
			}
			const legal = view.you.legal;
			if (!legal || !view.hand || view.seq === acted) return;
			acted = view.seq;
			const action = legal.can_check ? 'check' : 'call';
			if (recording) {
				turns.push({
					hand_no: view.hand.hand_no,
					street: view.hand.street,
					board: view.hand.board,
					pot: view.hand.pot,
					current_bet: view.hand.current_bet,
					legal,
					cards: view.seats[seat]?.cards ?? null,
					stacks: view.seats.map((s) => s?.stack ?? null),
					action
				});
			}
			socket.send(JSON.stringify({ type: 'act', table_id: table, seq: view.seq, action }));
		});
	});
}

async function onSeededSite(): Promise<SessionRecord> {
	const { app, tables } = await seededSite({
		handler: (_req, res) => {
			res.statusCode = 404;
			res.end();
		},
		origin: new URL('http://127.0.0.1'),
		seed: SESSION_SEED
	});
	await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
	const { port } = app.server.address() as AddressInfo;
	try {
		return await play(`http://127.0.0.1:${port}`);
	} finally {
		await app.close();
		await tables.stop?.();
	}
}

describe('the iPhone app session fixture', () => {
	it('is what a guest who checks or calls sees at the seeded practice table, every time', async () => {
		const [one, two] = [await onSeededSite(), await onSeededSite()];
		expect(two).toEqual(one);
		expect(one.connected_in_first_view).toBe(true);
		expect(one.refill_hand).toBeGreaterThanOrEqual(2);
		expect(one.turns.length).toBeGreaterThan(0);
		const kinds = new Set(one.events.map((e) => e.kind));
		for (const kind of ['hand_started', 'action', 'board', 'hand_ended', 'rebought'])
			expect(kinds, kind).toContain(kind);

		const text =
			'{"note":"Written by web/src/lib/server/api/ios-session.spec.ts (pnpm ios:fixtures). Do not edit.",\n' +
			`"seed":${SESSION_SEED},\n` +
			`"connected_in_first_view":${one.connected_in_first_view},\n` +
			`"refill_hand":${one.refill_hand},\n` +
			`"events":[\n${one.events.map((e) => JSON.stringify(e)).join(',\n')}\n],\n` +
			`"turns":[\n${one.turns.map((t) => JSON.stringify(t)).join(',\n')}\n]}\n`;
		if (process.env.IOS_FIXTURES === 'write') writeFileSync(FIXTURE, text);
		let committed = '';
		try {
			committed = readFileSync(FIXTURE, 'utf8');
		} catch {
			// missing: fails below
		}
		expect(committed === text, 'the iOS session fixture is stale: run pnpm ios:fixtures').toBe(
			true
		);
	}, 120_000);
});
