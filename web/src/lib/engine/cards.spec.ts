import { describe, expect, it } from 'vitest';
import {
	FULL_DECK,
	buildDeck,
	card,
	cardStr,
	cards,
	cardsStr,
	pretty,
	rank,
	suit
} from './cards.ts';

describe('cards', () => {
	it('parses and prints cards', () => {
		expect(card('2c')).toBe(0);
		expect(card('As')).toBe(51);
		expect(card('td')).toBe(card('Td'));
		expect([rank(card('Td')), suit(card('Td'))]).toEqual([8, 1]);
		expect(cards('As Kd 7c')).toEqual(cards('AsKd7c'));
		expect(cards(['As', 'Kd'])).toEqual([51, 45]);
		expect(cardsStr(cards('as kd'))).toBe('As Kd');
		expect(pretty(card('Ah'))).toBe('A♥');
		expect(FULL_DECK.map(cardStr).join('').length).toBe(104);
		for (const bad of ['', 'A', 'Ax', '1s', 'Asd']) expect(() => card(bad)).toThrow(RangeError);
		expect(() => cards('As K')).toThrow(RangeError);
		expect(() => cardStr(52)).toThrow(RangeError);
	});

	it('arranges a deck that deals the given cards (rules 1.2 to 1.4)', () => {
		const holes = [cards('As Ks'), cards('2c 2d'), cards('7h 8h')];
		const deck = buildDeck(holes, cards('Qd Jd Td 9d 8d'), cards('3c 4c 5c'));
		expect(new Set(deck).size).toBe(52);
		expect(cardsStr(deck.slice(0, 6))).toBe('As 2c 7h Ks 2d 8h');
		expect(cardsStr([deck[7], deck[8], deck[9], deck[11], deck[13]])).toBe('Qd Jd Td 9d 8d');
		expect(cardsStr([deck[6], deck[10], deck[12]])).toBe('3c 4c 5c');
		expect(() => buildDeck([cards('As Ks')])).toThrow(RangeError);
		expect(() => buildDeck([cards('As Ks'), cards('As 2c')])).toThrow(RangeError);
	});
});
