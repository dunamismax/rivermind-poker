// The MLS working group's interoperability test vectors, for the specs beside
// this file. They are not kept in this repository: the working group's
// repository states no license for them. Each file is fetched from it at the
// commit source.json pins, checked against the SHA-256 recorded there, and
// kept under node_modules/.cache, so a run needs the network once.
//
// Outside CI a file that cannot be fetched leaves its spec with nothing to run,
// which the spec reports as skipped. In CI it is a failure: the vectors are
// how an unaudited MLS library is held to the standard (docs/voice.md).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import source from './source.json' with { type: 'json' };

type Name = keyof typeof source.files;
// A case as the working group wrote it: each spec knows its own shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Case = any;

const cache = path.resolve(
	fileURLToPath(new URL('.', import.meta.url)),
	'../../../../node_modules/.cache/mls-vectors',
	source.commit
);
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function fileOf(name: Name): Promise<Uint8Array> {
	const file = path.join(cache, `${name}.json`);
	try {
		const kept = readFileSync(file);
		if (sha256(kept) === source.files[name].sha256) return kept;
	} catch {
		// Not fetched yet.
	}
	const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}/${name}.json`;
	const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`${url}: ${response.status}`);
	const data = new Uint8Array(await response.arrayBuffer());
	if (sha256(data) !== source.files[name].sha256) {
		throw new Error(`${url} is not the file source.json records`);
	}
	mkdirSync(cache, { recursive: true });
	writeFileSync(file, data);
	return data;
}

// One file's cases for the ciphersuite table voice uses, and those for none in particular.
export async function vectors(name: Name): Promise<Case[]> {
	let data: Uint8Array;
	try {
		data = await fileOf(name);
	} catch (error) {
		if (process.env.CI) throw error;
		console.warn(
			`MLS test vectors: ${name} is not available, so its checks are skipped (${error})`
		);
		return [];
	}
	const cases = JSON.parse(new TextDecoder().decode(data)) as Case[];
	return cases.filter(
		(one) => one.cipher_suite === undefined || one.cipher_suite === source.cipherSuite
	);
}
