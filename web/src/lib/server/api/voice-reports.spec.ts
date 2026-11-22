// Voice reports and the limits on joining voice (P4C.8): the rule that
// suspends a guest's speaking, and the table server carrying it to the voice
// service in its seat lists; and how often a player or an address may ask for
// a voice token.
import { afterEach, describe, expect, it } from 'vitest';
import { publicRef } from './auth.ts';
import { moderate } from './moderation.ts';
import { MemoryPlayers } from './players.ts';
import {
	MemorySafety,
	UNLIMITED,
	VOICE_REPORT_WINDOW_SECONDS,
	VOICE_SUSPENSION_SECONDS,
	speakingDue,
	suspendIfDue,
	type Limits,
	type Report
} from './safety.ts';
import { Player, SECRET, TestServer, quietLog } from './tables.testing.ts';
import { Voice } from './voice.ts';
import type { SeatList } from '../voice/seats.ts';

const NOW = 1_800_000_000;

// A voice report against `t`, made `ago` seconds before NOW.
const report = (
	reporter: string,
	table: string | null,
	address: string | null,
	ago = 60,
	reason: Report['reason'] = 'voice'
): Report => ({
	reporterId: reporter,
	targetId: 't',
	targetHandle: 'Target',
	reason,
	tableId: table,
	handNo: null,
	at: NOW - ago,
	reporterAddress: address
});

describe('the rule that suspends speaking', () => {
	it('takes three voice reports from three people at three tables from three addresses', () => {
		expect(
			speakingDue([report('a', 't1', 'x1'), report('b', 't2', 'x2'), report('c', 't3', 'x3')], NOW)
		).toBe(true);
		expect(speakingDue([report('a', 't1', 'x1'), report('b', 't2', 'x2')], NOW)).toBe(false);
	});

	it('counts friends at one table, one address with many guests, or one person, once', () => {
		const two = [report('a', 't1', 'x1'), report('b', 't2', 'x2')];
		// Another report from a table, an address or a person already counted adds nothing.
		expect(speakingDue([...two, report('c', 't1', 'x3')], NOW)).toBe(false);
		expect(speakingDue([...two, report('c', 't3', 'x1')], NOW)).toBe(false);
		expect(speakingDue([...two, report('a', 't3', 'x3')], NOW)).toBe(false);
		// Nor does one without a table or an address, an older one, or another reason.
		expect(speakingDue([...two, report('c', null, 'x3')], NOW)).toBe(false);
		expect(speakingDue([...two, report('c', 't3', null)], NOW)).toBe(false);
		expect(
			speakingDue([...two, report('c', 't3', 'x3', VOICE_REPORT_WINDOW_SECONDS + 1)], NOW)
		).toBe(false);
		expect(speakingDue([...two, report('c', 't3', 'x3', 60, 'abuse')], NOW)).toBe(false);
	});

	it('finds three apart among many that overlap', () => {
		// No three of the first five are apart: the only report from a third table
		// shares its address with every other choice there. The sixth is apart
		// from the second and the fifth.
		const reports = [
			report('a', 't1', 'x1'),
			report('b', 't1', 'x2'),
			report('c', 't2', 'x1'),
			report('d', 't2', 'x2'),
			report('e', 't3', 'x1'),
			report('f', 't2', 'x3')
		];
		expect(speakingDue(reports.slice(0, 5), NOW)).toBe(false);
		expect(speakingDue(reports, NOW)).toBe(true);
	});

	it('suspends for a day from the report that completes it, once', async () => {
		const safety = new MemorySafety();
		const kept = [report('a', 't1', 'x1'), report('b', 't2', 'x2'), report('c', 't3', 'x3', 0)];
		for (const one of kept.slice(0, 2)) await safety.report(one);
		expect(await suspendIfDue(safety, 't', NOW)).toBeNull();
		expect(await safety.speakingSuspendedUntil('t', NOW)).toBeNull();
		await safety.report(kept[2]);
		expect(await suspendIfDue(safety, 't', NOW)).toBe(NOW + VOICE_SUSPENSION_SECONDS);
		expect(await safety.speakingSuspendedUntil('t', NOW)).toBe(NOW + VOICE_SUSPENSION_SECONDS);
		// Asked again at the same moment, nothing changes; a report that comes
		// while the three still count carries it on from then.
		expect(await suspendIfDue(safety, 't', NOW)).toBeNull();
		expect(await suspendIfDue(safety, 't', NOW + 10)).toBe(NOW + 10 + VOICE_SUSPENSION_SECONDS);
		// It ends when it says, and reports older than a day no longer count.
		const ends = NOW + 10 + VOICE_SUSPENSION_SECONDS;
		expect(await safety.speakingSuspendedUntil('t', ends)).toBeNull();
		expect(await suspendIfDue(safety, 't', ends)).toBeNull();
	});

	it('is listed and lifted by the moderator', async () => {
		const players = new MemoryPlayers();
		const safety = new MemorySafety();
		const guest = await players.create();
		const run = (...args: string[]) => moderate(args, { players, safety });
		expect(await run('suspensions')).toEqual([]);
		await safety.suspendSpeaking(guest.playerId, Date.now() / 1000 + 3600);
		const [line] = await run('suspensions');
		expect(line).toMatch(new RegExp(`^until .* UTC  ${guest.handle} \\(${guest.playerId}\\)$`));
		expect(await run('lift', guest.playerId)).toEqual([
			`${guest.playerId} may speak in voice again.`
		]);
		expect(await run('suspensions')).toEqual([]);
		await expect(run('lift', guest.playerId)).rejects.toThrow('may already speak in voice');
	});
});

let servers: TestServer[] = [];
afterEach(async () => {
	for (const server of servers) await server.stop();
	servers = [];
});

// A table server whose voice service is a list of what it was sent.
async function voiced(limits: Readonly<Limits> = UNLIMITED) {
	const lists: SeatList[] = [];
	let server: TestServer | null = null;
	const voice = new Voice({
		secret: SECRET,
		link: { send: async (list) => void lists.push(list) },
		blocksOf: (playerId) => server!.site.safety.blocksInvolving(playerId),
		silencedUntil: (playerId) =>
			server!.site.safety.speakingSuspendedUntil(playerId, server!.site.clock()),
		now: () => NOW,
		log: quietLog()
	});
	server = await new TestServer({ tables: { voice }, limits }).start();
	servers.push(server);
	return { server, voice, lists };
}

async function sit(player: Player, tableId: string, seat: number): Promise<void> {
	const response = await player.request('POST', `/api/tables/${tableId}/seat`, { seat });
	expect(response.status, await response.text()).toBe(200);
}

describe('voice reports at the table server', () => {
	it('suspend someone’s speaking at every table they sit at, and say no audio goes with them', async () => {
		const { server, voice, lists } = await voiced();
		const target = await Player.create(server);
		const reporters = await Promise.all([0, 1, 2, 3].map(() => Player.create(server)));
		// The target sits at three tables, each with someone who will report them.
		const tables: string[] = [];
		for (const reporter of reporters.slice(0, 3)) {
			const tableId = await target.newTable(3, null, { buy_in: 4000 });
			await sit(reporter, tableId, 1);
			tables.push(tableId);
		}
		await sit(reporters[3], tables[1], 2);
		const send = (reporter: Player, tableId: string, peer: string) =>
			server.request('POST', '/api/reports', {
				body: { table_id: tableId, seat: 0, reason: 'voice' },
				headers: reporter.headers(),
				peer
			});
		const suspended = () =>
			server.site.safety.speakingSuspendedUntil(target.playerId, server.site.clock());
		// Two reports from one address, and a third from another, are not enough:
		// two people on one address count once.
		expect((await send(reporters[0], tables[0], '198.51.100.1')).status).toBe(201);
		expect((await send(reporters[1], tables[1], '198.51.100.1')).status).toBe(201);
		expect((await send(reporters[2], tables[2], '198.51.100.3')).status).toBe(201);
		expect(await suspended()).toBeNull();
		await voice.settled();
		expect(lists.every((list) => list.silenced === undefined)).toBe(true);
		// A fourth person, at the second table and from a third address, makes three apart.
		lists.length = 0;
		const before = server.site.clock();
		expect((await send(reporters[3], tables[1], '198.51.100.2')).status).toBe(201);
		const until = (await suspended())!;
		expect(until).toBeGreaterThanOrEqual(before + 24 * 3600);
		expect(until).toBeLessThanOrEqual(server.site.clock() + 24 * 3600);
		await voice.settled();
		// Every table they sit at tells the voice service, until when in milliseconds.
		const silenced = [[publicRef(target.playerId), Math.ceil(until * 1000)]];
		expect(lists.map((list) => list.table).sort()).toEqual([...tables].sort());
		for (const list of lists) expect(list.silenced).toEqual(silenced);
		// So does a list sent later, as with each voice token.
		lists.length = 0;
		expect((await target.request('POST', `/api/tables/${tables[0]}/voice`)).status).toBe(200);
		await voice.settled();
		expect(lists.at(-1)!.silenced).toEqual(silenced);
		// Reports keep a keyed hash of the address, never the address.
		const kept = await server.site.safety.reports(10);
		expect(kept.map((one) => one.reason)).toEqual(['voice', 'voice', 'voice', 'voice']);
		for (const one of kept) expect(one.reporterAddress).toMatch(/^[0-9a-f]{24}$/);
		expect(new Set(kept.map((one) => one.reporterAddress)).size).toBe(3);
		expect(JSON.stringify(kept)).not.toContain('198.51.100');
	});
});

describe('how often voice may be joined', () => {
	it('limits voice tokens per player and per address', async () => {
		const { server } = await voiced({
			...UNLIMITED,
			voiceRate: 1e-6,
			voiceBurst: 3,
			voiceAddressRate: 1e-6,
			voiceAddressBurst: 5
		});
		const [a, b, c] = await Promise.all([0, 1, 2].map(() => Player.create(server)));
		const tableId = await a.newTable(3, null);
		await sit(b, tableId, 1);
		await sit(c, tableId, 2);
		const ask = (player: Player, peer: string) =>
			server.request('POST', `/api/tables/${tableId}/voice`, { headers: player.headers(), peer });
		for (let tries = 0; tries < 3; tries += 1) {
			expect((await ask(a, '203.0.113.1')).status).toBe(200);
		}
		// a has had their three; b, from the same address, has the address's last two.
		const refused = await ask(a, '203.0.113.2');
		expect(refused.status).toBe(429);
		expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
		expect((await ask(b, '203.0.113.1')).status).toBe(200);
		expect((await ask(b, '203.0.113.1')).status).toBe(200);
		expect((await ask(b, '203.0.113.1')).status).toBe(429);
		// From another address, c is not held back.
		expect((await ask(c, '203.0.113.9')).status).toBe(200);
	});
});
