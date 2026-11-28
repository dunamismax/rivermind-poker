import { describe, expect, it } from 'vitest';
import { podName } from './faces.ts';

describe('podName', () => {
	const shown = (name: string) =>
		podName(name)
			.filter((part) => part.pod)
			.map((part) => part.text)
			.join('');
	const whole = (name: string) =>
		podName(name)
			.map((part) => part.text)
			.join('');

	it('leaves out the words the bots share, so a phone pod tells them apart', () => {
		expect(shown('RiverMind Easy 4')).toBe('Easy 4');
		expect(shown('RiverMind Hard 1')).toBe('Hard 1');
		expect(shown('Calling bot 2')).toBe('Calling 2');
		expect(shown('Random bot 9')).toBe('Random 9');
	});

	it('marks the site’s own name, which no seat shows', () => {
		const house = (name: string) =>
			podName(name)
				.filter((part) => part.house)
				.map((part) => part.text);
		expect(house('RiverMind Medium 3')).toEqual(['RiverMind ']);
		expect(house('Calling bot 2')).toEqual([]);
		expect(house('RiverMind')).toEqual([]);
	});

	it('keeps every letter of the name between its parts', () => {
		for (const name of [
			'RiverMind Easy 4',
			'Calling bot 2',
			'Random bot 12',
			'Bot',
			'RiverMind',
			'7'
		]) {
			expect(whole(name)).toBe(name);
			expect(shown(name)).not.toBe('');
		}
	});
});
