// Helpers for the voice prototype's Playwright checks (P4C.1): people who join
// a room, and what each of them should then hear.
import { expect, type Browser, type Page } from '@playwright/test';
import { ORIGIN } from './browsers.ts';
import type { Heard, Report } from './client.ts';
import type { ServiceStats } from './signalling.ts';

// The nth person to join a room gets key id n and, where they send a tone, this one.
export const toneOf = (n: number) => 400 + 150 * n;

// A person sends a tone of their own, made by Web Audio, where the engine can:
// then a listener can tell whose voice it decoded. A WebKit person sends the
// mock microphone instead (browsers.ts), and every WebKit person sounds alike.
export type Person = { page: Page; kid: number; tone: boolean };

export async function open(
	browser: Browser,
	room: string,
	options: Record<string, string | number> = {}
): Promise<Page> {
	// Firefox allows the microphone through its launch settings; the others take
	// it as a permission. Every Chromium or Firefox context can capture at once.
	// WebKit lets one page capture at a time and mutes the others, as Safari does
	// between tabs, so each WebKit person gets a browser of their own.
	const engine = browser.browserType().name();
	const webkit = engine === 'webkit';
	const own = webkit ? await browser.browserType().launch() : null;
	const context = await (own ?? browser).newContext(
		engine === 'firefox' ? {} : { permissions: ['microphone'] }
	);
	const page = await context.newPage();
	page.on('close', () => void own?.close());
	if (process.env.VOICE_DEBUG) {
		page.on('console', (message) => console.log(`[${room}] ${message.text()}`));
		page.on('pageerror', (error) => console.log(`[${room}] ${error}`));
	}
	const query = new URLSearchParams({ room });
	for (const [key, value] of Object.entries(options)) query.set(key, String(value));
	await page.goto(`${ORIGIN}/?${query}`);
	await page.locator('#join').click();
	return page;
}

// People join one after another, so the nth gets key id n.
export async function join(
	browser: Browser,
	room: string,
	kid: number,
	options: Record<string, string | number> = {}
): Promise<Person> {
	const webkit = browser.browserType().name() === 'webkit';
	const tone = !webkit && options.source !== 'capture';
	const page = await open(browser, room, {
		...(tone ? { freq: toneOf(kid) } : { source: 'capture' }),
		...(webkit ? { webaudio: 0 } : {}),
		...options
	});
	await expect(page.locator('body')).toHaveAttribute('data-voice', 'joined', { timeout: 30_000 });
	return { page, kid, tone };
}

export const report = (person: Person, listenMs = 0): Promise<Report> =>
	person.page.evaluate((ms) => window.voice.report(ms), listenMs);

// A listener decoded real audio from this sender, with little of it concealed.
// With an analyser the listener measures the sound itself, and its tone where
// the sender has one; without, WebRTC's count of decoded energy stands in.
// (Chromium counts no energy for a track whose only output is a muted element.)
export function expectHeard(one: Heard, from: Person, label: string): void {
	if (one.rms !== null) expect(one.rms, `${label}: rms`).toBeGreaterThan(0.005);
	else expect(one.energy, `${label}: energy`).toBeGreaterThan(0.0001);
	expect(one.totalSamplesReceived, `${label}: samples`).toBeGreaterThan(24_000);
	expect(one.concealedSamples / one.totalSamplesReceived, `${label}: concealed`).toBeLessThan(0.5);
	if (from.tone && one.peakHz !== null) {
		expect(Math.abs(one.peakHz - toneOf(from.kid)), `${label}: tone`).toBeLessThan(10);
		expect(one.peakDb, `${label}: level`).toBeGreaterThan(-40);
	}
}

// A listener decoded nothing from this sender.
export function expectSilence(one: Heard, label: string): void {
	if (one.rms !== null) expect(one.rms, `${label}: rms`).toBeLessThan(0.001);
	else expect(one.energy, `${label}: energy`).toBe(0);
}

// Every person hears every other person, decrypted, with nothing refused.
export async function everyoneHearsEveryone(people: Person[]): Promise<Report[]> {
	let reports: Report[] = [];
	await expect(async () => {
		// Long enough to catch a beep of a mock microphone, which is silent in between.
		reports = await Promise.all(people.map((person) => report(person, 1200)));
		for (const [index, mine] of reports.entries()) {
			const me = people[index];
			const others = people.filter((other) => other !== me);
			expect(mine.kid).toBe(me.kid);
			expect(mine.connection).toEqual({ send: 'connected', recv: 'connected' });
			expect(mine.heard.map((one) => one.kid).sort((a, b) => a - b)).toEqual(
				others.map((other) => other.kid)
			);
			for (const one of mine.heard) {
				const from = others.find((other) => other.kid === one.kid)!;
				expectHeard(one, from, `key ${one.kid} at key ${me.kid}`);
			}
			const sent = mine.transforms.find((one) => one.direction === 'encrypt')!;
			expect(sent.frames).toBeGreaterThan(50);
			expect(sent.failed).toBe(0);
			const received = mine.transforms.filter((one) => one.direction === 'decrypt');
			expect(received).toHaveLength(others.length);
			for (const one of received) {
				expect(one.frames).toBeGreaterThan(50);
				expect(one.failed).toBe(0);
			}
		}
	}).toPass({ timeout: 60_000 });
	return reports;
}

export async function serviceStats(): Promise<ServiceStats> {
	return (await fetch(`${ORIGIN}/stats`)).json() as Promise<ServiceStats>;
}

// What the keyless listener at the SFU saw of a room, once it has seen its fill.
export async function tapsOf(room: string, people: number): Promise<ServiceStats['taps']> {
	let taps: ServiceStats['taps'] = [];
	await expect(async () => {
		taps = (await serviceStats()).taps.filter((tap) => tap.room === room);
		expect(taps).toHaveLength(people);
		for (const tap of taps) expect(tap.packets).toBeGreaterThanOrEqual(150);
	}).toPass({ timeout: 30_000 });
	return taps;
}

export async function leave(people: Person[]): Promise<void> {
	for (const { page } of people) await page.context().close();
}
