// Writes src/lib/voice/sframe-vectors.json from RFC 9605's appendix C, read
// out of the RFC's own text so that nothing is retyped:
//
//   curl -o rfc9605.txt https://www.rfc-editor.org/rfc/rfc9605.txt
//   node scripts/sframe-vectors.ts rfc9605.txt
//
// Every value is kept as the RFC prints it, a hex string: its JSON copy of the
// vectors writes the 64-bit key ids and counters as numbers, which JavaScript
// cannot read exactly.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const source = process.argv[2];
if (!source) throw new Error('usage: node scripts/sframe-vectors.ts rfc9605.txt');
const text = readFileSync(source, 'utf8');
const lines = text.split('\n');
const from = lines.findIndex((line) => line.startsWith('Appendix C.  Test Vectors'));
const to = lines.findIndex((line) => line.startsWith('Acknowledgements'));
if (from < 0 || to < from) throw new Error('appendix C not found');

type Vector = Record<string, string>;
const sections: Record<string, Vector[]> = { header: [], aead: [], sframe: [] };
const titles: [string, keyof typeof sections][] = [
	['C.1.', 'header'],
	['C.2.', 'aead'],
	['C.3.', 'sframe']
];
let section: Vector[] | null = null;
let vector: Vector | null = null;
let field = '';
for (const line of lines.slice(from, to)) {
	const title = titles.find(([prefix]) => line.startsWith(prefix));
	const named = /^ {3}([a-z_]+): (\S+)$/.exec(line);
	const more = /^ +([0-9a-f]+)$/.exec(line);
	if (title) {
		section = sections[title[1]];
	} else if (named && section) {
		if (!vector) section.push((vector = {}));
		field = named[1];
		vector[field] = named[2].replace(/^0x/, '');
	} else if (more && vector) {
		vector[field] += more[1];
	} else if (line.trim() === '') {
		vector = null;
	}
}

const sha256 = createHash('sha256').update(text).digest('hex');
const rows = (vectors: Vector[]) => vectors.map((one) => `\t\t${JSON.stringify(one)}`).join(',\n');
const out = path.resolve(import.meta.dirname, '../src/lib/voice/sframe-vectors.json');
writeFileSync(
	out,
	`{
	"source": "RFC 9605, appendix C, from https://www.rfc-editor.org/rfc/rfc9605.txt (SHA-256 ${sha256}); written by scripts/sframe-vectors.ts",
	"header": [
${rows(sections.header)}
	],
	"aead": [
${rows(sections.aead)}
	],
	"sframe": [
${rows(sections.sframe)}
	]
}
`
);
console.log(
	`${out}: ${sections.header.length} header, ${sections.aead.length} AEAD and ${sections.sframe.length} SFrame vectors`
);
