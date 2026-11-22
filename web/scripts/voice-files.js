// Post-build (P4C.8): the SHA-256 of every file this release's pages run, as
// build/client/voice-files.json, which the site serves at /voice-files.json and
// the fairness page links to.
//
// Table voice is encrypted in the browser by code the site sends, so the
// encryption is only as good as that code (docs/voice.md, threat model). The
// source is public; this list lets anyone check that what a release serves is
// what the source builds. `voice` holds the files of table voice itself: the
// chunks of `src/lib/voice/` with everything they import, the encoded-transform
// worker, and RNNoise's worklet and WebAssembly. Any script on a page can
// reach the page's keys, so `page` lists every other file under
// `/_app/immutable/` too. Compressed copies (.br, .gz) are left out: they are
// the same bytes, compressed.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const WEB = new URL('..', import.meta.url).pathname;
const CLIENT = join(WEB, 'build', 'client');
const MANIFEST = join(WEB, '.svelte-kit', 'output', 'client', '.vite', 'manifest.json');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const urlOf = (file) => `/${file.split(sep).join('/')}`;
const sha256 = (file) =>
	createHash('sha256')
		.update(readFileSync(join(CLIENT, file)))
		.digest('hex');

// Every built file of the voice modules, following their imports.
const voice = new Set();
const seen = new Set();
const follow = (key) => {
	if (seen.has(key) || !manifest[key]) return;
	seen.add(key);
	const entry = manifest[key];
	voice.add(entry.file);
	for (const one of [...(entry.assets ?? []), ...(entry.css ?? [])]) voice.add(one);
	for (const next of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) follow(next);
};
for (const key of Object.keys(manifest)) if (key.startsWith('src/lib/voice/')) follow(key);

const immutable = readdirSync(join(CLIENT, '_app', 'immutable'), {
	withFileTypes: true,
	recursive: true
})
	.filter((entry) => entry.isFile() && !/\.(br|gz)$/.test(entry.name))
	.map((entry) => relative(CLIENT, join(entry.parentPath, entry.name)))
	.sort();
for (const file of immutable) if (file.split(sep).includes('workers')) voice.add(file);
if (![...voice].some((file) => file.includes('sframe.worker'))) {
	throw new Error('voice-files: the build has no SFrame worker');
}

const listed = (files) =>
	Object.fromEntries([...files].sort().map((file) => [urlOf(file), sha256(file)]));
const list = {
	format: 1,
	about:
		'SHA-256 of each file this release of RiverMind Poker serves to run its pages: table voice’s encryption and everything it loads under "voice", every other script, style and asset under "page". Build the same commit from the source to compare.',
	voice: listed(voice),
	page: listed(immutable.filter((file) => !voice.has(file)))
};
writeFileSync(join(CLIENT, 'voice-files.json'), `${JSON.stringify(list, null, '\t')}\n`);
console.log(
	`voice-files.json: ${Object.keys(list.voice).length} voice files, ${Object.keys(list.page).length} others`
);
