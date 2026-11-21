import { defineConfig, devices } from '@playwright/test';

// The screenshot comparison (`pnpm visual`): fixed scenes of the production build
// at three sizes and three pixel densities, in each browser engine, written as PNGs
// under VISUAL_OUT for `pnpm visual:compare` to check pixel for pixel against the
// same scenes from another commit. See e2e/visual/scenes.visual.ts.
export default defineConfig({
	testDir: 'e2e/visual',
	testMatch: '**/*.visual.ts',
	// Its own output directory: Playwright empties it at the start of a run, which would take
	// the traces of a `pnpm e2e` running beside it.
	outputDir: 'test-results-visual',
	globalSetup: './e2e/global-setup.ts',
	forbidOnly: !!process.env.CI,
	timeout: 600_000,
	reporter: 'list',
	use: { trace: 'off' },
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } }
	]
});
