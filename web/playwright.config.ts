import { defineConfig, devices } from '@playwright/test';

// Browser tests drive the production build (built once in global-setup)
// served by the Node server, one per worker; see e2e/server.ts.
const desktop = { viewport: { width: 1440, height: 900 } };
const phone = { viewport: { width: 375, height: 812 }, hasTouch: true };

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	globalSetup: './e2e/global-setup.ts',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	timeout: 60_000,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	// Traces keep their DOM snapshots but not the screencast: recording it slowed every
	// WebKit action to about a second on CI's runners, so the multi-hand tests ran out of time.
	use: { trace: { mode: 'retain-on-failure', screenshots: false } },
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...desktop } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'], ...desktop } },
		{ name: 'webkit', use: { ...devices['Desktop Safari'], ...desktop } },
		{ name: 'chromium-phone', use: { ...devices['Desktop Chrome'], ...phone } },
		{ name: 'firefox-phone', use: { ...devices['Desktop Firefox'], ...phone } },
		{ name: 'webkit-phone', use: { ...devices['Desktop Safari'], ...phone } }
	]
});
