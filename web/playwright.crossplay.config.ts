import { defineConfig, devices } from '@playwright/test';

// Cross-play with the iPhone app (P5D.7): `ios/crossplay.sh` starts a server, runs this
// config's test, which seats two people in browsers at a table and writes its id to
// CROSSPLAY_TABLE_FILE, and runs the app's CrossPlayUITests in the Simulator at the same
// table. Not part of `pnpm e2e`: it needs the app beside it.
export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.crossplay.ts',
	timeout: 600_000,
	workers: 1,
	reporter: 'list',
	outputDir: 'test-results-crossplay',
	use: {
		baseURL: process.env.CROSSPLAY_URL ?? 'http://127.0.0.1:4386',
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
		}
	]
});
