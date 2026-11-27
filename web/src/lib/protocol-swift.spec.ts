// The iPhone app's protocol types are written from protocol-v2.ts and the voice
// signalling by `pnpm protocol:swift` (P5D.2): this fails while the committed
// Swift is stale, as pytest does for `pnpm protocol`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate } from '../../scripts/protocol-swift.ts';

const root = resolve(import.meta.dirname, '..', '..', '..');

describe('the Swift protocol types', () => {
	it.each(Object.entries(generate()))('%s is what pnpm protocol:swift writes', (path, text) => {
		const committed = readFileSync(resolve(root, path), 'utf8');
		expect(committed === text, `${path} is stale: run pnpm protocol:swift`).toBe(true);
	});

	it('writes every type of both sources', () => {
		const swift = Object.values(generate()).join('\n');
		for (const name of [
			'TableView',
			'ServerMessage',
			'ClientMessage',
			'EventKind',
			'VoiceNotice'
		]) {
			expect(swift).toContain(` ${name}: `);
		}
		expect(swift).toContain('extension VoiceHelloRequest: VoiceRequest');
	});
});
