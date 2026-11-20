import { describe, expect, it } from 'vitest';
import { socketOrigin, withSocketOrigin } from './csp.ts';

describe('socketOrigin', () => {
	it('uses wss for https pages and ws otherwise', () => {
		expect(socketOrigin(new URL('https://rivermindpoker.com/hands'))).toBe(
			'wss://rivermindpoker.com'
		);
		expect(socketOrigin(new URL('http://127.0.0.1:8800/'))).toBe('ws://127.0.0.1:8800');
	});
});

describe('withSocketOrigin', () => {
	const url = new URL('https://rivermindpoker.com/');

	it('adds the socket origin to connect-src only', () => {
		const policy = "default-src 'self'; connect-src 'self'; script-src 'self' 'sha256-abc'";
		expect(withSocketOrigin(policy, url)).toBe(
			"default-src 'self'; connect-src 'self' wss://rivermindpoker.com; script-src 'self' 'sha256-abc'"
		);
	});

	it('leaves a policy that already names it, or has no connect-src, unchanged', () => {
		const named = "connect-src 'self' wss://rivermindpoker.com; img-src 'self'";
		expect(withSocketOrigin(named, url)).toBe(named);
		expect(withSocketOrigin("default-src 'self'", url)).toBe("default-src 'self'");
	});
});
