import type { Handle } from '@sveltejs/kit/hooks';
import { withSocketOrigin } from '#lib/server/csp.ts';

// Pages carry the policy from vite.config.ts (with the hash of SvelteKit's
// start-up script). Older Safari releases do not count ws:// or wss:// as
// 'self', so the page's own socket origin is named as well, as serve-nl does.
export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	const policy = response.headers.get('content-security-policy');
	if (policy) {
		response.headers.set('content-security-policy', withSocketOrigin(policy, event.url));
	}
	return response;
};
