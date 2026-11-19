// Post-build step: keep the built client free of inline code so the site's
// Content-Security-Policy (`script-src 'self'; style-src 'self'`) holds.
//
// SvelteKit starts a single-page app with an inline <script> in the fallback
// page. This moves that script into a content-hashed file under
// /_app/immutable/ and loads it with <script src>, which keeps
// document.currentScript working. It then fails the build if any page still
// has inline script or style, or a module still carries a style attribute.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const BUILD = new URL('../build/', import.meta.url).pathname;
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g;

function files(dir, suffix) {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
		.map((entry) => join(entry.parentPath, entry.name));
}

const pages = files(BUILD, '.html');
if (!pages.length) throw new Error(`No HTML pages in ${BUILD}; run vite build first.`);

for (const page of pages) {
	let html = readFileSync(page, 'utf8');
	html = html.replace(INLINE_SCRIPT, (_, code) => {
		const body = code.trim() + '\n';
		const hash = createHash('sha256').update(body).digest('base64url').slice(0, 10);
		const name = `_app/immutable/bootstrap.${hash}.js`;
		writeFileSync(join(BUILD, name), body);
		return `<script src="/${name}"></script>`;
	});
	const problems = [
		[/<script(?![^>]*\ssrc=)[^>]*>/, 'an inline <script>'],
		[/<style[\s>]/, 'a <style> element'],
		[/\sstyle=/, 'a style attribute'],
		[/\son[a-z]+=/, 'an inline event handler']
	].filter(([pattern]) => pattern.test(html));
	if (problems.length) {
		throw new Error(`${relative(BUILD, page)} still has ${problems.map((p) => p[1]).join(', ')}.`);
	}
	writeFileSync(page, html);
}

for (const module of files(join(BUILD, '_app'), '.js')) {
	if (/\sstyle="/.test(readFileSync(module, 'utf8'))) {
		throw new Error(`${relative(BUILD, module)} renders a style attribute, which the CSP blocks.`);
	}
}

console.log(`Externalized bootstrap scripts; ${pages.length} page(s) are free of inline code.`);
