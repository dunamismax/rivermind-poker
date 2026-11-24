import { defineConfig } from '@playwright/test';

// The stranger tool (P7.1b, e2e/stranger.tool.ts): brings about the warning
// for someone in a table's voice group who is not seated, on a deployed site
// (https://rivermindpoker.com by default, or LIVE_URL), and saves what the
// observer's screen showed to artifacts/voice-stranger/. Test-only and run by
// hand: it seats eight guests at a real table, so neither `pnpm e2e` nor
// `pnpm e2e:live` matches it.
export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.tool.ts',
	outputDir: 'test-results-voice-stranger',
	timeout: 600_000,
	workers: 1,
	retries: 0,
	reporter: 'list',
	use: {
		baseURL: process.env.LIVE_URL ?? 'https://rivermindpoker.com',
		viewport: { width: 1440, height: 900 },
		trace: 'retain-on-failure'
	}
});
