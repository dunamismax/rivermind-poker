// Table voice on a deployed site (P4C.9); see playwright.live.config.ts. Two
// guests at a private table join voice with fake microphones, through the
// site's own /voice route and the voice service's public media port, see one
// voice code, hear each other, and mute and unmute. Then three people in
// three engines share one table. A site that does not offer voice skips this.
//
// Each person is a browser of their own (e2e/voice.ts). Chromium cannot
// capture on macOS, so there its person is refused the microphone and listens
// to a Firefox speaker; on Linux both speak.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canCapture, canTransform } from '../voice/check/browsers.ts';
import { nameOf, newTableForm, seated, sitDown } from './fixtures.ts';
import {
	card,
	closePanel,
	diagnostics,
	engineOf,
	openPanel,
	person,
	voiceOf,
	type Engine,
	type Person
} from './voice.ts';

test.describe.configure({ timeout: 300_000 });

// A live call takes a real network both ways, so waits are longer than at home.
const JOIN_MS = 90_000;
const SPEAK_MS = 60_000;

async function offered(request: APIRequestContext): Promise<boolean> {
	const answer = await request.get('/api/voice');
	return answer.ok() && ((await answer.json()) as { offered?: boolean }).offered === true;
}

/** The link that seats a guest at the host's private table. */
async function inviteLink(host: Page): Promise<string> {
	await host.getByRole('button', { name: 'Invite' }).click();
	const link = await host.getByRole('textbox', { name: 'Invite link' }).inputValue();
	await host.getByRole('button', { name: 'Invite' }).click();
	return link;
}

async function takeSeat(guest: Page, link: string): Promise<string> {
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

const seatOf = async (page: Page) => (await seated(page).getAttribute('data-seat'))!;

/** Join from the card; someone with no microphone here is told so and listens. */
async function join(one: Person, mic: boolean): Promise<void> {
	await expect(card(one.page)).toBeVisible({ timeout: 30_000 });
	await expect(card(one.page)).toContainText('end-to-end encrypted');
	await expect(card(one.page)).toContainText('18+');
	await card(one.page).getByRole('button', { name: 'Join voice' }).click();
	if (mic) await closePanel(one.page);
	else await expect(card(one.page).getByRole('alert')).toContainText(/microphone/);
}

/** Everyone is in one group: the same four words, on screen as in the group. */
async function sameCode(people: Person[]): Promise<string> {
	await expect(async () => {
		const all = await Promise.all(people.map((one) => diagnostics(one.page)));
		for (const one of all) {
			expect(one.phase).toBe('in');
			expect(one.code).toHaveLength(4);
			expect(one.code).toEqual(all[0].code);
		}
	}).toPass({ timeout: JOIN_MS });
	const words = (await diagnostics(people[0].page)).code!.join(' · ');
	for (const one of people) {
		await openPanel(one.page);
		await expect(card(one.page).locator('.voice-code')).toHaveText(words);
		await closePanel(one.page);
	}
	return words;
}

const hears = (listener: Person, seat: string, timeout = SPEAK_MS) =>
	expect(voiceOf(listener.page, seat)).toHaveAttribute('data-speaking', 'true', { timeout });

async function leaveTable(one: Person): Promise<void> {
	await one.page.getByRole('button', { name: 'Leave table' }).click();
	await expect(newTableForm(one.page).getByRole('button', { name: 'Sit down' })).toBeVisible();
}

test('two guests join table voice, hear each other, mute and unmute, and see one voice code', async ({
	browser,
	baseURL,
	request
}, testInfo) => {
	test.skip(!(await offered(request)), 'this site does not offer table voice');
	const engine = engineOf(browser);
	test.skip(!canTransform(engine), 'this build of the engine cannot seal frames');
	const speakerEngine: Engine = canCapture(engine) ? engine : 'firefox';
	const listenerMic = canCapture(engine);
	const alice = await person(speakerEngine, testInfo, baseURL!, { mic: true });
	const bob = await person(engine, testInfo, baseURL!, { mic: listenerMic });
	try {
		await sitDown(alice.page, 3, { bots: /No bots/, privateTable: true });
		const bobName = await takeSeat(bob.page, await inviteLink(alice.page));
		await expect(alice.page.locator('.seat').filter({ hasText: bobName })).toBeVisible();
		const aliceSeat = await seatOf(alice.page);
		const bobSeat = await seatOf(bob.page);

		await join(alice, true);
		await join(bob, listenerMic);
		await sameCode([alice, bob]);

		// Alice talks: her microphone is marked live, and Bob hears her.
		await expect(alice.page.getByRole('img', { name: 'Microphone live' }).first()).toBeVisible();
		await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-voice', 'talking');
		await hears(bob, aliceSeat);
		// And Bob, where his engine has a microphone here: Alice hears him.
		await expect(voiceOf(alice.page, bobSeat)).toHaveAttribute(
			'data-voice',
			listenerMic ? 'talking' : 'listening'
		);
		if (listenerMic) await hears(alice, bobSeat);

		// M mutes Alice: both screens say so, and Bob hears nothing.
		await alice.page.keyboard.press('m');
		await expect(voiceOf(alice.page, aliceSeat)).toHaveAttribute('data-voice', 'muted');
		await expect(alice.page.getByRole('img', { name: 'Microphone live' })).toHaveCount(0);
		await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-voice', 'muted');
		await expect(voiceOf(bob.page, aliceSeat)).not.toHaveAttribute('data-speaking', 'true', {
			timeout: 15_000
		});
		// The button unmutes, and he hears her again.
		await alice.page.getByRole('button', { name: 'Mute', exact: true }).click();
		await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-voice', 'talking');
		await hears(bob, aliceSeat);

		// Bob leaves voice, and Alice sees him out of it.
		await openPanel(bob.page);
		await card(bob.page).getByRole('button', { name: 'Leave voice' }).click();
		await expect(voiceOf(alice.page, bobSeat)).toHaveAttribute('data-voice', 'out', {
			timeout: 30_000
		});
		expect(alice.violations).toEqual([]);
		expect(bob.violations).toEqual([]);
		await leaveTable(bob);
		await leaveTable(alice);
	} finally {
		await alice.close();
		await bob.close();
	}
});

test('three people in Chromium, Firefox and WebKit share one table’s voice', async ({
	browser,
	baseURL,
	request
}, testInfo) => {
	// Once a run is enough: every engine takes part whichever project starts it.
	test.skip(engineOf(browser) !== 'chromium', 'the Chromium project runs this for all three');
	test.skip(!(await offered(request)), 'this site does not offer table voice');
	test.skip(!canTransform('webkit'), 'this build of WebKit cannot seal frames');
	const chromiumMic = canCapture('chromium');
	// Desktop Firefox, desktop Chromium and WebKit at a phone's size.
	const desktop = { width: 1440, height: 900, touch: false };
	const fox = await person('firefox', testInfo, baseURL!, { mic: true, size: desktop });
	const chrome = await person('chromium', testInfo, baseURL!, { mic: chromiumMic, size: desktop });
	const phone = await person('webkit', testInfo, baseURL!, {
		mic: true,
		size: { width: 375, height: 812, touch: true }
	});
	const people = [fox, chrome, phone];
	try {
		await sitDown(fox.page, 6, { bots: /No bots/, privateTable: true });
		const link = await inviteLink(fox.page);
		await takeSeat(chrome.page, link);
		await takeSeat(phone.page, link);
		const foxSeat = await seatOf(fox.page);
		const chromeSeat = await seatOf(chrome.page);
		const phoneSeat = await seatOf(phone.page);

		await join(fox, true);
		await join(chrome, chromiumMic);
		await join(phone, true);
		// One group of three, and the same words on every screen.
		await sameCode(people);
		// Each holds a stream from everyone else who has a microphone here.
		const speakers = chromiumMic ? people : [fox, phone];
		await expect(async () => {
			for (const one of people) {
				const others = speakers.filter((speaker) => speaker !== one).length;
				expect((await diagnostics(one.page)).heard).toHaveLength(others);
			}
		}).toPass({ timeout: JOIN_MS });

		// Each speaker is heard by the other two.
		await hears(chrome, foxSeat);
		await hears(phone, foxSeat);
		await hears(fox, phoneSeat);
		await hears(chrome, phoneSeat);
		if (chromiumMic) {
			await hears(fox, chromeSeat);
			await hears(phone, chromeSeat);
		}

		// The phone leaves the table: the other two move on together, to new words.
		const before = (await diagnostics(fox.page)).code!.join(' ');
		await leaveTable(phone);
		await expect(async () => {
			const [a, b] = await Promise.all([diagnostics(fox.page), diagnostics(chrome.page)]);
			expect(a.heard).toHaveLength(chromiumMic ? 1 : 0);
			expect(b.heard).toHaveLength(1);
			expect(a.code!.join(' ')).not.toBe(before);
			expect(b.code).toEqual(a.code);
		}).toPass({ timeout: JOIN_MS });
		await hears(chrome, foxSeat);

		for (const one of people) expect(one.violations).toEqual([]);
		await leaveTable(chrome);
		await leaveTable(fox);
	} finally {
		for (const one of people) await one.close();
	}
});
