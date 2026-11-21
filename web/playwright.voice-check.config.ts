import { defineConfig, devices } from '@playwright/test';
import { launch } from './voice/check/browsers.ts';
import { ORIGIN } from './voice/check/vite.config.ts';

// The voice checks (`pnpm voice:check`, P4C.2): SFrame's test vectors on each
// engine's WebCrypto, and a WebRTC call through the encoded-transform worker.
// They need no voice service and touch nothing of the site, so they are apart
// from `pnpm e2e` and run beside it in CI. One worker: WebKit lets one page of
// a browser capture at a time.
const config = 'voice/check/vite.config.ts';

export default defineConfig({
	testDir: 'voice/check',
	testMatch: '**/*.check.ts',
	outputDir: 'test-results-voice-check',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	timeout: 120_000,
	reporter: 'list',
	use: { baseURL: ORIGIN, trace: 'off' },
	webServer: {
		command: `pnpm exec vite build --config ${config} && pnpm exec vite preview --config ${config}`,
		url: ORIGIN,
		reuseExistingServer: false,
		timeout: 120_000
	},
	projects: [
		// Firefox allows the microphone through its launch settings; the others take it as a permission.
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				launchOptions: launch.chromium,
				permissions: ['microphone']
			}
		},
		{ name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: launch.firefox } },
		{
			name: 'webkit',
			use: {
				...devices['Desktop Safari'],
				launchOptions: launch.webkit,
				permissions: ['microphone']
			}
		}
	]
});
