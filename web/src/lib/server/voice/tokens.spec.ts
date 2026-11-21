import { describe, expect, it } from 'vitest';
import { issueSession, publicRef } from '../api/auth.ts';
import { TOKEN_SECONDS, TokenLedger, issueToken, readToken, voiceKey } from './tokens.ts';

const secret = new TextEncoder().encode('a site secret for the voice token tests');
const key = voiceKey(secret);
const player = publicRef('p_abcdefghijklmnop');
const grant = { table: 'Tb1x-2_yZ0aQ', seat: 3, player };
const now = 1_800_000_000;

describe('voice tokens', () => {
	it('names the table, seat and player, for sixty seconds', () => {
		const token = issueToken(key, grant, now);
		expect(token).toMatch(
			/^v1\.Tb1x-2_yZ0aQ\.3\.[0-9a-f]{16}\.1800000060\.[\w-]{22}\.[0-9a-f]{64}$/
		);
		const read = readToken(key, token, grant.table, now + 59);
		expect(read).toEqual({ ...grant, expires: now + TOKEN_SECONDS, nonce: token.split('.')[5] });
	});

	it('is signed with a key derived from the secret, never the secret itself', () => {
		expect(Buffer.from(key).equals(Buffer.from(secret))).toBe(false);
		expect(key).toHaveLength(32);
		const token = issueToken(key, grant, now);
		expect(readToken(secret, token, grant.table, now)).toBe('forged');
		expect(readToken(voiceKey(new TextEncoder().encode('another')), token, grant.table, now)).toBe(
			'forged'
		);
	});

	it('refuses a forged token', () => {
		const token = issueToken(key, grant, now);
		const parts = token.split('.');
		// Another seat, player, expiry or nonce under the same signature.
		for (const [at, value] of [
			[2, '4'],
			[3, publicRef('p_someone-else-entirely')],
			[4, String(now + 30)],
			[5, 'A'.repeat(22)]
		] as const) {
			const forged = [...parts];
			forged[at] = value;
			expect(readToken(key, forged.join('.'), grant.table, now), `field ${at}`).toBe('forged');
		}
		const flipped = parts[6].slice(0, -1) + (parts[6].endsWith('0') ? '1' : '0');
		expect(readToken(key, [...parts.slice(0, 6), flipped].join('.'), grant.table, now)).toBe(
			'forged'
		);
	});

	it('refuses a token for another table', () => {
		const token = issueToken(key, grant, now);
		expect(readToken(key, token, 'another-tab', now)).toBe('other-table');
		expect(readToken(key, token, undefined, now)).toBe('other-table');
	});

	it('refuses an expired token, and one that claims too long a life', () => {
		const token = issueToken(key, grant, now);
		expect(readToken(key, token, grant.table, now + TOKEN_SECONDS)).toBe('expired');
		expect(readToken(key, token, grant.table, now + 3600)).toBe('expired');
		// Issued for an hour: no table server does that, so it is refused even signed.
		const long = issueToken(key, grant, now + 3600);
		expect(readToken(key, long, grant.table, now)).toBe('expired');
	});

	it('refuses what is not a token', () => {
		for (const value of [
			undefined,
			42,
			'',
			'v1',
			issueToken(key, grant, now).replace(/^v1/, 'v2'),
			`${issueToken(key, grant, now)}.extra`,
			'x'.repeat(300)
		]) {
			expect(readToken(key, value, grant.table, now)).toBe('malformed');
		}
		// A session cookie, signed with the site's secret, is not a token either.
		expect(readToken(key, issueSession(secret, 'p_abcdefghijklmnop', now), grant.table, now)).toBe(
			'malformed'
		);
		expect(() => issueToken(key, { ...grant, player: 'p_abcdefghijklmnop' }, now)).toThrow();
		expect(() => issueToken(key, { ...grant, table: 'a.b' }, now)).toThrow();
	});

	it('admits a token once', () => {
		const ledger = new TokenLedger();
		const token = readToken(key, issueToken(key, grant, now), grant.table, now);
		if (typeof token === 'string') throw new Error(token);
		expect(ledger.admit(token, now)).toBe(true);
		expect(ledger.admit(token, now + 1)).toBe(false);
		expect(ledger.admit(token, now + 59)).toBe(false);
		// Another token for the same seat is fine.
		const again = readToken(key, issueToken(key, grant, now + 1), grant.table, now + 1);
		if (typeof again === 'string') throw new Error(again);
		expect(ledger.admit(again, now + 1)).toBe(true);
		// Expired tokens are forgotten, since they are refused anyway.
		expect(ledger.size).toBe(2);
		ledger.admit(
			readToken(key, issueToken(key, grant, now + 200), grant.table, now + 200) as never,
			now + 200
		);
		expect(ledger.size).toBe(1);
	});
});
