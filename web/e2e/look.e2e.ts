import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { expect, handNumber, noOverflow, sitDown, test } from './fixtures.ts';
import { panel, ourTurn } from './review.ts';
import { DEFAULT_LOOK, LOOK_KEY, type Look } from '../src/lib/look.ts';

// The look switch in the site header (P5C.5). Each test opens its own context
// without E2E_LOOK's kept look, which would be put back on every page load.

const OTHER: Look = DEFAULT_LOOK === 'pixel' ? 'clean' : 'pixel';
const NAMES: Record<Look, string> = { clean: 'Clean', pixel: 'Pixel' };

async function plainContext(
	browser: Browser,
	url: string,
	info: TestInfo
): Promise<BrowserContext> {
	const { viewport, hasTouch } = info.project.use;
	return browser.newContext({ baseURL: url, viewport, hasTouch });
}

function lookOf(page: Page): Promise<string | undefined> {
	return page.evaluate(() => document.documentElement.dataset.look);
}

/** Where the switch, its buttons and the lamp sit, which switching must not change. */
function places(page: Page) {
	return page.evaluate(() => {
		const at = (element: Element | null) => {
			const box = element?.getBoundingClientRect();
			return box && [box.x, box.y, box.width, box.height].map(Math.round);
		};
		const header = document.querySelector('header');
		return {
			header: at(header)?.slice(2),
			switch: at(document.querySelector('.look-switch')),
			buttons: [...document.querySelectorAll('.look-switch button')].map(at),
			lamp: at(document.querySelector('header .status'))
		};
	});
}

test('the header switches the look at once, keeps it, and moves nothing else', async ({
	browser,
	server,
	cspViolations
}, testInfo) => {
	const context = await plainContext(browser, server.url, testInfo);
	const page = await context.newPage();
	await page.goto('/');
	await expect(page.getByText('Looking for tables…')).toHaveCount(0);
	expect(await lookOf(page)).toBe(DEFAULT_LOOK);

	const group = page.getByRole('group', { name: 'Look' });
	await expect(group).toBeVisible();
	const choice = (look: Look) => group.getByRole('button', { name: NAMES[look], exact: true });
	await expect(choice(DEFAULT_LOOK)).toHaveAttribute('aria-pressed', 'true');
	await expect(choice(OTHER)).toHaveAttribute('aria-pressed', 'false');

	// No reload: a mark left on the page survives the switch.
	await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true));
	const before = await places(page);
	await choice(OTHER).click();
	await expect(page.locator('html')).toHaveAttribute('data-look', OTHER);
	await expect(choice(OTHER)).toHaveAttribute('aria-pressed', 'true');
	await expect(choice(DEFAULT_LOOK)).toHaveAttribute('aria-pressed', 'false');
	expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
	expect(await places(page)).toEqual(before);
	expect(await page.evaluate((key) => localStorage.getItem(key), LOOK_KEY)).toBe(OTHER);

	// Kept across a reload and on every other page, each with the switch in its header.
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-look', OTHER);
	for (const path of ['/hands', '/fairness', '/bots', '/style']) {
		await page.goto(path);
		await expect(page.locator('html')).toHaveAttribute('data-look', OTHER);
		await expect(choice(OTHER)).toHaveAttribute('aria-pressed', 'true');
	}

	// From the keyboard: focus the other choice and press it.
	await choice(DEFAULT_LOOK).focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('html')).toHaveAttribute('data-look', DEFAULT_LOOK);
	await choice(OTHER).focus();
	await page.keyboard.press('Space');
	await expect(page.locator('html')).toHaveAttribute('data-look', OTHER);

	expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
	expect(cspViolations).toEqual([]);
	await context.close();
});

test('a kept value that is not a look, or storage that throws, gets the default', async ({
	browser,
	server
}, testInfo) => {
	const context = await plainContext(browser, server.url, testInfo);
	await context.addInitScript((key) => localStorage.setItem(key, 'sepia'), LOOK_KEY);
	const page = await context.newPage();
	await page.goto('/fairness');
	await expect(page.getByRole('group', { name: 'Look' })).toBeVisible();
	expect(await lookOf(page)).toBe(DEFAULT_LOOK);
	await context.close();

	// A browser that blocks site data: reading and writing throw. The switch still works
	// for the page, and the next page starts from the default again.
	const blocked = await plainContext(browser, server.url, testInfo);
	await blocked.addInitScript(() => {
		const refuse = () => {
			throw new DOMException('blocked', 'SecurityError');
		};
		Object.defineProperty(window, 'localStorage', { get: refuse, configurable: true });
	});
	const other = await blocked.newPage();
	await other.goto('/fairness');
	const group = other.getByRole('group', { name: 'Look' });
	await expect(group).toBeVisible();
	expect(await lookOf(other)).toBe(DEFAULT_LOOK);
	await group.getByRole('button', { name: NAMES[OTHER], exact: true }).click();
	await expect(other.locator('html')).toHaveAttribute('data-look', OTHER);
	await other.reload();
	await expect(other.getByRole('group', { name: 'Look' })).toBeVisible();
	expect(await lookOf(other)).toBe(DEFAULT_LOOK);
	await blocked.close();
});

test("at a table on a phone, the bar's menu switches the look mid-hand and play goes on", async ({
	browser,
	server,
	cspViolations
}, testInfo) => {
	const context = await plainContext(browser, server.url, testInfo);
	const page = await context.newPage();
	await sitDown(page, 2);
	const menu = page.getByRole('button', { name: 'Table menu' });
	if (!testInfo.project.name.endsWith('-phone')) {
		// A wider screen keeps the site header, and its switch, at the table: the bar has no menu.
		await expect(page.locator('header.topbar').getByRole('group', { name: 'Look' })).toBeVisible();
		await expect(menu).toBeHidden();
		await context.close();
		return;
	}
	await expect(page.locator('header.topbar')).toBeHidden();
	await ourTurn(page);
	const hand = await handNumber(page);
	const seat = page.getByRole('group', { name: /^Your seat/ });
	const name = ((await seat.getAttribute('aria-label')) ?? '').replace(/^Your seat: /, '');
	await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true));
	const bar = await page.locator('.nl-table > .bar').boundingBox();

	// The menu opens over the table, from the far end of the bar, and moves nothing.
	await expect(menu).toHaveAttribute('aria-expanded', 'false');
	await menu.click();
	await expect(menu).toHaveAttribute('aria-expanded', 'true');
	const dialog = page.getByRole('dialog', { name: 'Table menu' });
	const group = dialog.getByRole('group', { name: 'Look' });
	await expect(group).toBeVisible();
	await expect(group).toContainText('Look');
	expect(await page.locator('.nl-table > .bar').boundingBox()).toEqual(bar);
	expect(await page.evaluate(() => scrollY)).toBe(0);
	await group.getByRole('button', { name: NAMES[OTHER], exact: true }).click();
	await expect(page.locator('html')).toHaveAttribute('data-look', OTHER);
	await expect(group.getByRole('button', { name: NAMES[OTHER], exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	expect(await page.evaluate((key) => localStorage.getItem(key), LOOK_KEY)).toBe(OTHER);
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(menu).toHaveAttribute('aria-expanded', 'false');

	// The same page, seat, socket and hand, and the turn's panel answers straight away.
	expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
	await expect(page.locator('.bar .lamp .status')).toHaveAttribute('data-state', 'open');
	await expect(seat).toBeVisible();
	expect(await handNumber(page)).toBe(hand);
	const act = panel(page).getByRole('button', { name: /^(Check|Call \d+)$/ });
	const said = (await act.textContent())?.startsWith('Check') ? 'checks' : 'calls';
	await act.click();
	await expect(page.getByRole('region', { name: 'Hand log' })).toContainText(`${name} ${said}`);

	// The button closes the menu as it opens it, and the choice outlives a reload.
	await menu.click();
	await expect(dialog).toBeVisible();
	await menu.click();
	await expect(dialog).toHaveCount(0);
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-look', OTHER);
	await expect(seat).toBeVisible();
	await noOverflow(page);
	expect(cspViolations).toEqual([]);
	await context.close();
});
