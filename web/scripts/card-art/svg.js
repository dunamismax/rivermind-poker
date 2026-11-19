// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
// Small helpers shared by the faces, courts and backs.

const WIDTH = 168;
const HEIGHT = 232;
export const CENTRE_X = WIDTH / 2;
export const CENTRE_Y = HEIGHT / 2;
/** Turns artwork end for end about the centre of the card. */
export const HALF_TURN = `rotate(180 ${CENTRE_X} ${CENTRE_Y})`;

/** A number rounded to two decimals, without trailing zeros. */
export const n = (value) => String(+value.toFixed(2));

/** Path data from a template literal, with every number rounded by n(). */
export function d(strings, ...values) {
	let out = strings[0];
	values.forEach((value, i) => {
		out += ` ${n(value)} ${strings[i + 1]}`;
	});
	return tidy(out);
}

/** Collapses whitespace in path data so files stay small. */
function tidy(path) {
	return path
		.replace(/\s+/g, ' ')
		.replace(/ ?([A-Za-z]) ?/g, '$1')
		.replace(/ -/g, '-')
		.trim();
}

/** A group and its copy turned end for end, as on a double-ended card. */
export function mirrored(id, contents) {
	return `<g id="${id}">${contents}</g><use href="#${id}" transform="${HALF_TURN}"/>`;
}

/** Mixes two hex colours; amount is the share of the second. */
export function mix(a, b, amount) {
	const channel = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
	return `#${[0, 1, 2]
		.map((i) =>
			Math.round(channel(a, i) * (1 - amount) + channel(b, i) * amount)
				.toString(16)
				.padStart(2, '0')
		)
		.join('')}`;
}

/**
 * Dash attributes centred on the middle of a path, so the dashes fall the
 * same way when the card is turned. Lengths are in hundredths of the path.
 */
export function centredDash(dash, gap) {
	return `pathLength="100" stroke-dasharray="${dash} ${gap}" stroke-dashoffset="${n(dash / 2 - 50)}"`;
}
