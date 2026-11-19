import { defineConfig, devices } from '@playwright/test';

// Smoke test of a deployed site (https://rivermindpoker.com by default, or
// LIVE_URL): `pnpm e2e:live`. It plays real hands there, so run it only
// against a deployment you are checking. Set LIVE_RESTART_COMMAND to a
// command that restarts the service (for example over ssh) to also check a
// mid-hand restart.
export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.live.ts',
	forbidOnly: !!process.env.CI,
	timeout: 180_000,
	workers: 1,
	reporter: 'list',
	use: {
		baseURL: process.env.LIVE_URL ?? 'https://rivermindpoker.com',
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
		},
		{
			name: 'webkit-phone',
			use: { ...devices['Desktop Safari'], viewport: { width: 375, height: 812 }, hasTouch: true }
		}
	]
});
