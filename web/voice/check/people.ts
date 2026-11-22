// What the voice checks that put people in a room share (room.check.ts,
// tap.check.ts): their identities and tokens, a person's page, joining, a
// page's report, the check that everyone hears everyone, and a voice service
// of a check's own.
import { spawn, type ChildProcess } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';
import { publicRef } from '../../src/lib/server/api/auth.ts';
import { issueToken, voiceKey } from '../../src/lib/server/voice/tokens.ts';
import type { Identity } from '../../src/lib/voice/group.ts';
import { launch, canCapture } from './browsers.ts';
import type { JoinOptions, RoomReport } from './room.ts';
import { ORIGIN, VOICE_SECRET, VOICE_URL } from './vite.config.ts';

const key = voiceKey(new TextEncoder().encode(VOICE_SECRET));
export const identity = (seat: number): Identity => ({
	player: publicRef(`p_check-seat-${seat}`),
	seat
});
export const token = (table: string, seat: number) =>
	issueToken(key, { table, ...identity(seat) }, Date.now() / 1000);
let tables = 0;
export const newTable = () => `check-${process.pid}-${(tables += 1)}`;

export type Person = { page: Page; seat: number };

// A person's page. WebKit lets one page of a browser capture at a time, so a
// WebKit person has a browser of their own (browsers.ts).
export async function open(browser: Browser): Promise<Page> {
	const engine = browser.browserType().name();
	const own = engine === 'webkit' ? await browser.browserType().launch(launch.webkit) : null;
	const context = await (own ?? browser).newContext(
		engine === 'firefox' ? {} : { permissions: ['microphone'] }
	);
	const page = await context.newPage();
	page.on('close', () => void own?.close());
	if (process.env.VOICE_DEBUG) {
		page.on('console', (message) => console.log(`[room] ${message.text()}`));
		page.on('pageerror', (error) => console.log(`[room] ${error}`));
	}
	await page.goto('/room.html');
	await expect(page.locator('body')).toHaveAttribute('data-room', 'ready');
	return page;
}

// Someone sits at `seat` and joins voice: a fake microphone where the engine's
// works here and a tone where it does not. Only Chromium is given Web Audio;
// the others are judged by WebRTC's statistics (browsers.ts).
export function joining(
	engine: string,
	table: string,
	seat: number,
	seated: number[],
	url = VOICE_URL
): JoinOptions {
	return {
		url,
		table,
		token: token(table, seat),
		seated: seated.map(identity),
		source: canCapture(engine) ? 'capture' : 'tone',
		freq: 400 + 150 * seat,
		webAudio: engine === 'chromium'
	};
}

export async function join(
	browser: Browser,
	table: string,
	seat: number,
	seated: number[],
	muted: number[] = [],
	url = VOICE_URL
): Promise<Person> {
	const page = await open(browser);
	const options = joining(browser.browserType().name(), table, seat, seated, url);
	options.muted = muted.map((one) => identity(one).player);
	await page.evaluate((given) => window.room.join(given), options);
	return { page, seat };
}

export const report = (person: Person, listenMs = 0): Promise<RoomReport> =>
	person.page.evaluate((ms) => window.room.report(ms), listenMs);

export const none = {
	malformed: 0,
	'unknown-key': 0,
	'stale-epoch': 0,
	'wrong-sender': 0,
	tampered: 0,
	replayed: 0
};

// Everyone is on one epoch with one voice code, hears everyone else's audio
// opened under the group's keys, and refused nothing.
export async function everyoneHearsEveryone(people: Person[]): Promise<RoomReport[]> {
	let reports: RoomReport[] = [];
	await expect(async () => {
		reports = await Promise.all(people.map((person) => report(person, 1200)));
		const [first] = reports;
		expect(first.epoch).not.toBeNull();
		for (const mine of reports) {
			expect(mine.epoch).toBe(first.epoch);
			expect(mine.code).toEqual(first.code);
			expect(mine.code).toHaveLength(4);
			expect(mine.seatsOk).toBe(true);
			expect(mine.connection).toEqual({ send: 'connected', recv: 'connected' });
			const others = reports.filter((other) => other !== mine).map((other) => other.leaf);
			expect(mine.heard.map(({ leaf }) => leaf)).toEqual(others.sort((a, b) => a! - b!));
			for (const heard of mine.heard) {
				const label = `leaf ${heard.leaf} at leaf ${mine.leaf}`;
				if (heard.rms !== null) expect(heard.rms, `${label}: rms`).toBeGreaterThan(0.005);
				else expect(heard.energy, `${label}: energy`).toBeGreaterThan(0.0001);
				expect(heard.totalSamplesReceived, `${label}: samples`).toBeGreaterThan(24_000);
				expect(heard.concealedSamples / heard.totalSamplesReceived, label).toBeLessThan(0.5);
			}
			const sent = mine.transforms.find(({ direction }) => direction === 'encrypt')!;
			expect(sent.frames).toBeGreaterThan(50);
			expect(sent.unsent).toBe(0);
			for (const one of mine.transforms.filter(({ direction }) => direction === 'decrypt')) {
				expect(one.refused, `${one.id} at leaf ${mine.leaf}`).toEqual(none);
			}
			expect(mine.refused).toEqual([]);
		}
	}).toPass({ timeout: 60_000 });
	return reports;
}

// A voice service of a check's own on `port`, from the source as the config
// starts the other: voice/server.ts, or a test build of it (`script`, beside
// this file), with more of the environment in `env`.
export async function startVoice(
	port: number,
	script = '../server.ts',
	env: Record<string, string> = {}
): Promise<ChildProcess> {
	const lan = Object.values(networkInterfaces())
		.flat()
		.find((address) => address?.family === 'IPv4' && !address.internal)?.address;
	const child = spawn(process.execPath, [path.resolve(import.meta.dirname, script)], {
		env: {
			...process.env,
			PORT: String(port),
			RIVERMIND_SECRET: VOICE_SECRET,
			VOICE_ORIGINS: ORIGIN,
			VOICE_MEDIA_PORT: '0',
			VOICE_LISTEN_IPS: ['127.0.0.1', ...(lan ? [lan] : [])].join(','),
			...env
		},
		stdio: process.env.VOICE_DEBUG ? 'inherit' : 'ignore'
	});
	const health = `http://127.0.0.1:${port}/healthz`;
	await expect
		.poll(
			() =>
				fetch(health).then(
					(response) => response.ok,
					() => false
				),
			{ timeout: 30_000 }
		)
		.toBe(true);
	return child;
}

export async function stopVoice(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once('exit', resolve));
	child.kill('SIGTERM');
	await exited;
}
