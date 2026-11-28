// Telling the iPhone app from the site in counts (P5D.11), and the oldest app
// build the server names. The header names the app and its build, which every
// copy of a build shares; the counts hold numbers by kind of client and nothing else.
import { afterEach, describe, expect, it } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { appBuild, clientKind } from './clients.ts';
import { OLDEST_APP_BUILD } from './site.ts';
import { TestServer } from './tables.testing.ts';

const servers: TestServer[] = [];

afterEach(async () => {
	while (servers.length) await servers.pop()!.stop();
});

describe('the kind of client', () => {
	it('is the app only for a well-formed ios/<build>', () => {
		expect(clientKind('ios/1')).toBe('ios');
		expect(clientKind(' ios/204 ')).toBe('ios');
		expect(appBuild('ios/204')).toBe(204);
		for (const other of [
			null,
			undefined,
			'',
			'ios',
			'ios/',
			'ios/x',
			'ios/1.2',
			'android/3',
			'web'
		]) {
			expect(clientKind(other), String(other)).toBe('site');
			expect(appBuild(other)).toBeNull();
		}
	});

	it('is counted for new guests, sessions, sockets and deletions, and nothing else is kept', async () => {
		const server = await new TestServer().start();
		servers.push(server);
		const made = async (headers: Record<string, string>) => {
			const response = await server.request('POST', '/api/session', { headers });
			return /rm_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')![1];
		};
		await made({});
		const app = await made({ 'rivermind-client': 'ios/1' });
		await server.request('POST', '/api/session', {
			headers: { 'rivermind-client': 'ios/1', cookie: `rm_session=${app}` }
		});
		const socket = server.sockets.open(
			{ send: () => {}, close: () => {} },
			{ cookie: `rm_session=${app}`, peer: 'testclient', forwardedFor: null, client: 'ios/1' }
		);
		socket.receive(JSON.stringify({ type: 'hello', protocol: 2 }));
		await socket.idle();
		await server.request('DELETE', '/api/guest', {
			headers: { 'rivermind-client': 'ios/1', cookie: `rm_session=${app}` },
			body: { confirm: true }
		});
		expect(server.site.counts.snapshot()).toEqual({
			guest_made: { site: 1, ios: 1 },
			session: { site: 1, ios: 2 },
			socket: { site: 0, ios: 1 },
			guest_deleted: { site: 0, ios: 1 }
		});
		socket.closed();
	});
});

describe('the oldest app build', () => {
	it('is in the config, and a test may set another', async () => {
		const server = await new TestServer().start();
		servers.push(server);
		const config = (await (await server.request('GET', '/api/config')).json()) as p.ConfigResponse;
		expect(config.oldest_app_build).toBe(OLDEST_APP_BUILD);
		const later = await new TestServer({ site: { oldestAppBuild: 7 } }).start();
		servers.push(later);
		const raised = (await (await later.request('GET', '/api/config')).json()) as p.ConfigResponse;
		expect(raised.oldest_app_build).toBe(7);
	});
});
