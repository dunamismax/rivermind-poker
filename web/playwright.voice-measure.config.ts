import { defineConfig } from '@playwright/test';
import checks from './playwright.voice-check.config.ts';

// The voice measurements (`pnpm voice:measure`, P4C.7): mouth-to-ear delay
// with a marked tone, and what a room hears through a network that loses and
// delays packets. They use the voice checks' page server and voice service,
// and print what they measured; they are run by hand on a quiet machine, not
// in CI, since their figures mean little on a shared runner.
export default defineConfig({
	...checks,
	testMatch: '**/*.measure.ts',
	outputDir: 'test-results-voice-measure',
	retries: 0,
	timeout: 600_000
});
