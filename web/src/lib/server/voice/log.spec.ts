import { describe, expect, it } from 'vitest';
import { redact } from './log.ts';

describe('the voice log', () => {
	it('hides addresses, tokens, keys and public references', () => {
		for (const [line, expected] of [
			['ICE from 203.0.113.7:51234 failed', 'ICE from [address] failed'],
			['bound 127.0.0.1', 'bound [address]'],
			['peer [2001:db8::1]:3478 gone', 'peer [address] gone'],
			['from ::1 and fe80::1%en0', 'from [address] and [address]'],
			[
				'token v1.Tb1x-2_yZ0aQ.3.0123456789abcdef.1800000060.AAAA',
				'token v1.Tb1x-2_yZ0aQ.3.[…].1800000060.AAAA'
			],
			['key 0e3137e4ba0b19dfc9e31133c91f81ce7f37aa40dcd1263f30a63817753609ab', 'key […]'],
			['player 9f86d081884c7d65 joined', 'player […] joined'],
			['id pX0Bq9r_Z-k2mN7sQw4E1t', 'id […]']
		]) {
			expect(redact(line)).toBe(expected);
		}
	});

	it('keeps the words, counts and times it is meant to say', () => {
		for (const line of [
			'rivermind-poker-voice listening on port 4323, media on UDP 3478 and TCP 3478',
			'room 12 closed after 125 s, at most 4 in voice',
			'room 3: someone joined (2 in voice)',
			'refused a token: other-table'
		]) {
			expect(redact(line)).toBe(line);
		}
	});
});
