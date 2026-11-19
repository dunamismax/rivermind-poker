import { execSync } from 'node:child_process';

// Every test drives the production build, served by the real table server.
export default function globalSetup() {
	if (!process.env.E2E_SKIP_BUILD) execSync('pnpm build', { stdio: 'inherit' });
}
