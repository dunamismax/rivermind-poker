import { describe, expect, it } from 'vitest';
import type { SeatInfo } from '../protocol-v2.ts';
import { podName, seatLabel, seatStatus } from './faces.ts';

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

describe('a seat’s words', () => {
	const seat: SeatInfo = {
		seat: 2,
		name: 'Ann',
		kind: 'human',
		ref: 'r',
		bot: null,
		stack: 100,
		bet: 0,
		in_hand: true,
		folded: false,
		all_in: false,
		sitting_out: false,
		leaving: false,
		connected: true,
		has_cards: true,
		cards: null
	};

	it('says the first of leaving, sitting out, folded, all-in and away', () => {
		expect(seatStatus(seat)).toBe('');
		expect(seatStatus({ ...seat, connected: false })).toBe('Away');
		expect(seatStatus({ ...seat, connected: false, kind: 'bot' })).toBe('');
		expect(seatStatus({ ...seat, all_in: true, connected: false })).toBe('All-in');
		expect(seatStatus({ ...seat, folded: true, all_in: true })).toBe('Folded');
		expect(seatStatus({ ...seat, sitting_out: true, folded: true })).toBe('Sitting out');
		expect(seatStatus({ ...seat, leaving: true, sitting_out: true })).toBe('Leaving');
	});

	it('labels the viewer’s seat and every bot', () => {
		expect(seatLabel(seat, false)).toBe('Seat 3: Ann');
		expect(seatLabel(seat, true)).toBe('Your seat: Ann');
		expect(seatLabel({ ...seat, kind: 'bot', name: 'RiverMind Easy 2' }, false)).toBe(
			'Seat 3: RiverMind Easy 2 (bot)'
		);
	});
});
