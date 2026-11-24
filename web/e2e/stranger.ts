// Someone in a table's voice group who is not seated (P7.1b): how the browser
// tests bring it about honestly, with nothing in the site or the voice service
// changed for it. voice.e2e.ts uses it against a voice service of its own, and
// stranger.tool.ts against a deployed site.
//
// It rests on the rule the group already has for removals (room.ts): when the
// service proposes removing someone, the member with the lowest leaf commits
// at once and each member after it a second later (`COMMIT_TURN_MS`). So a
// group whose earlier members have hung keeps someone who left. Here they hang
// for real: their pages are paused in Chromium's debugger, as a page whose
// script has stopped.
//
//   1. A host and `hung` − 1 others sit at a private table and listen in voice,
//      and a ghost listens too. They share one group.
//   2. They all hang but the ghost, who leaves the table: the service takes it
//      out of the room and proposes its removal, and nobody awake is left to
//      commit it, so its leaf stays in the group.
//   3. Whoever sits down and joins voice next finds the ghost in the group, never
//      seated at the table as far as their page knows: their panel warns and
//      their microphone is held, until their own turn to commit the removal
//      comes, `hung` seconds after they joined.
import { expect, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { nameOf, newTableForm, seated, sitDown } from './fixtures.ts';
import { card, diagnostics, person, type Person } from './voice.ts';

export const STRANGER_WARNING =
	'Someone who is not seated at this table is in the voice group. Your microphone is off until they are gone.';

const JOIN_MS = 90_000;

export const strangerWarning = (page: Page) =>
	card(page).getByRole('alert').filter({ hasText: STRANGER_WARNING });

export async function inviteLink(host: Page): Promise<string> {
	await host.getByRole('button', { name: 'Invite' }).click();
	const link = await host.getByRole('textbox', { name: 'Invite link' }).inputValue();
	await host.getByRole('button', { name: 'Invite' }).click();
	return link;
}

export async function takeSeat(guest: Page, link: string): Promise<string> {
	await guest.goto('/');
	const name = await nameOf(guest);
	await guest.goto(link);
	await guest
		.getByRole('region', { name: 'You are invited' })
		.getByRole('button', { name: 'Take a seat' })
		.click();
	await expect(seated(guest)).toBeVisible({ timeout: 60_000 });
	return name;
}

export async function leaveTable(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Leave table' }).click();
	await expect(newTableForm(page).getByRole('button', { name: 'Sit down' })).toBeVisible();
}

async function listen(one: Person): Promise<void> {
	await expect(card(one.page)).toBeVisible({ timeout: 30_000 });
	await card(one.page).getByRole('button', { name: 'Listen only' }).click();
	await expect(async () => expect((await diagnostics(one.page)).phase).toBe('in')).toPass({
		timeout: JOIN_MS
	});
}

/** Stops a page's script where it stands, as a page that has hung. */
async function hang(page: Page): Promise<CDPSession> {
	const session = await page.context().newCDPSession(page);
	await session.send('Debugger.enable');
	const paused = new Promise<void>((done) => session.once('Debugger.paused', () => done()));
	await session.send('Debugger.pause');
	await paused;
	return session;
}

export type GhostTable = {
	// The invite link to the table, for whoever sits down next.
	link: string;
	// Wakes the hung members and has them leave the table, the host last.
	leave: () => Promise<void>;
	// Closes every browser, awake or not.
	close: () => Promise<void>;
};

/**
 * Steps 1 and 2: a private table of `hung` listeners in Chromium, paused, whose
 * voice group holds a ghost who has left the table.
 */
export async function ghostTable(
	testInfo: TestInfo,
	baseURL: string,
	hung: number
): Promise<GhostTable> {
	const members: Person[] = [];
	const debuggers: CDPSession[] = [];
	let ghost: Person | null = null;
	const close = async () => {
		for (const session of debuggers.splice(0)) {
			await session.send('Debugger.resume').catch(() => {});
		}
		for (const one of [...members, ghost]) await one?.close();
	};
	try {
		const listener = () => person('chromium', testInfo, baseURL, { mic: false });
		for (let n = 0; n < hung; n += 1) members.push(await listener());
		ghost = await listener();
		await sitDown(members[0].page, 9, { bots: /No bots/, privateTable: true });
		const link = await inviteLink(members[0].page);
		for (const one of [...members.slice(1), ghost]) await takeSeat(one.page, link);
		for (const one of [...members, ghost]) await listen(one);
		await expect(async () => {
			const codes = await Promise.all(
				[...members, ghost!].map(async (one) => (await diagnostics(one.page)).code?.join(' '))
			);
			expect(codes[0]).toBeTruthy();
			for (const code of codes) expect(code).toBe(codes[0]);
		}).toPass({ timeout: JOIN_MS });

		for (const one of members) debuggers.push(await hang(one.page));
		await leaveTable(ghost.page);
		await ghost.close();
		ghost = null;
		return {
			link,
			close,
			leave: async () => {
				for (const session of debuggers.splice(0)) await session.send('Debugger.resume');
				for (const one of [...members.slice(1), members[0]]) await leaveTable(one.page);
			}
		};
	} catch (error) {
		await close();
		throw error;
	}
}

export type Moment = {
	ms: number;
	warned: boolean;
	live: boolean;
	phase: string;
	panel: boolean;
	alerts: string;
};

/**
 * Step 3's screen: what a page shows every tenth of a second from `since`, each
 * change once, until the warning has come and gone and the microphone sends, or
 * `untilMs` has passed. `onchange` is told each change, as it is seen.
 */
export async function watch(
	page: Page,
	since: number,
	untilMs: number,
	onchange: (moment: Moment) => Promise<void> = async () => {}
): Promise<Moment[]> {
	const seen: Moment[] = [];
	for (;;) {
		const warned = await strangerWarning(page).isVisible();
		const now = await diagnostics(page);
		const alerts = (await page.getByRole('alert').allTextContents())
			.map((text) => text.replace(/\s+/g, ' ').trim())
			.join(' | ');
		const panel = await card(page).isVisible();
		const moment = {
			ms: Date.now() - since,
			warned,
			live: now.live,
			phase: now.phase,
			panel,
			alerts
		};
		const last = seen.at(-1);
		if (
			!last ||
			last.warned !== warned ||
			last.live !== now.live ||
			last.phase !== now.phase ||
			last.panel !== panel ||
			last.alerts !== alerts
		) {
			seen.push(moment);
			await onchange(moment);
		}
		if (seen.some((one) => one.warned) && !warned && now.live) return seen;
		if (Date.now() - since > untilMs) return seen;
		await page.waitForTimeout(100);
	}
}
