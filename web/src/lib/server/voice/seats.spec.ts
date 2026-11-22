import { describe, expect, it } from 'vitest';
import { readSeats, signSeats, type SeatList } from './seats.ts';
import { voiceKey } from './tokens.ts';

const key = voiceKey(new TextEncoder().encode('seat list tests'));
const now = 1_800_000_000_000;
const list: SeatList = {
	table: 'Tb1x-2_yZ0aQ',
	at: now,
	seats: [
		{ seat: 0, player: '0123456789abcdef' },
		{ seat: 4, player: 'fedcba9876543210' }
	],
	blocks: [['0123456789abcdef', 'fedcba9876543210']]
};

function signed(body: string, at = now) {
	const headers = signSeats(key, body, at);
	return [headers['x-voice-time'], headers['x-voice-signature']] as const;
}

describe('seat lists', () => {
	it('arrive as the table server signed them', () => {
		const body = JSON.stringify(list);
		expect(readSeats(key, body, ...signed(body), now + 5_000)).toEqual(list);
	});

	it('are refused when changed, signed with another key, or old', () => {
		const body = JSON.stringify(list);
		const [time, signature] = signed(body);
		const changed = JSON.stringify({
			...list,
			seats: [...list.seats, { seat: 7, player: 'aaaaaaaaaaaaaaaa' }]
		});
		expect(readSeats(key, changed, time, signature, now)).toBeNull();
		expect(readSeats(voiceKey(new Uint8Array(4)), body, time, signature, now)).toBeNull();
		expect(readSeats(key, body, String(now + 1), signature, now)).toBeNull();
		expect(readSeats(key, body, time, signature, now + 31_000)).toBeNull();
		expect(readSeats(key, body, undefined, signature, now)).toBeNull();
		expect(readSeats(key, body, time, undefined, now)).toBeNull();
	});

	it('carry who may not speak, and until when, or nobody (P4C.8)', () => {
		const silenced: SeatList = { ...list, silenced: [['fedcba9876543210', now + 3_600_000]] };
		const body = JSON.stringify(silenced);
		expect(readSeats(key, body, ...signed(body), now)).toEqual(silenced);
		for (const value of [
			{ ...list, silenced: [['p_not-a-public-ref', now]] },
			{ ...list, silenced: [['fedcba9876543210', 1.5]] },
			{ ...list, silenced: [['fedcba9876543210']] },
			{ ...list, silenced: 'fedcba9876543210' }
		]) {
			const refused = JSON.stringify(value);
			expect(readSeats(key, refused, ...signed(refused), now)).toBeNull();
		}
	});

	it('are refused when they are not a list of seats', () => {
		for (const value of [
			{ ...list, table: 'a.b' },
			{ ...list, at: 1.5 },
			{ ...list, seats: [{ seat: 0, player: 'p_not-a-public-ref' }] },
			{
				...list,
				seats: Array.from({ length: 10 }, (_, seat) => ({ seat, player: '0123456789abcdef' }))
			},
			{ ...list, blocks: [['0123456789abcdef']] },
			[list]
		]) {
			const body = JSON.stringify(value);
			expect(readSeats(key, body, ...signed(body), now)).toBeNull();
		}
		expect(readSeats(key, 'not json', ...signed('not json'), now)).toBeNull();
	});
});
