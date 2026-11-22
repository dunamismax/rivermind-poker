// Table voice at the table (P4C.6), against the built Node server with a voice
// service of its own (e2e/server.ts): two people at a private table take the
// voice card, hear each other through the voice service with every frame
// sealed in their pages, see one voice code, and use each control: mute and
// deafen by button and key, push-to-talk, each player's mute and volume, and
// leaving voice. A practice table and a table with only bots offer none.
//
// Each person is a browser of their own, started with the engine's fake
// microphone (voice/check/browsers.ts). Where an engine cannot capture here
// (Chromium on macOS), its person is refused the microphone, which is checked
// too, and a Firefox person speaks to them.
import {
	expect,
	firefox,
	test as base,
	type Browser,
	type BrowserContextOptions,
	type Page,
	type TestInfo
} from '@playwright/test';
import { canCapture, canTransform, launch } from '../voice/check/browsers.ts';
import { nameOf, seated, sitDown, tableIdOf } from './fixtures.ts';
import { TableServer } from './server.ts';

type Engine = 'chromium' | 'firefox' | 'webkit';
type Person = { page: Page; violations: string[]; close: () => Promise<void> };

const test = base.extend<object, { voiceServer: TableServer }>({
	voiceServer: [
		// eslint-disable-next-line no-empty-pattern
		async ({}, use, workerInfo) => {
			const server = new TableServer(8860 + workerInfo.parallelIndex, {
				voicePort: 8880 + workerInfo.parallelIndex
			});
			await server.start();
			await use(server);
			await server.dispose();
		},
		{ scope: 'worker', timeout: 90_000 }
	],
	baseURL: async ({ voiceServer }, use) => use(voiceServer.url)
});

const engineOf = (browser: Browser) => browser.browserType().name() as Engine;

// A person in a browser of their own: with a microphone the engine can fake here, or
// (`mic: false`) none, so asking for one is refused.
async function person(
	engine: Engine,
	testInfo: TestInfo,
	baseURL: string,
	{ mic }: { mic: boolean }
): Promise<Person> {
	const type = engine === 'firefox' ? firefox : (await import('@playwright/test'))[engine];
	const options =
		mic || engine !== 'chromium'
			? launch[engine]
			: { args: ['--autoplay-policy=no-user-gesture-required'] };
	const own = await type.launch(options);
	const use = testInfo.project.use;
	const context: BrowserContextOptions = {
		baseURL,
		viewport: use.viewport ?? { width: 1440, height: 900 },
		hasTouch: use.hasTouch ?? false,
		...(mic && engine !== 'firefox' ? { permissions: ['microphone'] } : {})
	};
	const page = await (await own.newContext(context)).newPage();
	const violations: string[] = [];
	await page.exposeFunction('__reportCsp', (text: string) => violations.push(text));
	await page.addInitScript(() => {
		document.addEventListener('securitypolicyviolation', (e) => {
			(window as unknown as { __reportCsp: (t: string) => void }).__reportCsp(
				`${e.violatedDirective} ${e.blockedURI}`
			);
		});
	});
	if (process.env.VOICE_DEBUG) page.on('console', (m) => console.log(`[${engine}] ${m.text()}`));
	return { page, violations, close: () => own.close() };
}

const card = (page: Page) => page.getByRole('dialog', { name: 'Table voice' });
const voiceButton = (page: Page) => page.getByRole('button', { name: /^Voice/ });
const seatAt = (page: Page, seat: string) => page.locator(`.seat[data-seat="${seat}"]`);
const voiceOf = (page: Page, seat: string) => seatAt(page, seat).locator('.voice');

type Diagnostics = {
	phase: string;
	output: string | null;
	heard: { seat: number | null; gain: number | null; pan: number | null; speaking: boolean }[];
	code: string[] | null;
	live: boolean;
};
const diagnostics = (page: Page) =>
	page.evaluate(() =>
		(window as unknown as { rivermindVoice: () => Diagnostics }).rivermindVoice()
	);

async function openPanel(page: Page): Promise<void> {
	if (!(await card(page).isVisible())) await voiceButton(page).click();
	await expect(card(page)).toBeVisible();
}

async function closePanel(page: Page): Promise<void> {
	if (await card(page).isVisible()) await card(page).getByRole('button', { name: 'Close' }).click();
	await expect(card(page)).toHaveCount(0);
}

test.describe('table voice', () => {
	test.describe.configure({ timeout: 240_000 });

	test('two people join, hear each other, share a voice code and use every control', async ({
		browser,
		baseURL
	}, testInfo) => {
		const engine = engineOf(browser);
		const transforms = canTransform(engine);
		// The speaker sends a fake microphone; the listener is the project's engine,
		// refused the microphone where it cannot capture here.
		const speakerEngine: Engine = canCapture(engine) ? engine : 'firefox';
		const listenerMic = canCapture(engine);
		const alice = await person(speakerEngine, testInfo, baseURL!, { mic: true });
		const bob = await person(engine, testInfo, baseURL!, { mic: listenerMic });
		try {
			await sitDown(alice.page, 3, { bots: /No bots/, privateTable: true });
			const tableId = await tableIdOf(alice.page);
			expect(tableId).toBeTruthy();
			await alice.page.getByRole('button', { name: 'Invite' }).click();
			const link = await alice.page.getByRole('textbox', { name: 'Invite link' }).inputValue();
			await alice.page.getByRole('button', { name: 'Invite' }).click();
			await bob.page.goto('/');
			const bobName = await nameOf(bob.page);
			await bob.page.goto(link);
			await bob.page
				.getByRole('region', { name: 'You are invited' })
				.getByRole('button', { name: 'Take a seat' })
				.click();
			await expect(seated(bob.page)).toBeVisible();
			const aliceSeat = (await seated(alice.page).getAttribute('data-seat'))!;
			const bobSeat = (await seated(bob.page).getAttribute('data-seat'))!;
			await expect(alice.page.locator('.seat').filter({ hasText: bobName })).toBeVisible();

			// Sitting down with someone else brings the card, saying what voice is.
			for (const one of [alice, bob]) {
				await expect(card(one.page)).toBeVisible();
				await expect(card(one.page)).toContainText('end-to-end encrypted');
				await expect(card(one.page)).toContainText('18+');
			}

			if (!transforms) {
				// Playwright's WebKit on Linux cannot seal frames: voice does not start, and says why.
				await card(bob.page).getByRole('button', { name: 'Join voice' }).click();
				await expect(card(bob.page)).toContainText('cannot encrypt voice end to end');
				return;
			}

			await card(alice.page).getByRole('button', { name: 'Join voice' }).click();
			await card(bob.page).getByRole('button', { name: 'Join voice' }).click();
			if (!listenerMic) {
				// Refused the microphone: told how to allow it, and listening meanwhile.
				await expect(card(bob.page).getByRole('alert')).toContainText(/microphone/);
				await expect(card(bob.page)).toContainText('listen');
			} else {
				await closePanel(bob.page);
			}

			// Both are in one group: the same four words, and each other's glyph.
			await expect(async () => {
				const [a, b] = await Promise.all([diagnostics(alice.page), diagnostics(bob.page)]);
				expect(a.phase).toBe('in');
				expect(b.phase).toBe('in');
				expect(a.code).toHaveLength(4);
				expect(b.code).toEqual(a.code);
			}).toPass({ timeout: 60_000 });
			await openPanel(alice.page);
			const words = (await diagnostics(alice.page)).code!.join(' · ');
			await expect(card(alice.page).locator('.voice-code')).toHaveText(words);
			await openPanel(bob.page);
			await expect(card(bob.page).locator('.voice-code')).toHaveText(words);
			await closePanel(alice.page);
			await closePanel(bob.page);

			// Alice talks: her microphone is marked live, and Bob sees her speak.
			await expect(alice.page.getByRole('img', { name: 'Microphone live' }).first()).toBeVisible();
			await expect(voiceOf(alice.page, aliceSeat)).toHaveAttribute('data-voice', 'talking');
			await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-voice', 'talking');
			await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-speaking', 'true', {
				timeout: 30_000
			});
			await expect(voiceOf(alice.page, bobSeat)).toHaveAttribute(
				'data-voice',
				listenerMic ? 'talking' : 'listening'
			);

			// Each voice goes through Bob's graph where the engine has one, from its seat's side
			// of the table: at three seats Alice sits to one side of Bob, never in the middle.
			if ((await diagnostics(bob.page)).output !== 'elements') {
				const pan = (await diagnostics(bob.page)).heard[0].pan!;
				expect(Math.abs(pan)).toBeGreaterThan(0.5);
				await openPanel(bob.page);
				await card(bob.page).getByText('Voice settings').click();
				await card(bob.page)
					.getByRole('checkbox', { name: /seat's side/ })
					.uncheck();
				expect((await diagnostics(bob.page)).heard[0].pan).toBe(0);
				await card(bob.page)
					.getByRole('checkbox', { name: /seat's side/ })
					.check();
				expect((await diagnostics(bob.page)).heard[0].pan).toBe(pan);
				await closePanel(bob.page);
			}

			// Typing in a field is not a key for voice.
			await alice.page.getByRole('button', { name: 'Invite' }).click();
			await alice.page.getByRole('textbox', { name: 'Invite link' }).focus();
			await alice.page.keyboard.press('m');
			await expect(voiceOf(alice.page, aliceSeat)).toHaveAttribute('data-voice', 'talking');
			await alice.page.getByRole('button', { name: 'Invite' }).click();

			// M mutes Alice: her seat says so on both screens, and Bob hears nothing.
			await alice.page.keyboard.press('m');
			await expect(voiceOf(alice.page, aliceSeat)).toHaveAttribute('data-voice', 'muted');
			await expect(alice.page.getByRole('status').filter({ hasText: 'muted' })).toHaveCount(1);
			await expect(alice.page.getByRole('img', { name: 'Microphone live' })).toHaveCount(0);
			await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-voice', 'muted');
			await expect(voiceOf(bob.page, aliceSeat)).not.toHaveAttribute('data-speaking', 'true', {
				timeout: 10_000
			});
			// The button unmutes.
			await alice.page.getByRole('button', { name: 'Mute', exact: true }).click();
			await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-voice', 'talking');
			await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-speaking', 'true', {
				timeout: 30_000
			});

			// Bob mutes Alice for himself, from her seat's menu, then gives her 200%.
			await seatAt(bob.page, aliceSeat)
				.getByRole('button', { name: /mute, block or report/ })
				.click();
			const menu = bob.page.getByRole('group', { name: 'Voice' });
			await menu.getByRole('button', { name: 'Mute voice' }).click();
			await expect(menu.getByRole('button', { name: 'Mute voice' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			await expect(voiceOf(bob.page, aliceSeat)).not.toHaveAttribute('data-speaking', 'true', {
				timeout: 10_000
			});
			await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('title', /muted by you/);
			await menu.getByRole('button', { name: 'Mute voice' }).click();
			await menu.getByRole('slider', { name: 'Volume' }).fill('200');
			await expect(menu).toContainText('200%');
			const heard = (await diagnostics(bob.page)).heard;
			expect(heard).toHaveLength(1);
			if (heard[0].gain !== null) expect(heard[0].gain).toBe(2);
			await bob.page.getByRole('button', { name: 'Close' }).click();
			await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-speaking', 'true', {
				timeout: 30_000
			});

			// D deafens Bob: he hears nobody, and Alice sees it.
			await bob.page.keyboard.press('d');
			await expect(voiceOf(bob.page, bobSeat)).toHaveAttribute('data-voice', 'deafened');
			await expect(voiceOf(alice.page, bobSeat)).toHaveAttribute('data-voice', 'deafened');
			await expect(voiceOf(bob.page, aliceSeat)).not.toHaveAttribute('data-speaking', 'true');
			await bob.page.keyboard.press('d');
			await expect(voiceOf(alice.page, bobSeat)).not.toHaveAttribute('data-voice', 'deafened');

			// A change of settings mid-call: the high bitrate, and the microphone started again
			// without echo cancellation. Bob still hears her.
			await openPanel(alice.page);
			await card(alice.page).getByText('Voice settings').click();
			await card(alice.page)
				.getByRole('combobox', { name: 'Quality' })
				.selectOption({ label: 'High (96 kbps)' });
			await card(alice.page).getByRole('checkbox', { name: 'Echo cancellation' }).uncheck();
			await expect(card(alice.page).getByRole('meter', { name: 'Microphone level' })).toBeVisible();
			await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-speaking', 'true', {
				timeout: 30_000
			});
			await card(alice.page).getByRole('checkbox', { name: 'Echo cancellation' }).check();

			// Push-to-talk: Alice is silent until she holds V.
			await card(alice.page)
				.getByRole('checkbox', { name: /Push to talk/ })
				.check();
			await closePanel(alice.page);
			await expect(voiceOf(alice.page, aliceSeat)).toHaveAttribute('data-voice', 'muted');
			await expect(voiceOf(bob.page, aliceSeat)).not.toHaveAttribute('data-speaking', 'true', {
				timeout: 10_000
			});
			await alice.page.keyboard.down('v');
			await expect(voiceOf(alice.page, aliceSeat)).toHaveAttribute('data-voice', 'talking');
			await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-speaking', 'true', {
				timeout: 30_000
			});
			await alice.page.keyboard.up('v');
			await expect(voiceOf(alice.page, aliceSeat)).toHaveAttribute('data-voice', 'muted');
			// The talk button holds too, by pointer.
			const talk = alice.page.getByRole('button', { name: /Hold to talk/ });
			await talk.hover();
			await alice.page.mouse.down();
			await expect(voiceOf(alice.page, aliceSeat)).toHaveAttribute('data-voice', 'talking');
			await alice.page.mouse.up();
			await expect(voiceOf(alice.page, aliceSeat)).toHaveAttribute('data-voice', 'muted');

			// On a phone, the bar keeps to one line in voice, and the panel never covers the
			// turn's action panel.
			if ((testInfo.project.use.viewport?.width ?? 1440) < 640) {
				for (const one of [alice, bob]) {
					expect((await one.page.locator('.bar').boundingBox())!.height).toBeLessThanOrEqual(44);
				}
				await openPanel(bob.page);
				const panel = await card(bob.page).boundingBox();
				const dock = await bob.page.locator('.dock').boundingBox();
				expect(panel && dock && panel.y + panel.height <= dock.y + 1).toBe(true);
				await closePanel(bob.page);
			}

			// This browser remembers Alice's choice: after a reload she is back in voice
			// without the card, push-to-talk still on.
			await alice.page.reload();
			await expect(async () => expect((await diagnostics(alice.page)).phase).toBe('in')).toPass({
				timeout: 30_000
			});
			await expect(card(alice.page)).toHaveCount(0);
			await expect(voiceOf(alice.page, aliceSeat)).toHaveAttribute('data-voice', 'muted');
			await expect(voiceOf(bob.page, aliceSeat)).toHaveAttribute('data-voice', 'talking');

			// Bob leaves voice: Alice sees him out of it.
			await openPanel(bob.page);
			await card(bob.page).getByRole('button', { name: 'Leave voice' }).click();
			await expect(voiceOf(alice.page, bobSeat)).toHaveAttribute('data-voice', 'out', {
				timeout: 15_000
			});
			expect(alice.violations).toEqual([]);
			expect(bob.violations).toEqual([]);
		} finally {
			await alice.close();
			await bob.close();
		}
	});

	test('a practice table, and a table with only bots, offer no voice', async ({
		page,
		browser
	}) => {
		await page.goto('/');
		await expect(page.getByText('Looking for tables…')).toHaveCount(0);
		await page.getByRole('button', { name: 'Practice vs bots' }).click();
		await expect(seated(page)).toBeVisible();
		const other = await (await browser.newContext()).newPage();
		await sitDown(other, 3);
		await page.waitForTimeout(1500);
		for (const one of [page, other]) {
			await expect(voiceButton(one)).toHaveCount(0);
			await expect(card(one)).toHaveCount(0);
		}
		await other.context().close();
	});
});
