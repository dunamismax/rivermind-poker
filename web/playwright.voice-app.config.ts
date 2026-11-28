import { defineConfig } from '@playwright/test';
import check from './playwright.voice-check.config.ts';

// Voice's design check for the iPhone app (P5D.9, voice/check/app.tool.ts):
// the voice checks' page and voice service, as `pnpm voice:check` starts them
// (or the ones already running), a person in Chromium, and the app in the
// simulator VOICE_APP_DEVICE names. Run by hand on a Mac; never in CI.
export default defineConfig({
	...check,
	testMatch: '**/app.tool.ts',
	outputDir: 'test-results-voice-app',
	retries: 0,
	timeout: 300_000,
	webServer: (Array.isArray(check.webServer) ? check.webServer : []).map((server) => ({
		...server,
		reuseExistingServer: true
	})),
	projects: (check.projects ?? []).filter((project) => project.name === 'chromium')
});
