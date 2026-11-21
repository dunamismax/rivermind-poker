import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// The voice checks' page (`pnpm voice:check`): built as the site's client is,
// with the worker a bundled module of its own, and served with the site's
// Content-Security-Policy, so a check that passes here passes under it.
export const PORT = 4391;
export const ORIGIN = `http://127.0.0.1:${PORT}`;

// The site's policy (vite.config.ts and src/hooks.server.ts).
const csp = [
	"default-src 'self'",
	"img-src 'self' data:",
	"style-src 'self'",
	"script-src 'self'",
	"connect-src 'self'",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'self'"
].join('; ');

// A browser run by hand posts what it found (page.ts), and the server prints it.
const results: Plugin = {
	name: 'voice-check:results',
	configurePreviewServer(server) {
		server.middlewares.use('/result', (request, response) => {
			let body = '';
			request.on('data', (chunk) => {
				if (body.length < 20_000) body += chunk;
			});
			request.on('end', () => {
				if (request.method === 'POST') console.log(`[voice-check] ${body}`);
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
		minify: false,
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
