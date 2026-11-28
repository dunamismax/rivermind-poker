import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// The voice checks' page (`pnpm voice:check`): built as the site's client is,
// with the worker a bundled module of its own, and served with the site's
// Content-Security-Policy, so a check that passes here passes under it.
export const PORT = 4391;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
// The voice service the room page talks to (playwright.voice-check.config.ts starts it).
export const VOICE_PORT = 4392;
export const VOICE_URL = `ws://127.0.0.1:${VOICE_PORT}/voice`;
// One the room checks start and restart themselves (room.check.ts).
export const RESTART_PORT = 4393;
// The test build with a keyless listener at the SFU (tap.check.ts), and where
// it says what the listener kept.
export const TAP_PORT = 4394;
export const TAP_READ_PORT = 4395;
// One whose audio passes through a relay that stands in for a network
// (recovery.check.ts, relay.ts): its signalling, and the media port that the
// relay listens on at this machine's LAN address and the service on loopback.
export const RELAYED_PORT = 4396;
export const RELAYED_MEDIA_PORT = 4397;
// The site secret it runs with, from which the checks sign their voice tokens.
export const VOICE_SECRET = 'the voice checks’ own secret';

// The site's policy (vite.config.ts and src/hooks.server.ts).
const csp = [
	"default-src 'self'",
	"img-src 'self' data:",
	"style-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval'",
	`connect-src 'self' ws://127.0.0.1:${VOICE_PORT} ws://127.0.0.1:${RESTART_PORT} ws://127.0.0.1:${TAP_PORT} ws://127.0.0.1:${RELAYED_PORT}`,
	"object-src 'none'",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'self'"
].join('; ');

// A browser run by hand posts what it found (page.ts, room.ts), and the server
// prints it. It also keeps them, newest last, for `GET /results`: what the
// app's voice check reads back from the app's web view (app.tool.ts, P5D.9).
const kept: unknown[] = [];
const results: Plugin = {
	name: 'voice-check:results',
	configurePreviewServer(server) {
		server.middlewares.use('/results', (_request, response) => {
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify(kept));
		});
		server.middlewares.use('/result', (request, response) => {
			let body = '';
			request.on('data', (chunk) => {
				if (body.length < 200_000) body += chunk;
			});
			request.on('end', () => {
				if (request.method === 'POST') {
					if (!body.includes('"room"')) console.log(`[voice-check] ${body}`);
					try {
						kept.push(JSON.parse(body));
						if (kept.length > 500) kept.shift();
					} catch {
						// Not JSON: printed, not kept.
					}
				}
				response.statusCode = 204;
				response.end();
			});
		});
	}
};

export default defineConfig({
	root: import.meta.dirname,
	plugins: [results],
	logLevel: 'warn',
	build: {
		outDir: path.resolve(import.meta.dirname, '../../node_modules/.cache/voice-check'),
		emptyOutDir: true,
		rollupOptions: {
			input: {
				index: path.resolve(import.meta.dirname, 'index.html'),
				room: path.resolve(import.meta.dirname, 'room.html'),
				denoise: path.resolve(import.meta.dirname, 'denoise.html'),
				delay: path.resolve(import.meta.dirname, 'delay.html')
			}
		},
		minify: false,
		// A worklet module is a file of its own: the CSP blocks a `data:` one.
		assetsInlineLimit: 0,
		target: 'es2022'
	},
	worker: { format: 'es' },
	preview: {
		host: '127.0.0.1',
		port: PORT,
		strictPort: true,
		headers: {
			'content-security-policy': csp,
			'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
			'cache-control': 'no-store'
		}
	}
});
