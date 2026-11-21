import { expect, newTableForm, test } from './fixtures.ts';

// The Node server (P4B.1): pages, assets and headers come from SvelteKit's
// handler, and /api/* from serve-nl through the forwarding.

test('serves pages and assets with the site headers', async ({ page, request, cspViolations }) => {
	const html = await request.get('/');
	expect(html.status()).toBe(200);
	const headers = html.headers();
	expect(headers['cache-control']).toBe('no-cache');
	expect(headers['x-frame-options']).toBe('DENY');
	expect(headers['x-content-type-options']).toBe('nosniff');
	expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
	const policy = headers['content-security-policy'];
	expect(policy).toMatch(/script-src 'self' 'sha256-[^']+';/);
	expect(policy).toContain("style-src 'self';");
	expect(policy).toMatch(/connect-src 'self' ws:\/\/127\.0\.0\.1:\d+;/);
	expect((await request.get('/some/route')).status()).toBe(404);

	const asset = (await html.text()).match(/_app\/immutable\/[^"']+\.js/)?.[0];
	expect(asset).toBeTruthy();
	const script = await request.get(`/${asset}`);
	expect(script.status()).toBe(200);
	expect(script.headers()['cache-control']).toMatch(/^public, ?max-age=31536000, ?immutable$/);
	expect((await request.get('/_app/immutable/missing.js')).status()).toBe(404);

	const health = await request.get('/healthz');
	expect(await health.text()).toBe('ok\n');
	const config = await request.get('/api/config');
	expect(config.ok()).toBe(true);
	expect((await config.json()).protocol).toBe(2);

	for (const path of ['/hands', '/fairness', '/bots', '/style']) {
		expect((await request.get(path)).status()).toBe(200);
	}
	await page.goto('/');
	await expect(newTableForm(page).getByRole('button', { name: 'Sit down' })).toBeVisible();
	expect(cspViolations).toEqual([]);
});
