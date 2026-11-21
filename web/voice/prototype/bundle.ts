// Bundles sfu-selftest.ts as a release bundles the site's server (P4C.1): one
// file with mediasoup's JavaScript inside, and mediasoup's worker binary copied
// beside it, since a release carries no node_modules.
//
//   node voice/prototype/bundle.ts OUT_DIR
//   MEDIASOUP_WORKER_BIN=OUT_DIR/mediasoup-worker node OUT_DIR/sfu-selftest.js
//
// The binary is the one installed on the machine that runs this, so bundle on
// the kind of host that will run it.
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { workerBin } from 'mediasoup';
import { build } from 'vite';

const out = path.resolve(process.argv[2] ?? 'voice-selftest');
await build({
	configFile: false,
	root: import.meta.dirname,
	logLevel: 'warn',
	build: {
		ssr: true,
		outDir: out,
		emptyOutDir: false,
		target: 'node26',
		minify: false,
		rollupOptions: {
			input: { 'sfu-selftest': path.join(import.meta.dirname, 'sfu-selftest.ts') },
			output: { entryFileNames: '[name].js', format: 'esm' }
		}
	},
	ssr: { noExternal: true, target: 'node' }
});
await copyFile(workerBin, path.join(out, 'mediasoup-worker'));
console.log(`bundled into ${out}`);
