// Screenshots of fixed scenes, for comparing two builds pixel for pixel (P4B.2).
//
// Each size and pixel density gets its own site (e2e/visual/server.ts): seeded
// decks and bots, fixed handles and standing clocks, with the browser's own
// clock, time zone and locale pinned too. So the same build gives the same
// pixels on every run, and a scene is only saved once two captures in a row agree.
//
//   VISUAL_OUT=../artifacts/visual/before-1 pnpm visual   at the old commit, two or three times
//   VISUAL_OUT=../artifacts/visual/after pnpm visual      at the new one
//   pnpm visual:compare ../artifacts/visual/before-1 ../artifacts/visual/before-2 ../artifacts/visual/after
//
// Several "before" runs, because browsers do not draw every pixel the same way twice:
// Chromium's anti-aliasing of the fanned (rotated) cards varies by a few dozen pixels at
// three device pixels per CSS pixel. The comparison accepts those pixels only.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	expect,
	test,
	type Browser,
	type BrowserContext,
	type Locator,
	type Page
} from '@playwright/test';
import { newTableForm, playUntil, sitDown } from '../fixtures.ts';
import { FIXED_TIME, HANDLES } from './fixed.ts';

const WEB = resolve(import.meta.dirname, '..', '..');
const OUT = resolve(WEB, process.env.VISUAL_OUT ?? '../artifacts/visual/current');
/** Each worker takes twenty ports from here, one for each size and density. */
const FIRST_PORT = Number(process.env.VISUAL_PORT ?? 8950);

/** Every size at every density, and two more sizes at one density for the layouts between them. */
const CONFIGS = [
	...[
		{ width: 375, height: 812 }, // a phone
		{ width: 768, height: 1024 }, // a tablet held upright
		{ width: 1440, height: 900 } // a desktop
	].flatMap((size) => [1, 2, 3].map((density) => ({ size, density }))),
	{ size: { width: 1024, height: 768 }, density: 1 }, // a laptop: the narrower side column
	{ size: { width: 860, height: 600 }, density: 1 } // a small window: one column, a wide table
];

/** The test site in its own process group, on its own port. */
class Site {
	readonly url: string;
	#child: ChildProcess | null = null;
	#output = '';

	constructor(readonly port: number) {
		this.url = `http://127.0.0.1:${port}`;
	}

	async start(): Promise<void> {
		// A site left over from another run would answer with its own guests and tables.
		const taken = await fetch(`${this.url}/healthz`).then(
			() => true,
			() => false
		);
		if (taken) throw new Error(`something is already listening on ${this.url}`);
		const child = spawn(process.execPath, ['e2e/visual/server.ts'], {
			cwd: WEB,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
			env: { ...process.env, PORT: String(this.port), ORIGIN: this.url }
		});
		this.#child = child;
		child.stdout?.on('data', (chunk) => (this.#output += chunk));
		child.stderr?.on('data', (chunk) => (this.#output += chunk));
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline && child.exitCode === null) {
			try {
				if ((await fetch(`${this.url}/healthz`)).ok) return;
			} catch {
				// not listening yet
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`the visual test site did not start:\n${this.#output}`);
	}

	async stop(): Promise<void> {
		const child = this.#child;
		this.#child = null;
		if (!child || child.exitCode !== null) return;
		const exited = new Promise((r) => child.once('exit', r));
		process.kill(-child.pid!, 'SIGKILL');
		await exited;
	}
}

/** A person's browser with its clock, time zone and locale pinned. */
async function visitor(
	browser: Browser,
	site: Site,
	viewport: { width: number; height: number },
	deviceScaleFactor: number
): Promise<BrowserContext> {
	const context = await browser.newContext({
		baseURL: site.url,
		viewport,
		deviceScaleFactor,
		timezoneId: 'UTC',
		locale: 'en-US'
	});
	// Date.now() stands still at the server's time while timers keep running, so a turn's
	// clock shows the same time left in every capture.
	await context.clock.setFixedTime(new Date(FIXED_TIME * 1000));
	return context;
}

/** Save a full-page screenshot once two captures in a row are identical. */
async function shoot(page: Page, path: string, mask: Locator[] = []): Promise<void> {
	// Park the pointer on the top bar's edge: a button under it would be drawn hovered or not,
	// depending on whether the browser noticed it there without a move.
	await page.mouse.move(1, 1);
	await page.evaluate(async () => {
		// From the top: a sticky dock is drawn where the scroll position puts it.
		window.scrollTo(0, 0);
		await document.fonts.ready;
		await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
	});
	const capture = () =>
		page.screenshot({
			fullPage: true,
			animations: 'disabled',
			caret: 'hide',
			scale: 'device',
			mask
		});
	let last = await capture();
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(250);
		const next = await capture();
		if (next.equals(last)) {
			mkdirSync(resolve(path, '..'), { recursive: true });
			writeFileSync(path, next);
			return;
		}
		last = next;
	}
	throw new Error(`${path} never stood still`);
}

/** Leave the table for the lobby. */
async function leave(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Leave table' }).click();
	await expect(newTableForm(page)).toBeVisible();
}

/**
 * Wait for our first turn, then load the page again. The hand log holds what the page
 * was sent since it joined, and the bots ahead of us act while it is still joining, so
 * how much of the hand it saw varies; after a reload it has seen none of it.
 */
async function firstTurn(page: Page): Promise<void> {
	const panel = page.getByRole('group', { name: 'Your action' });
	await expect(panel).toBeVisible();
	await page.reload();
	await expect(page.getByRole('group', { name: /^Your seat/ })).toBeVisible();
	await expect(panel).toBeVisible();
}

CONFIGS.forEach(({ size, density }, config) => {
	const tag = `${size.width}x${size.height}@${density}`;
	test(`scenes at ${tag}`, async ({ browser, browserName }, testInfo) => {
		const site = new Site(FIRST_PORT + testInfo.parallelIndex * 20 + config);
		await site.start();
		try {
			const file = (scene: string) => resolve(OUT, browserName, `${scene}-${tag}.png`);

			// Someone else's table, so the lobby has one to list. They arrive first.
			const other = await visitor(browser, site, { width: 1280, height: 800 }, 1);
			const stranger = await other.newPage();
			await sitDown(stranger, 6);
			await expect(stranger.locator('header .me')).toHaveText(HANDLES[0]);

			const context = await visitor(browser, site, size, density);
			const page = await context.newPage();
			await page.goto('/');
			await expect(page.locator('header .me')).toHaveText(HANDLES[1]);
			await expect(page.locator('li[data-table]')).toHaveCount(1);
			await shoot(page, file('lobby'));

			// Watching their table: the seats, the offer of a seat, and the menu for a person.
			await page.locator('li[data-table]').getByRole('button', { name: 'Watch' }).click();
			await expect(page.getByRole('group', { name: 'Take a seat' })).toBeVisible();
			await shoot(page, file('watch'));
			await page.getByRole('button', { name: `${HANDLES[0]}: mute, block or report` }).click();
			await expect(page.getByRole('dialog')).toBeVisible();
			await shoot(page, file('menu'));
			await page.getByRole('button', { name: 'Lobby' }).click();
			await expect(newTableForm(page)).toBeVisible();

			// Heads-up against a calling bot: the first turn, a bet being sized, the result.
			await sitDown(page, 2);
			const panel = page.getByRole('group', { name: 'Your action' });
			await firstTurn(page);
			await shoot(page, file('table-2'));
			await panel.getByRole('button', { name: /^Pot: \d+$/ }).click();
			await shoot(page, file('dock'));
			const result = page.locator('.result');
			await playUntil(page, () => result.isVisible(), 120_000);
			await shoot(page, file('result'));
			// The settled hand under review (P6.1): its result, then a step part-way through.
			await page.getByRole('button', { name: 'Review hand', exact: true }).click();
			const review = page.getByRole('region', { name: 'Hand review' });
			await expect(review.locator('.replay')).toBeVisible();
			await shoot(page, file('review'));
			await review.getByRole('button', { name: 'First' }).click();
			await page.keyboard.press('ArrowRight');
			await page.keyboard.press('ArrowRight');
			await expect(review.locator('.replay')).toHaveAttribute('data-step', '3');
			await shoot(page, file('review-step'));
			await review.getByRole('button', { name: 'Close' }).click();
			await expect(review).toHaveCount(0);
			await leave(page);

			// One-click practice.
			await page.getByRole('button', { name: 'Practice vs bots' }).click();
			await expect(page.getByRole('group', { name: /^Your seat/ })).toBeVisible();
			await firstTurn(page);
			await shoot(page, file('practice'));
			await leave(page);

			// A private table and its invite link, which holds this run's port.
			await sitDown(page, 3, { privateTable: true });
			await firstTurn(page);
			await page.getByRole('button', { name: 'Invite' }).click();
			const link = page.getByRole('group', { name: 'Invite link' });
			await expect(link).toBeVisible();
			await shoot(page, file('invite'), [link.getByRole('textbox')]);
			await leave(page);

			// A full ring of RiverMind Easy bots at our first turn, then the seat's tools in use.
			await sitDown(page, 9, { bots: /RiverMind Easy/ });
			await firstTurn(page);
			await shoot(page, file('table-9'));
			await page.getByRole('button', { name: 'React', exact: true }).click();
			await page.getByRole('button', { name: 'Sit out next hand' }).click();
			await expect(page.getByRole('button', { name: 'I’m back' })).toBeVisible();
			await shoot(page, file('tools'));

			await page.goto('/style');
			await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
			await shoot(page, file('style'));

			await page.goto('/fairness');
			await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
			await shoot(page, file('fairness'));

			// The hands that finished, newest first, and the heads-up one opened.
			await page.goto('/hands');
			const hands = page.getByRole('region', { name: 'Hands' }).getByRole('button');
			await expect(hands).toHaveCount(3);
			await shoot(page, file('hands'));
			await hands.last().click();
			await expect(page.getByRole('heading', { name: 'Hand history' })).toBeVisible();
			await shoot(page, file('hand'));
			// The same hand stepped back to its blinds.
			await page.getByRole('button', { name: 'First' }).click();
			await expect(page.locator('.replay')).toHaveAttribute('data-step', '1');
			await shoot(page, file('hand-step'));

			await context.close();
			await other.close();
		} finally {
			await site.stop();
		}
	});
});
