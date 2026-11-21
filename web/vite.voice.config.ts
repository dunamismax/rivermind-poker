import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { workerBin } from 'mediasoup';
import { defineConfig } from 'vite';

// Bundles the voice service (voice/server.ts, P4C.4) with its dependencies into
// build/voice/voice.js, and copies mediasoup's worker binary beside it, so the
// release runs `node build/voice/voice.js` with no node_modules. The bundle is
// built on its own, sharing no chunk with the site's server, so build/voice/
// changes only when the voice service does: deploy/update.sh restarts the
// voice unit only then, and a site deploy leaves conversations alone.
//
// The worker is the one installed here, for this machine's platform: a
// release is built on the host that runs it (deploy/update.sh).
const out = path.resolve(import.meta.dirname, 'build/voice');

export default defineConfig({
	build: {
		ssr: true,
		outDir: out,
		emptyOutDir: true,
		target: 'node26',
		minify: false,
		rollupOptions: {
			input: { voice: 'voice/server.ts' },
			// ws loads these native speed-ups only if they are installed.
			external: ['bufferutil', 'utf-8-validate'],
			output: {
				entryFileNames: '[name].js',
				format: 'esm',
				inlineDynamicImports: true,
				// mediasoup is CommonJS, and looks for its own directory through
				// `__dirname` when no node_modules is there to resolve it from, as in a
				// release. An ES module has none; this one names the bundle's own.
				banner: 'const __filename = import.meta.filename; const __dirname = import.meta.dirname;'
			}
		}
	},
	ssr: { noExternal: true, target: 'node' },
	plugins: [
		{
			name: 'rivermind:mediasoup-worker',
			async writeBundle() {
				await copyFile(workerBin, path.join(out, 'mediasoup-worker'));
			}
		}
	]
});
