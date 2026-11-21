import { defineConfig, type Plugin } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

// Until the P4B.7 cutover, `rivermind-poker serve-nl` (port 8000 by default)
// owns /api and /ws. In development and preview, Vite forwards both so the
// client stays same-origin; the built Node server does the same with
// RIVERMIND_LEGACY_API (server/legacy.ts).
const backend =
	process.env.RIVERMIND_LEGACY_API ?? process.env.RIVERMIND_BACKEND ?? 'http://127.0.0.1:8000';
const proxy = {
	'/api': { target: backend, changeOrigin: true },
	'/ws': { target: backend, ws: true, changeOrigin: true }
};

// SvelteKit's route announcer hides itself with an inline style attribute,
// which the site's CSP (`style-src 'self'`) blocks. Drop the attribute; the
// `#svelte-announcer` rule in app.css hides it instead. Fails loudly if a
// SvelteKit upgrade changes the markup, so the CSP is never silently broken.
function announcerWithoutInlineStyle(): Plugin {
	return {
		name: 'rivermind:announcer-without-inline-style',
		enforce: 'pre',
		transform(code, id) {
			if (!id.split('?')[0].endsWith('@sveltejs/kit/src/runtime/components/root.svelte')) return;
			const pattern = /(id="svelte-announcer"[^>]*?)\s+style="[^"]*"/;
			if (!pattern.test(code)) {
				throw new Error('SvelteKit root.svelte changed: re-check the announcer for inline styles.');
			}
			return code.replace(pattern, '$1');
		}
	};
}

export default defineConfig({
	plugins: [
		announcerWithoutInlineStyle(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// The Node build: server/index.ts mounts its handler.js beside the /ws socket.
			adapter: adapter(),
			// The same policy Caddy and serve-nl send. SvelteKit adds the hash of the
			// inline script that starts the app, and src/hooks.server.ts adds the
			// page's own WebSocket origin to connect-src.
			csp: {
				mode: 'hash',
				directives: {
					'default-src': ['self'],
					'img-src': ['self', 'data:'],
					'style-src': ['self'],
					'script-src': ['self'],
					'connect-src': ['self'],
					'object-src': ['none'],
					'frame-ancestors': ['none'],
					'base-uri': ['self'],
					'form-action': ['self']
				}
			}
		})
	],
	build: {
		// The CSP allows data: images but not data: fonts, so the font is
		// always its own hashed file.
		assetsInlineLimit: (file) => (file.endsWith('.woff') ? false : undefined)
	},
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
					include: ['src/**/*.{test,spec}.{js,ts}', 'server/**/*.{test,spec}.ts'],
					exclude: ['src/**/*.db.spec.ts']
				}
			},
			{
				// Tests against RIVERMIND_TEST_DATABASE_URL (src/lib/server/db/testing.ts).
				// Each one resets the database, so the files run one at a time.
				extends: './vite.config.ts',
				test: {
					name: 'db',
					environment: 'node',
					include: ['src/**/*.db.spec.ts'],
					fileParallelism: false,
					// Real saves and restores: a few seconds each on a busy machine.
					testTimeout: 30_000
				}
			}
		]
	}
});
