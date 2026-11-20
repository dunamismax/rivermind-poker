import { defineConfig } from 'vite';

// Bundles the custom server (server/index.ts) with its dependencies into
// build/start.js, beside the adapter-node output, so a release is the build
// directory alone, as the host's other Node sites deploy: `node build/start.js`.
export default defineConfig({
	build: {
		ssr: 'server/index.ts',
		outDir: 'build',
		emptyOutDir: false,
		target: 'node26',
		minify: false,
		rollupOptions: {
			// ws loads these native speed-ups only if they are installed.
			external: ['bufferutil', 'utf-8-validate'],
			output: { entryFileNames: 'start.js', format: 'esm' }
		}
	},
	ssr: { noExternal: true, target: 'node' }
});
