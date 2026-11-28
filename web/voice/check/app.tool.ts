// Voice's design check for the iPhone app (P5D.9), candidate (b): the site's own
// voice code in the app's web view (ios/RiverMind/VoiceCheckView.swift), in a
// table's voice room on the voice service with a person in Chromium. Run by
// hand on a Mac with a booted simulator that has a debug build of the app
// installed (`pnpm voice:app`, which says how); never in CI.
//
// It checks that the two hear each other with every frame sealed and opened,
// on one epoch with one voice code; measures the web view's processes' CPU and
// memory over a minute of talk; then sends the app to the background and back
// and says whether its audio kept going (Q-16). What it finds goes to
// artifacts/voice-app/<time>.json and docs/voice.md records it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { identity, join, joining, newTable, report, type Person } from './people.ts';
import type { RoomReport } from './room.ts';
import { ORIGIN } from './vite.config.ts';

const device = process.env.VOICE_APP_DEVICE;
// 1: the web view in no window; 2: in the window as a transparent point.
const hidden = process.env.VOICE_APP_HIDDEN ?? '0';
const app = 'com.rivermindpoker.app';
const root = path.resolve(import.meta.dirname, '../../..');

type Posted = { room?: string; at?: number; report?: RoomReport; error?: string };

async function appReport(name: string, since: number): Promise<RoomReport | null> {
	const kept = (await (await fetch(`${ORIGIN}/results`)).json()) as Posted[];
	const mine = kept.filter((one) => one.room === name && (one.at ?? 0) >= since);
	const failed = mine.find((one) => one.error);
	if (failed) throw new Error(`the app's page: ${failed.error}`);
	return mine.at(-1)?.report ?? null;
}

const simctl = (...args: string[]) =>
	execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim();
const quietly = (run: () => string) => {
	try {
		return run();
	} catch {
		return null;
	}
};

// The app's process and the web view's three, by the app's parent (the
// simulator's launchd), as `ps` sees them on this Mac.
function processes(appPid: number): { name: string; pid: number }[] {
	const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
		encoding: 'utf8',
		maxBuffer: 1 << 26
	})
		.split('\n')
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
		.filter((match) => match !== null);
	const parent = rows.find((row) => Number(row[1]) === appPid)?.[2];
	return rows
		.filter((row) => row[2] === parent)
		.map((row) => {
			const name = row[3].match(/com\.apple\.WebKit\.(WebContent|GPU|Networking)/)?.[1];
			if (Number(row[1]) === appPid) return { name: 'app', pid: appPid };
			return name ? { name, pid: Number(row[1]) } : null;
		})
		.filter((one) => one !== null);
}

// CPU (a share of one core, as `ps` reckons it over the process's recent life)
// and resident memory, sampled each second for `seconds`.
async function usage(appPid: number, seconds: number) {
	const procs = processes(appPid);
	const samples = new Map<string, { cpu: number[]; rssMb: number[] }>();
	for (let i = 0; i < seconds; i++) {
		const out = execFileSync(
			'ps',
			['-o', 'pid=,%cpu=,rss=', '-p', procs.map((p) => p.pid).join(',')],
			{
				encoding: 'utf8'
			}
		);
		for (const line of out.trim().split('\n')) {
			const [pid, cpu, rss] = line.trim().split(/\s+/).map(Number);
			const name = procs.find((p) => p.pid === pid)!.name;
			const one = samples.get(name) ?? { cpu: [], rssMb: [] };
			one.cpu.push(cpu);
			one.rssMb.push(rss / 1024);
			samples.set(name, one);
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
	return Object.fromEntries(
		[...samples].map(([name, { cpu, rssMb }]) => [
			name,
			{ cpuPercent: mean(cpu), rssMb: Math.round(Math.max(...rssMb)) }
		])
	);
}

const heardFrom = (mine: RoomReport, leaf: number | null) =>
	mine.heard.find((one) => one.leaf === leaf);

test('the app and a browser talk in one voice room', async ({ browser }) => {
	test.skip(!device, 'VOICE_APP_DEVICE names the simulator the app is installed on');
	const table = newTable();
	const person: Person = await join(browser, table, 1, [1, 2]);
	const name = `app-${table}`;
	// A Web Audio tone by default; VOICE_APP_SOURCE=capture uses the simulator's
	// microphone, which gives silence on this Mac but shows what capture does.
	const source = process.env.VOICE_APP_SOURCE === 'capture' ? 'capture' : 'tone';
	const options = { ...joining('webkit', table, 2, [1, 2]), source, webAudio: true, report: name };
	const url = `${ORIGIN}/room.html#join=${encodeURIComponent(JSON.stringify(options))}`;
	const started = Date.now();
	quietly(() => simctl('terminate', device!, app));
	const launched = execFileSync('xcrun', ['simctl', 'launch', device!, app], {
		encoding: 'utf8',
		env: {
			...process.env,
			SIMCTL_CHILD_RIVERMIND_VOICE_CHECK: url,
			SIMCTL_CHILD_RIVERMIND_VOICE_CHECK_HIDDEN: hidden
		}
	});
	const appPid = Number(launched.trim().split(/\s+/).at(-1));

	// Both on one epoch with one code, each hearing the other's audio opened.
	let mine: RoomReport | null = null;
	let theirs: RoomReport | null = null;
	await expect(async () => {
		mine = await appReport(name, started);
		theirs = await report(person, 1200);
		expect(mine, 'the app has posted a report').not.toBeNull();
		expect(mine!.epoch).not.toBeNull();
		expect(mine!.epoch).toBe(theirs.epoch);
		expect(mine!.code).toEqual(theirs.code);
		expect(mine!.seatsOk).toBe(true);
		expect(mine!.connection).toEqual({ send: 'connected', recv: 'connected' });
		expect(heardFrom(mine!, theirs.leaf)?.rms ?? 0).toBeGreaterThan(0.005);
		expect(heardFrom(theirs, mine!.leaf)?.rms ?? 0).toBeGreaterThan(0.005);
	}).toPass({ timeout: 60_000, intervals: [1000] });
	const joinedMs = Date.now() - started;

	// A minute of both sending a tone.
	const cost = await usage(appPid, 60);
	const after = (await appReport(name, started))!;
	const afterAt = Date.now();
	const peer = await report(person, 1200);

	// The background: another app in front for twenty seconds. The browser's
	// count of packets from the app between five and twenty seconds in is the
	// app's steady rate there.
	const pps = (from: { packetsReceived: number }, to: { packetsReceived: number }, ms: number) =>
		Math.round(((to.packetsReceived - from.packetsReceived) / ms) * 1000);
	simctl('launch', device!, 'com.apple.Preferences');
	await new Promise((resolve) => setTimeout(resolve, 5000));
	const early = heardFrom(await report(person), after.leaf)!;
	const earlyAt = Date.now();
	await new Promise((resolve) => setTimeout(resolve, 15_000));
	const late = heardFrom(await report(person, 1200), after.leaf)!;
	const inBackgroundAt = Date.now();
	const inBackground = await appReport(name, inBackgroundAt - 4000);
	const backgroundPps = pps(early, late, Date.now() - earlyAt);
	execFileSync('xcrun', ['simctl', 'launch', device!, app], { encoding: 'utf8' });
	await new Promise((resolve) => setTimeout(resolve, 5000));
	const back = heardFrom(await report(person), after.leaf)!;
	const backAt = Date.now();
	await new Promise((resolve) => setTimeout(resolve, 5000));
	const backLater = heardFrom(await report(person, 1200), after.leaf)!;
	const backReport = await appReport(name, Date.now() - 4000);

	const result = {
		date: new Date().toISOString(),
		hidden,
		source,
		runtime: quietly(() => simctl('getenv', device!, 'SIMULATOR_RUNTIME_VERSION')),
		joinedMs,
		app: {
			handler: after.handler,
			epoch: after.epoch,
			code: after.code,
			path: after.path,
			transforms: after.transforms,
			heard: after.heard
		},
		browser: {
			handler: peer.handler,
			code: peer.code,
			heard: peer.heard,
			transforms: peer.transforms
		},
		cost,
		background: {
			// What the browser received from the app, and what the app's page said of itself.
			packetsPerSecond: backgroundPps,
			rms: late.rms,
			pagePosted: inBackground !== null,
			pageHeard: inBackground ? (heardFrom(inBackground, peer.leaf)?.rms ?? null) : null,
			// Samples the app's page decoded from the browser each second, by WebRTC's
			// count, from the minute's end to the last report in the background: about
			// 48,000 while it still plays what it hears.
			pageSamplesPerSecond: inBackground
				? Math.round(
						((heardFrom(inBackground, peer.leaf)?.totalSamplesReceived ?? 0) -
							(heardFrom(after, peer.leaf)?.totalSamplesReceived ?? 0)) /
							((inBackgroundAt - afterAt) / 1000)
					)
				: null,
			local: inBackground?.local ?? null,
			connection: inBackground?.connection ?? null,
			closed: inBackground?.closed ?? null
		},
		foregroundAgain: {
			packetsPerSecond: pps(back, backLater, Date.now() - backAt),
			rms: backLater.rms,
			pageHeard: backReport ? (heardFrom(backReport, peer.leaf)?.rms ?? null) : null,
			local: backReport?.local ?? null,
			closed: backReport?.closed ?? null
		},
		identity: identity(2)
	};
	const out = path.join(root, 'artifacts', 'voice-app');
	mkdirSync(out, { recursive: true });
	const file = path.join(out, `${result.date.replace(/[:.]/g, '-')}-view${hidden}-${source}.json`);
	writeFileSync(file, JSON.stringify(result, null, '\t'));
	console.log(JSON.stringify(result, null, 2));
	console.log(`written to ${file}`);

	for (const tally of [...after.transforms, ...peer.transforms]) {
		expect(tally.unsent).toBe(0);
		expect(Object.values(tally.refused).every((n) => n === 0)).toBe(true);
	}
	quietly(() => simctl('terminate', device!, app));
});
