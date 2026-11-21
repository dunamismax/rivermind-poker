import { networkInterfaces } from 'node:os';
import { defineConfig, devices } from '@playwright/test';
import { launch } from './voice/check/browsers.ts';
import { ORIGIN, VOICE_PORT, VOICE_SECRET } from './voice/check/vite.config.ts';

// The voice service the room checks talk to (P4C.4), from the source, with a
// secret of its own. Firefox's ICE fails against a media address on loopback
// alone, so it also listens on this machine's first LAN address.
const lan = Object.values(networkInterfaces())
	.flat()
	.find((address) => address?.family === 'IPv4' && !address.internal)?.address;

// The voice checks (`pnpm voice:check`, P4C.2 and P4C.4): SFrame's test
// vectors on each engine's WebCrypto, a WebRTC call through the
// encoded-transform worker, and people in a table's voice room on the voice
// service. They touch nothing of the site, so they are apart from `pnpm e2e`
// and run beside it in CI. One worker: WebKit lets one page of a browser
// capture at a time.
const config = 'voice/check/vite.config.ts';
const voiceService = {
	command: 'node voice/server.ts',
	url: `http://127.0.0.1:${VOICE_PORT}/healthz`,
	reuseExistingServer: false,
	timeout: 60_000,
	env: {
		...(process.env as Record<string, string>),
		PORT: String(VOICE_PORT),
		RIVERMIND_SECRET: VOICE_SECRET,
		VOICE_ORIGINS: ORIGIN,
		VOICE_MEDIA_PORT: '0',
		VOICE_LISTEN_IPS: ['127.0.0.1', ...(lan ? [lan] : [])].join(',')
	}
};

export default defineConfig({
	testDir: 'voice/check',
	testMatch: '**/*.check.ts',
	outputDir: 'test-results-voice-check',
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	timeout: 120_000,
	reporter: 'list',
	use: { baseURL: ORIGIN, trace: 'off' },
	webServer: [
		{
			command: `pnpm exec vite build --config ${config} && pnpm exec vite preview --config ${config}`,
			url: ORIGIN,
			reuseExistingServer: false,
			timeout: 120_000
		},
		// VOICE_REMOTE=1 leaves it out: a voice service elsewhere answers on the
		// same port, such as one on ubuntu-vm through `ssh -L 4392:127.0.0.1:4323`
		// (CONTRIBUTING.md), with media over the host's public address.
		...(process.env.VOICE_REMOTE ? [] : [voiceService])
	],
	projects: [
		// Firefox allows the microphone through its launch settings; the others take it as a permission.
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				launchOptions: launch.chromium,
				permissions: ['microphone']
			}
		},
		{ name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: launch.firefox } },
		{
			name: 'webkit',
			use: {
				...devices['Desktop Safari'],
				launchOptions: launch.webkit,
				permissions: ['microphone']
			}
		}
	]
});
