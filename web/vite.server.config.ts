import { defineConfig } from 'vite';

// Bundles the custom server (server/index.ts) and the migrator
// (scripts/db-migrate.ts) with their dependencies into build/start.js and
// build/migrate.js, beside the adapter-node output, so a release needs no
// node_modules: `node build/start.js` serves, and `node build/migrate.js`
// applies the release's drizzle/ (deploy/update.sh).
export default defineConfig({
	build: {
		ssr: true,
		outDir: 'build',
		emptyOutDir: false,
		target: 'node26',
		minify: false,
		rollupOptions: {
			input: { start: 'server/index.ts', migrate: 'scripts/db-migrate.ts' },
			// ws loads these native speed-ups only if they are installed.
			external: ['bufferutil', 'utf-8-validate'],
			output: {
				entryFileNames: '[name].js',
				chunkFileNames: 'server-chunks/[name]-[hash].js',
				format: 'esm'
			}
		}
	},
	ssr: { noExternal: true, target: 'node' }
});
