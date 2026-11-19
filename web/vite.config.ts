import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';

// `rivermind-poker serve` (port 8000 by default) owns /api and /ws. In
// development and preview, Vite forwards both so the client stays same-origin,
// as it is behind Caddy in production.
const backend = process.env.RIVERMIND_BACKEND ?? 'http://127.0.0.1:8000';
const proxy = {
	'/api': { target: backend, changeOrigin: true },
	'/ws': { target: backend, ws: true, changeOrigin: true }
};

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// A single-page app: every route is served by the 200.html fallback.
			adapter: adapter({ fallback: '200.html' })
		})
	],
	server: { proxy },
	preview: { proxy },
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'unit',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
