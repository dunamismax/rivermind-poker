// People in table voice for the browser tests: voice.e2e.ts against the built
// server with a voice service of its own, and voice.live.ts against a deployed
// site (P4C.9).
//
// Each person is a browser of their own, started with the engine's fake
// microphone (voice/check/browsers.ts). Where an engine cannot capture here
// (Chromium on macOS), its person is refused the microphone and listens.
import {
	chromium,
	expect,
	firefox,
	webkit,
	type Browser,
	type BrowserContextOptions,
	type Page,
	type TestInfo
} from '@playwright/test';
import { launch } from '../voice/check/browsers.ts';

export type Engine = 'chromium' | 'firefox' | 'webkit';
export type Person = { page: Page; violations: string[]; close: () => Promise<void> };

const types = { chromium, firefox, webkit };

export const engineOf = (browser: Browser) => browser.browserType().name() as Engine;

/**
 * A person in a browser of their own: with a microphone the engine can fake here, or
 * (`mic: false`) none, so asking for one is refused. `size` is the project's own
 * viewport unless it says otherwise.
 */
export async function person(
	engine: Engine,
	testInfo: TestInfo,
	baseURL: string,
	{ mic, size }: { mic: boolean; size?: { width: number; height: number; touch: boolean } }
): Promise<Person> {
	const options =
		mic || engine !== 'chromium'
			? launch[engine]
			: { args: ['--autoplay-policy=no-user-gesture-required'] };
	const own = await types[engine].launch(options);
	const use = testInfo.project.use;
	const context: BrowserContextOptions = {
		baseURL,
		viewport: size ?? use.viewport ?? { width: 1440, height: 900 },
		hasTouch: size?.touch ?? use.hasTouch ?? false,
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

export const card = (page: Page) => page.getByRole('dialog', { name: 'Table voice' });
export const voiceButton = (page: Page) => page.getByRole('button', { name: /^Voice/ });
export const seatAt = (page: Page, seat: string) => page.locator(`.seat[data-seat="${seat}"]`);
export const voiceOf = (page: Page, seat: string) => seatAt(page, seat).locator('.voice');

export type Diagnostics = {
	phase: string;
	denoising: boolean;
	output: string | null;
	heard: { seat: number | null; gain: number | null; pan: number | null; speaking: boolean }[];
	code: string[] | null;
	live: boolean;
};
export const diagnostics = (page: Page) =>
	page.evaluate(() =>
		(window as unknown as { rivermindVoice: () => Diagnostics }).rivermindVoice()
	);

export async function openPanel(page: Page): Promise<void> {
	if (!(await card(page).isVisible())) await voiceButton(page).click();
	await expect(card(page)).toBeVisible();
}

export async function closePanel(page: Page): Promise<void> {
	if (await card(page).isVisible()) await card(page).getByRole('button', { name: 'Close' }).click();
	await expect(card(page)).toHaveCount(0);
}
