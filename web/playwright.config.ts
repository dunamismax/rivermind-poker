import { defineConfig } from '@playwright/test';

// Browser tests run the built client under `vite preview`, which proxies
// /api and /ws to a real `rivermind-poker serve` on port 8000.
export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	forbidOnly: !!process.env.CI,
	webServer: [
		{
			command: 'uv run --locked rivermind-poker serve --port 8000',
			cwd: '..',
			url: 'http://127.0.0.1:8000/api/config',
			reuseExistingServer: !process.env.CI,
			timeout: 120_000
		},
		{
			command: 'pnpm build && pnpm preview --port 4173 --strictPort',
			url: 'http://127.0.0.1:4173',
			reuseExistingServer: !process.env.CI,
			timeout: 120_000
		}
	],
	use: { baseURL: 'http://127.0.0.1:4173' }
});
