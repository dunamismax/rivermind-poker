// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
// Aces. Every ace sets its suit in the same beaded gold ring; inside the
// ring each suit has its own ornament.
import { pip } from './faces.js';
import { FELT, GOLD, GOLD_DEEP, GOLD_LIGHT, RIVER, RIVER_LIGHT, STOCK } from './palette.js';
import { HALF_TURN, d, mix, n } from './svg.js';

const X = 84;
const Y = 116;
const RING = 39;

function ring() {
	const beads = Array.from({ length: 36 }, (_, i) => {
		const a = (i * Math.PI) / 18;
		return `<circle cx="${n(X + (RING - 2.2) * Math.cos(a))}" cy="${n(Y + (RING - 2.2) * Math.sin(a))}" r=".9"/>`;
	}).join('');
	// A leaf spray above and below the ring, the lower one turned.
	const spray = `<g id="spray" fill="${GOLD}">
		<path d="${d`M${X} ${Y - RING - 2} C${X - 3} ${Y - RING - 7} ${X - 2} ${Y - RING - 12} ${X} ${Y - RING - 15} C${X + 2} ${Y - RING - 12} ${X + 3} ${Y - RING - 7} ${X} ${Y - RING - 2}Z`}"/>
		<path d="${d`M${X - 3} ${Y - RING - 1} C${X - 9} ${Y - RING - 3} ${X - 15} ${Y - RING - 2} ${X - 20} ${Y - RING + 3} C${X - 14} ${Y - RING + 1} ${X - 8} ${Y - RING + 1} ${X - 3} ${Y - RING - 1}Z M${X + 3} ${Y - RING - 1} C${X + 9} ${Y - RING - 3} ${X + 15} ${Y - RING - 2} ${X + 20} ${Y - RING + 3} C${X + 14} ${Y - RING + 1} ${X + 8} ${Y - RING + 1} ${X + 3} ${Y - RING - 1}Z`}"/>
		<circle cx="${X - 22}" cy="${Y - RING + 4.6}" r="1.4"/><circle cx="${X + 22}" cy="${Y - RING + 4.6}" r="1.4"/>
	</g>`;
	return `<circle cx="${X}" cy="${Y}" r="${RING}" fill="none" stroke="${GOLD}" stroke-width="1.8"/>
	<circle cx="${X}" cy="${Y}" r="${RING - 4.4}" fill="none" stroke="${GOLD}" stroke-width=".7"/>
	<g fill="${GOLD}">${beads}</g>
	${spray}<use href="#spray" transform="${HALF_TURN}"/>`;
}

/** Fine lines inside a large pip, in card stock, so the shape reads as cut. */
function inlay(scale, inset) {
	return `<use href="#pip" transform="translate(${X} ${Y}) scale(${n(scale * inset)})" fill="none" stroke="${STOCK}" stroke-width="${n(1.4 / (scale * inset))}"/>`;
}

// Spades: the largest pip in the deck, with a fan of rays behind it.
function spades() {
	const rays = Array.from({ length: 24 }, (_, i) => {
		const a = (i * Math.PI) / 12;
		const r0 = 12;
		const r1 = RING - 6.4;
		return d`M${X + r0 * Math.cos(a)} ${Y + r0 * Math.sin(a)} L${X + r1 * Math.cos(a)} ${Y + r1 * Math.sin(a)}`;
	}).join('');
	return `<circle cx="${X}" cy="${Y}" r="${RING - 4.4}" fill="${mix(GOLD_LIGHT, STOCK, 0.72)}"/>
	<path d="${rays}" stroke="${GOLD_LIGHT}" stroke-width="1.2"/>
	${ring()}
	${pip(X, Y - 1, 0.56, false)}
	${inlay(0.56, 0.72)}
	<path d="${d`M${X} ${Y - 10} L${X + 3.6} ${Y - 5} ${X} ${Y} ${X - 3.6} ${Y - 5}Z`}" fill="${GOLD_LIGHT}"/>`;
}

// Hearts: a heart dropped into the river, its ripples spreading out.
function hearts() {
	const ripples = [20, 25.5, 31]
		.map(
			(r, i) =>
				`<ellipse cx="${X}" cy="${Y + 6}" rx="${r + 6}" ry="${n((r + 6) * 0.46)}" fill="none" stroke="${i === 2 ? RIVER_LIGHT : RIVER}" stroke-width="${1.6 - i * 0.35}"/>`
		)
		.join('');
	return `<circle cx="${X}" cy="${Y}" r="${RING - 4.4}" fill="${mix(RIVER_LIGHT, STOCK, 0.75)}"/>
	${ripples}
	${ring()}
	${pip(X, Y - 2, 0.5, false)}
	${inlay(0.5, 0.7)}`;
}

// Clubs: crossed bulrushes behind the club.
function clubs() {
	const reed = (s) => {
		// A stem from the lower right to the upper left (or mirrored), a
		// seed head near its tip and a blade leaf curving out from its foot.
		const angle = Math.atan2(-56, -37 * s);
		const ux = Math.cos(angle);
		const uy = Math.sin(angle);
		const at = (t, w = 0) => [X + 10 * s + ux * t - uy * w, Y + 30 + uy * t + ux * w];
		const [hx0, hy0] = at(50);
		const [hx1, hy1] = at(62);
		const head = d`M${at(50, -2.4)[0]} ${at(50, -2.4)[1]} L${at(62, -2.4)[0]} ${at(62, -2.4)[1]} Q${at(65)[0]} ${at(65)[1]} ${at(62, 2.4)[0]} ${at(62, 2.4)[1]} L${at(50, 2.4)[0]} ${at(50, 2.4)[1]} Q${at(47)[0]} ${at(47)[1]} ${at(50, -2.4)[0]} ${at(50, -2.4)[1]}Z`;
		return `<path d="${d`M${at(0)[0]} ${at(0)[1]} L${at(70)[0]} ${at(70)[1]}`}" stroke="${FELT}" stroke-width="1.6" stroke-linecap="round"/>
		<path d="${head}" fill="#7a4a24" stroke="#4d2c14" stroke-width=".6"/>
		<path d="${d`M${hx0} ${hy0} L${hx1} ${hy1}`}" stroke="#a5703c" stroke-width=".8"/>
		<path d="${d`M${X + 4 * s} ${Y + 28} C${X - 6 * s} ${Y + 16} ${X - 18 * s} ${Y + 10} ${X - 31 * s} ${Y + 10} C${X - 20 * s} ${Y + 14} ${X - 8 * s} ${Y + 22} ${X + 1 * s} ${Y + 31}Z`}" fill="${FELT}"/>
		<path d="${d`M${X + 8 * s} ${Y + 29} C${X + 2 * s} ${Y + 14} ${X - 2 * s} ${Y + 2} ${X - 2 * s} ${Y - 12} C${X + 2 * s} ${Y + 2} ${X + 6 * s} ${Y + 14} ${X + 11 * s} ${Y + 28}Z`}" fill="#2f7a5f"/>`;
	};
	return `<circle cx="${X}" cy="${Y}" r="${RING - 4.4}" fill="${mix('#9cc8b0', STOCK, 0.7)}"/>
	<g clip-path="url(#ace-field)">${reed(1)}${reed(-1)}</g>
	${ring()}
	${pip(X, Y - 1, 0.44, false)}
	${inlay(0.44, 0.7)}`;
}

// Diamonds: the diamond set on an eight-pointed gold star.
function diamonds() {
	const star = (r0, r1, turn) =>
		Array.from({ length: 8 }, (_, i) => {
			const a = ((i + turn) * Math.PI) / 4 - Math.PI / 2;
			const b = a + Math.PI / 8;
			const c = a - Math.PI / 8;
			return d`M${X} ${Y} L${X + r0 * Math.cos(c)} ${Y + r0 * Math.sin(c)} L${X + r1 * Math.cos(a)} ${Y + r1 * Math.sin(a)} L${X + r0 * Math.cos(b)} ${Y + r0 * Math.sin(b)}Z`;
		}).join('');
	return `<circle cx="${X}" cy="${Y}" r="${RING - 4.4}" fill="${mix(GOLD_LIGHT, STOCK, 0.78)}"/>
	<path d="${star(9, 30, 0.5)}" fill="${GOLD_LIGHT}" stroke="${GOLD}" stroke-width=".6" stroke-linejoin="round"/>
	<path d="${star(10, 33.6, 0)}" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width=".6" stroke-linejoin="round"/>
	${ring()}
	${pip(X, Y, 0.5, false)}
	${inlay(0.5, 0.68)}`;
}

const ACES = { spades, hearts, clubs, diamonds };

export function ace(suit) {
	return {
		defs: `<clipPath id="ace-field"><circle cx="${X}" cy="${Y}" r="${RING - 4.4}"/></clipPath>`,
		art: ACES[suit]()
	};
}
