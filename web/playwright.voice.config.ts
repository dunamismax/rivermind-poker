import { defineConfig, devices } from '@playwright/test';
import { launch, ORIGIN } from './voice/prototype/browsers.ts';

// The voice prototype's checks (`pnpm voice:proto`, P4C.1): browsers talking
// through a local mediasoup service with every frame encrypted in a worker.
// It starts its own service (voice/prototype/server.ts) and touches nothing of
// the site, so it is not part of `pnpm e2e`. One worker: a test holds up to
// nine browser contexts, and the nine-person room measures the service's CPU.
export default defineConfig({
	testDir: 'voice/prototype',
	outputDir: 'test-results-voice',
	forbidOnly: !!process.env.CI,
	workers: 1,
	timeout: 180_000,
	reporter: 'list',
	use: { baseURL: ORIGIN, trace: 'off' },
	webServer: {
		// VOICE_SERVER_ARGS passes the service its options, such as `--listen-ip 127.0.0.1`.
		command: `node voice/prototype/server.ts ${process.env.VOICE_SERVER_ARGS ?? ''}`,
		url: `${ORIGIN}/healthz`,
		reuseExistingServer: false,
		timeout: 120_000
	},
	projects: [
		{
			name: 'chromium',
			testMatch: 'voice.proto.ts',
			use: { ...devices['Desktop Chrome'], launchOptions: launch.chromium }
		},
		{
			name: 'firefox',
			testMatch: 'voice.proto.ts',
			use: { ...devices['Desktop Firefox'], launchOptions: launch.firefox }
		},
		{
			name: 'webkit',
			testMatch: 'voice.proto.ts',
			use: { ...devices['Desktop Safari'], launchOptions: launch.webkit }
		},
		// One room shared by all three engines, which the test starts itself.
		{ name: 'mixed', testMatch: 'mixed.proto.ts' }
	]
});
