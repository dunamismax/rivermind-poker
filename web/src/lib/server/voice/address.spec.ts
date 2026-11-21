import { describe, expect, it } from 'vitest';
import { AddressWatch } from './address.ts';

describe('the announced address', () => {
	it('is read from DNS, and a change is told once', async () => {
		let answer: string[] | Error = ['203.0.113.9'];
		const told: string[] = [];
		const lines: string[] = [];
		const watch = new AddressWatch({
			host: 'voice.example',
			resolve: async () => {
				if (answer instanceof Error) throw answer;
				return answer;
			},
			log: (line) => lines.push(line),
			onchange: (address) => void told.push(address)
		});
		expect(await watch.check()).toBe('203.0.113.9');
		expect(await watch.check()).toBe('203.0.113.9');
		expect(told).toEqual(['203.0.113.9']);
		// A lookup that fails keeps what was known, and says so once.
		answer = new Error('ENOTFOUND');
		expect(await watch.check()).toBe('203.0.113.9');
		expect(await watch.check()).toBe('203.0.113.9');
		answer = ['198.51.100.4', 'not an address'];
		expect(await watch.check()).toBe('198.51.100.4');
		expect(told).toEqual(['203.0.113.9', '198.51.100.4']);
		// Several addresses: the lowest, so the choice does not flap with the order DNS gives.
		answer = ['198.51.100.9', '198.51.100.4'];
		expect(await watch.check()).toBe('198.51.100.4');
		expect(lines).toEqual([
			'the public address is known',
			'could not look up the announced name: ENOTFOUND',
			'the announced name resolves again',
			'the public address changed'
		]);
	});
});
