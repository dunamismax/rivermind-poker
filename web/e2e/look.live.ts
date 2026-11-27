// The two looks on the live site (Phase 5C, D-18): a new browser gets the clean look,
// the header's switch changes it at once and keeps it across a reload and to other
// pages, and on a phone at a table the table bar's menu holds the switch. It opens
// its own contexts without E2E_LOOK's kept look, which would be put back on every load.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { DEFAULT_LOOK, LOOK_NAMES, type Look } from '../src/lib/look.ts';

const OTHER: Look = DEFAULT_LOOK === 'clean' ? 'pixel' : 'clean';

const html = (page: Page) => page.locator('html');
const choice = (page: Page, look: Look) =>
	page
		.getByRole('group', { name: 'Look' })
		.getByRole('button', { name: LOOK_NAMES[look], exact: true });

async function plainPage(
	browser: Browser,
	baseURL: string | undefined,
	phone: boolean
): Promise<Page> {
	const context = await browser.newContext({
		baseURL,
		...(phone ? { viewport: { width: 375, height: 812 }, hasTouch: true } : {})
	});
	return context.newPage();
}

test('a new browser gets the clean look, and the header switches and keeps the other', async ({
	browser
}, testInfo) => {
	test.skip(testInfo.project.name.endsWith('-phone'), 'the desktop projects run this');
	const page = await plainPage(browser, testInfo.project.use.baseURL, false);
	try {
		await page.goto('/');
		await expect(html(page)).toHaveAttribute('data-look', 'clean');
		await expect(choice(page, 'clean')).toHaveAttribute('aria-pressed', 'true');
		await choice(page, OTHER).click();
		await expect(html(page)).toHaveAttribute('data-look', OTHER);
		await page.reload();
		await expect(html(page)).toHaveAttribute('data-look', OTHER);
		await page.goto('/fairness');
		await expect(html(page)).toHaveAttribute('data-look', OTHER);
		await expect(choice(page, OTHER)).toHaveAttribute('aria-pressed', 'true');
		await choice(page, DEFAULT_LOOK).click();
		await page.reload();
		await expect(html(page)).toHaveAttribute('data-look', DEFAULT_LOOK);
	} finally {
		await page.context().close();
	}
});

test('on a phone at a practice table, the table menu switches the look and keeps it', async ({
	browser
}, testInfo) => {
	test.skip(!testInfo.project.name.endsWith('-phone'), 'the phone projects run this');
	const page = await plainPage(browser, testInfo.project.use.baseURL, true);
	try {
		await page.goto('/');
		await expect(html(page)).toHaveAttribute('data-look', 'clean');
		await page.getByRole('button', { name: 'Practice vs bots' }).click();
		await expect(page.getByRole('group', { name: /^Your seat/ })).toBeVisible();
		const menu = page.getByRole('button', { name: 'Table menu' });
		await menu.click();
		const dialog = page.getByRole('dialog', { name: 'Table menu' });
		await expect(dialog).toBeVisible();
		await dialog
			.getByRole('group', { name: 'Look' })
			.getByRole('button', { name: LOOK_NAMES[OTHER], exact: true })
			.click();
		await expect(html(page)).toHaveAttribute('data-look', OTHER);
		await dialog.getByRole('button', { name: 'Close' }).click();
		await page.reload();
		await expect(page.getByRole('group', { name: /^Your seat/ })).toBeVisible();
		await expect(html(page)).toHaveAttribute('data-look', OTHER);
		await page.getByRole('button', { name: /Leave table/ }).click();
		await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
		await expect(html(page)).toHaveAttribute('data-look', OTHER);
	} finally {
		await page.context().close();
	}
});
