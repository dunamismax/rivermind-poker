// The pairs of colours the site's contrast is measured on (theme.spec.ts, P5C.2), by
// palette name. The iPhone app measures the same pairs on its own tokens (P5D.5), which
// `pnpm art` writes from this file (scripts/art/swift.js).

// Where the pages put text: the page, the header and wells, panels, raised panels
// and slate buttons, and the felt.
export const SURFACES = ['night', 'ink', 'deep-slate', 'slate', 'felt-dark', 'felt'];
export const TEXT = [
	'paper',
	'paper-shade',
	'mist',
	'haze',
	'gold',
	'gold-light',
	'green-light',
	'red-light',
	'violet-light',
	'blue-light',
	'amber',
	'warn'
];

/** Text on a colour of its own: button faces, tags, paper and a chosen option's note. */
export const LABELS: [string, string][] = [
	['paper', 'slate'],
	['white', 'red-dark'],
	['white', 'blue-dark'],
	['white', 'green-dark'],
	['ink', 'amber'],
	['ink', 'gold'],
	['ink', 'paper'],
	['amber-deep', 'gold'],
	['violet-light', 'ink'],
	['suit-clubs', 'card'],
	['suit-diamonds', 'card'],
	['suit-hearts', 'card'],
	['suit-spades', 'card']
];

/** Controls and their states against what they sit on (3:1): edges, faces, the thumb and focus. */
export const CONTROLS: [string, string][] = [
	['dusk', 'night'],
	['dusk', 'deep-slate'],
	['dusk', 'ink'],
	['red-dark', 'night'],
	['blue-dark', 'night'],
	['green-dark', 'night'],
	['amber', 'night'],
	['gold', 'night'],
	['gold', 'ink'],
	['gold', 'deep-slate'],
	['gold', 'slate'],
	['gold', 'felt'],
	['gold-light', 'deep-slate'],
	['red', 'red-deep']
];
