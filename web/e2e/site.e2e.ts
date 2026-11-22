import { createHash } from 'node:crypto';
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
	// WebAssembly is allowed for voice's noise suppression (Q-11), and no other script.
	expect(policy).toMatch(/script-src 'self' 'wasm-unsafe-eval' 'sha256-[^']+';/);
	expect(headers['permissions-policy']).toBe('camera=(), microphone=(self), geolocation=()');
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
	expect(await health.json()).toMatchObject({ status: 'ok' });
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

test('publishes the hash of every file its pages run, voice’s first, linked from the fairness page (P4C.8)', async ({
	page,
	request
}) => {
	const listed = await request.get('/voice-files.json');
	expect(listed.status()).toBe(200);
	const files = (await listed.json()) as {
		format: number;
		voice: Record<string, string>;
		page: Record<string, string>;
	};
	expect(files.format).toBe(1);
	const voice = Object.keys(files.voice);
	expect(
		voice.some((path) => /^\/_app\/immutable\/workers\/sframe\.worker-.+\.js$/.test(path))
	).toBe(true);
	expect(voice.some((path) => path.endsWith('.wasm'))).toBe(true);
	// Each hash is of the bytes the server sends.
	for (const [path, hash] of Object.entries({ ...files.voice, ...files.page })) {
		const body = await (await request.get(path)).body();
		expect(createHash('sha256').update(body).digest('hex'), path).toBe(hash);
	}
	// The page's own entry script is among them.
	const entry = (await (await request.get('/')).text()).match(/_app\/immutable\/[^"']+\.js/)![0];
	expect(Object.keys(files.page)).toContain(`/${entry}`);
	await page.goto('/fairness');
	const link = page.getByRole('link', { name: 'the hash of every file' });
	await expect(link).toHaveAttribute('href', '/voice-files.json');
});
