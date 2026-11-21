// The MLS working group's deserialization test vectors against the pinned ts-mls (P4C.3).
// Adapted from ts-mls 1.6.4, test/test-vectors/deserialization.test.ts (MIT, licenses/ts-mls.txt):
// it imports the installed package by subpath and reads the working group's own files,
// the cases for ciphersuite 0x0001, which load.ts fetches at a pinned commit and checks.
import { expect, test, vi } from 'vitest';
import { vectors } from './load.ts';
import source from './source.json' with { type: 'json' };
import { hexToBytes } from './hex.ts';
import { determineLength } from 'ts-mls/codec/variableLength.js';

vi.setConfig({ testTimeout: 120_000 });

const json = await vectors('deserialization');

test.concurrent.each(json.map((x, index) => [index, x]))(
	'deserialization test vectors %i',
	(_index, x) => {
		checkLength(x.vlbytes_header, x.length);
	}
);

function checkLength(header: string, len: number) {
	const { length } = determineLength(hexToBytes(header));
	expect(length).toBe(len);
}

// Without the working group's files (load.ts) this file has nothing to run, and says so.
test.skipIf(json.length === 0)(
	'the deserialization vectors for ciphersuite 0x0001 are all here',
	() => {
		expect(json).toHaveLength(source.files['deserialization'].cases);
	}
);
