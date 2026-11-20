// Post-build check: the built site must keep the Content-Security-Policy
// (`script-src 'self'; style-src 'self'`, plus the hashes SvelteKit adds) true.
//
// It fails the build if a client module renders a style attribute, or if any
// page the Node build serves lacks a policy, has an inline <script> whose hash
// the policy does not allow, or has a <style> element, a style attribute or
// an inline event handler. Pages are fetched from the built handler itself,
// one request per route in src/routes (dynamic routes are skipped).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB = new URL('..', import.meta.url).pathname;
const BUILD = join(WEB, 'build');
const ROUTES = join(WEB, 'src', 'routes');

function files(dir, suffix) {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
		.map((entry) => join(entry.parentPath, entry.name));
}

for (const module of files(join(BUILD, 'client', '_app'), '.js')) {
	if (/\sstyle="/.test(readFileSync(module, 'utf8'))) {
		throw new Error(`${relative(BUILD, module)} renders a style attribute, which the CSP blocks.`);
	}
}

/** URL paths of the routes with a page, leaving out dynamic ones and (groups). */
function pagePaths() {
	return files(ROUTES, '+page.svelte')
		.map((file) => relative(ROUTES, file).split(sep).slice(0, -1))
		.filter((parts) => !parts.some((part) => part.includes('[')))
		.map((parts) => '/' + parts.filter((part) => !/^\(.*\)$/.test(part)).join('/'))
		.sort();
}

/** Problems with one served page; empty when it keeps the policy. */
function problemsWith(html, policy) {
	if (!policy) return ['no Content-Security-Policy header'];
	const scriptSrc = /(?:^|;)\s*script-src([^;]*)/.exec(policy)?.[1] ?? '';
	const problems = [];
	for (const [, attributes, code] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
		if (/\ssrc=/.test(attributes)) continue;
		const hash = createHash('sha256').update(code).digest('base64');
		if (!scriptSrc.includes(`'sha256-${hash}'`))
			problems.push('an inline <script> without its hash');
	}
	for (const [pattern, what] of [
		[/<style[\s>]/, 'a <style> element'],
		[/\sstyle=/, 'a style attribute'],
		[/\son[a-z]+=/, 'an inline event handler']
	]) {
		if (pattern.test(html)) problems.push(what);
	}
	return problems;
}

const { handler } = await import(pathToFileURL(join(BUILD, 'handler.js')).href);
const server = createServer((req, res) => handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const paths = pagePaths();
try {
	for (const path of paths) {
		const response = await fetch(origin + path);
		if (!response.ok) throw new Error(`${path} answered ${response.status}.`);
		const problems = problemsWith(
			await response.text(),
			response.headers.get('content-security-policy')
		);
		if (problems.length) throw new Error(`${path} has ${problems.join(', ')}.`);
	}
} finally {
	server.closeAllConnections();
	server.close();
}

console.log(`${paths.length} page(s) keep the CSP: ${paths.join(', ')}`);
