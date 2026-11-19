import { describe, expect, it } from 'vitest';
import { ApiError, fetchConfig } from './api.ts';

function respond(body: unknown, status = 200): typeof fetch {
	return async () => new Response(JSON.stringify(body), { status });
}

describe('fetchConfig', () => {
	it('returns the opponent kinds the server offers', async () => {
		const config = await fetchConfig(respond({ opponents: ['random', 'checkpoint'] }));
		expect(config.opponents).toEqual(['random', 'checkpoint']);
	});

	it('rejects an error status', async () => {
		await expect(fetchConfig(respond({}, 503))).rejects.toBeInstanceOf(ApiError);
	});

	it('rejects a malformed body', async () => {
		await expect(fetchConfig(respond({ opponents: 'random' }))).rejects.toThrow(/Unexpected/);
	});
});
