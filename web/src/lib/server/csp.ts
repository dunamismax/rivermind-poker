/** The WebSocket origin of a page at `url`: wss:// for https pages, ws:// otherwise. */
export function socketOrigin(url: URL): string {
	return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
}

/** `policy` with the page's socket origin added to its connect-src directive. */
export function withSocketOrigin(policy: string, url: URL): string {
	const origin = socketOrigin(url);
	return policy
		.split(';')
		.map((directive) => {
			const [name, ...sources] = directive.trim().split(/\s+/);
			if (name !== 'connect-src' || sources.includes(origin)) return directive.trim();
			return [name, ...sources, origin].join(' ');
		})
		.filter(Boolean)
		.join('; ');
}
