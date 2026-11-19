import { defineConfig, type Plugin } from 'vitest/config';
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
			// A single-page app: every route is served by the 200.html fallback.
			adapter: adapter({ fallback: '200.html' })
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
					include: ['src/**/*.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
