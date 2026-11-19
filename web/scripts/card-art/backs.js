// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
// Card backs. Every element is either centred or paired with its copy turned
// end for end, so each back looks the same either way up.
import { EDGE, GOLD_LIGHT, STOCK } from './palette.js';
import { CENTRE_X as X, CENTRE_Y as Y, centredDash, d, mirrored, n } from './svg.js';

const PANEL = { x: 8, y: 8, width: 152, height: 216, radius: 9 };

/**
 * A wave across the panel, y = A sin(2π(x − X)/λ), drawn as smooth
 * quadratic arcs. It is odd about the centre, so it maps onto itself when
 * the card is turned; λ must divide the panel width into half waves.
 */
function wave(lambda, amplitude) {
	const half = lambda / 2;
	const steps = Math.round(PANEL.width / half);
	const x0 = X - (steps / 2) * half;
	// The first half wave starts upward when an even number of half waves
	// lies left of the centre, so sin is odd about X.
	const sign = (steps / 2) % 2 === 0 ? -1 : 1;
	let path = d`M${x0} 0 Q${x0 + half / 2} ${sign * 2 * amplitude} ${x0 + half} 0`;
	for (let i = 2; i <= steps; i++) path += d`T${x0 + i * half} 0`;
	return path;
}

/** Offsets symmetric about the centre line, `gap` apart. */
function offsets(gap, reach, start = 0) {
	const out = [];
	for (let o = start; o <= reach; o += gap) {
		out.push(Y - o);
		if (o !== 0) out.push(Y + o);
	}
	return out.sort((a, b) => a - b);
}

function frame(field, pattern, rules, extra = '') {
	const { x, y, width, height, radius } = PANEL;
	return `<defs><clipPath id="panel"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/></clipPath>${extra}</defs>
<rect x=".75" y=".75" width="166.5" height="230.5" rx="15.25" fill="${STOCK}" stroke="${EDGE}" stroke-width="1.5"/>
<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${field}"/>
<g clip-path="url(#panel)">${pattern}</g>
${rules}`;
}

/** A double rule inside the panel. */
function rules(outer, inner) {
	return `<rect x="12.5" y="12.5" width="143" height="207" rx="6" fill="none" stroke="${outer}" stroke-width="1.6"/>
<rect x="15.6" y="15.6" width="136.8" height="200.8" rx="4" fill="none" stroke="${inner}" stroke-width=".6"/>`;
}

/** Beads on a circle about the centre. */
function beads(r, count, size, colour) {
	return `<g fill="${colour}">${Array.from({ length: count }, (_, i) => {
		const a = (i * 2 * Math.PI) / count;
		return `<circle cx="${n(X + r * Math.cos(a))}" cy="${n(Y + r * Math.sin(a))}" r="${size}"/>`;
	}).join('')}</g>`;
}

/** Corner fans in the four corners of the rules. */
function corners(id, colour, accent) {
	const fan = (cx, cy, sx, sy) => {
		const arc = (r) =>
			d`M${cx + sx * r} ${cy} A${r} ${r} 0 0 ${sx * sy > 0 ? 1 : 0} ${cx} ${cy + sy * r}`;
		return `<path d="${arc(17)}${arc(12.4)}${arc(7.8)}" fill="none" stroke="${colour}" stroke-width="1.2"/>
			<path d="${d`M${cx} ${cy} l${sx * 4} ${sy * 1.4} l${-sx * 1.4} ${sy * 2.6}Z`}" fill="${accent}"/>
			<circle cx="${cx + sx * 20}" cy="${cy}" r="1.4" fill="${colour}"/><circle cx="${cx}" cy="${cy + sy * 20}" r="1.4" fill="${colour}"/>`;
	};
	return `${mirrored(`${id}-a`, fan(15.6, 15.6, 1, 1))}${mirrored(`${id}-b`, fan(152.4, 15.6, -1, 1))}`;
}

// RiverMind: gold on felt. A guilloché of crossing waves, and a roundel in
// which the river bends through the middle.
function rivermind() {
	const felt = '#0f4a37';
	const deep = '#0a3427';
	const line = '#2f8063';
	const gold = '#e4ba57';
	const up = wave(38, 5);
	const lines = offsets(7, 120)
		.map((y) => `<use href="#crest" y="${n(y)}"/><use href="#trough" y="${n(y)}"/>`)
		.join('');
	const s = d`M${X + 36} ${Y - 26} C${X + 8} ${Y - 40} ${X - 26} ${Y - 20} ${X} ${Y} C${X + 26} ${Y + 20} ${X - 8} ${Y + 40} ${X - 36} ${Y + 26}`;
	const star = (x, y, r) =>
		d`M${x} ${y - r} L${x + r * 0.28} ${y - r * 0.28} ${x + r} ${y} ${x + r * 0.28} ${y + r * 0.28} ${x} ${y + r} ${x - r * 0.28} ${y + r * 0.28} ${x - r} ${y} ${x - r * 0.28} ${y - r * 0.28}Z`;
	const roundel = `<circle cx="${X}" cy="${Y}" r="43" fill="${deep}" stroke="${gold}" stroke-width="4"/>
	<circle cx="${X}" cy="${Y}" r="37.4" fill="none" stroke="${gold}" stroke-width=".8"/>
	${beads(40.2, 48, 0.85, gold)}
	${mirrored(
		'bank',
		`<path d="${d`M${X - 31} ${Y - 9} C${X - 20} ${Y - 25} ${X - 4} ${Y - 30} ${X + 8} ${Y - 26}`}" fill="none" stroke="${line}" stroke-width="1.4"/>
		<path d="${star(X + 17, Y - 26, 4.6)}" fill="${gold}"/>
		<path d="${star(X - 21, Y - 13, 2.4)}" fill="${gold}"/>
		<path d="${star(X, Y - 52, 4)}" fill="${gold}"/>`
	)}
	<g clip-path="url(#roundel)">
		<path d="${s}" fill="none" stroke="${gold}" stroke-width="17"/>
		<path d="${s}" fill="none" stroke="${deep}" stroke-width="8.2"/>
		<path d="${s}" fill="none" stroke="#5fa58e" stroke-width="1.2"/>
	</g>`;
	return frame(
		felt,
		lines,
		`${rules(gold, gold)}${corners('corner', gold, GOLD_LIGHT)}${roundel}`,
		`<clipPath id="roundel"><circle cx="${X}" cy="${Y}" r="37.4"/></clipPath><path id="crest" d="${up}" fill="none" stroke="${line}" stroke-width=".9"/><path id="trough" d="${up}" transform="scale(1 -1)" fill="none" stroke="${line}" stroke-width=".9"/>`
	);
}

// Current: bands of a blue river running the length of the card, and the
// rings a stone leaves in it at the centre.
function current() {
	const navy = '#102a4c';
	const silver = '#dce9ee';
	const light = '#8fc3e0';
	const flow = wave(76, 9);
	const strands = [
		['#1c4b82', 6.4],
		['#4685c4', 2],
		['#163d6c', 5],
		['#6aa6d6', 1.2]
	];
	const bands = offsets(8, 124)
		.map((y) => `<use href="#flow-${Math.abs(Math.round((y - Y) / 8)) % 4}" y="${n(y)}"/>`)
		.join('');
	const foam = offsets(32, 112, 16)
		.map((y) => `<use href="#foam" y="${n(y)}"/>`)
		.join('');
	const defs =
		strands
			.map(
				([colour, width], k) =>
					`<path id="flow-${k}" d="${flow}" fill="none" stroke="${colour}" stroke-width="${width}"/>`
			)
			.join('') +
		`<path id="foam" d="${flow}" fill="none" stroke="${silver}" stroke-width=".9" ${centredDash(7, 4.4)}/>`;
	const ring = (rx, ry, width, colour, extra = '') =>
		`<ellipse cx="${X}" cy="${Y}" rx="${rx}" ry="${ry}" fill="none" stroke="${colour}" stroke-width="${width}"${extra}/>`;
	const spark = (x, y, r) =>
		d`M${x} ${y - r} L${x + r * 0.3} ${y - r * 0.3} ${x + r} ${y} ${x + r * 0.3} ${y + r * 0.3} ${x} ${y + r} ${x - r * 0.3} ${y + r * 0.3} ${x - r} ${y} ${x - r * 0.3} ${y - r * 0.3}Z`;
	const rings = `<ellipse cx="${X}" cy="${Y}" rx="38" ry="46" fill="${navy}" stroke="${silver}" stroke-width="3.2"/>
	${ring(33.4, 41.4, 0.8, silver)}
	${ring(27.6, 27.6, 1.2, '#4f8cc0')}${ring(22, 22, 2.4, light)}${ring(15.6, 15.6, 2.6, silver)}${ring(9.4, 9.4, 2, light)}
	<circle cx="${X}" cy="${Y}" r="4.2" fill="${silver}"/>
	${mirrored(
		'spark',
		`<path d="${spark(X - 20, Y - 30, 3.8)}" fill="${GOLD_LIGHT}"/><path d="${spark(X + 24, Y - 25, 2.4)}" fill="${GOLD_LIGHT}"/><path d="${spark(X, Y - 56, 3.8)}" fill="${silver}"/>`
	)}`;
	return frame(
		navy,
		`${bands}${foam}`,
		`${rules(silver, silver)}${corners('corner', silver, light)}${rings}`,
		defs
	);
}

// Lattice: a gold trellis on wine, a rosette at every crossing.
function lattice() {
	const wine = '#5b1f2e';
	const gold = '#dcac4e';
	const pale = '#f5dfb2';
	const step = 26;
	const slope = 1.3;
	const lines = [];
	for (let k = -10; k <= 10; k++) {
		const c = k * step;
		// x − X = ±(y − Y)/slope + c, drawn top to bottom.
		lines.push(d`M${X + c - 116 / slope} 0 L${X + c + 116 / slope} 232`);
		lines.push(d`M${X + c + 116 / slope} 0 L${X + c - 116 / slope} 232`);
	}
	const inside = (x, y) => Math.hypot((x - X) / 34, (y - Y) / 42) < 1.12;
	const rosettes = [];
	const dots = [];
	for (let i = -8; i <= 8; i++) {
		for (let j = -8; j <= 8; j++) {
			// The families cross at x = X + (i + j)·step/2, y = Y + (i − j)·step·slope/2.
			const x = X + ((i + j) * step) / 2;
			const y = Y + ((i - j) * step * slope) / 2;
			if (x > -8 && x < 176 && y > -8 && y < 240 && !inside(x, y)) {
				rosettes.push(`<use href="#rosette" x="${n(x - X)}" y="${n(y - Y)}"/>`);
			}
			const cy = y + (step * slope) / 2;
			if (x > 0 && x < 168 && cy > 0 && cy < 232 && !inside(x, cy)) {
				dots.push(`<circle cx="${n(x)}" cy="${n(cy)}" r="1.7"/>`);
			}
		}
	}
	const petal = (r) =>
		[0, 90, 180, 270]
			.map(
				(a) =>
					`<path d="${d`M${X} ${Y} C${X - r * 0.5} ${Y - r * 0.5} ${X - r * 0.38} ${Y - r} ${X} ${Y - r * 1.2} C${X + r * 0.38} ${Y - r} ${X + r * 0.5} ${Y - r * 0.5} ${X} ${Y}Z`}" transform="rotate(${a} ${X} ${Y})"/>`
			)
			.join('');
	const medallion = `<ellipse cx="${X}" cy="${Y}" rx="34" ry="42" fill="${wine}" stroke="${gold}" stroke-width="3.2"/>
	<ellipse cx="${X}" cy="${Y}" rx="29.4" ry="37.4" fill="none" stroke="${pale}" stroke-width=".8"/>
	<g fill="${gold}">${petal(20)}</g>
	<g fill="#7c2c3d" transform="rotate(45 ${X} ${Y})">${petal(15)}</g>
	<g fill="${pale}" transform="rotate(45 ${X} ${Y})">${petal(11)}</g>
	<circle cx="${X}" cy="${Y}" r="4.4" fill="${gold}" stroke="${wine}" stroke-width="1.4"/>`;
	return frame(
		wine,
		`<path d="${lines.join('')}" stroke="#3d1320" stroke-width="5"/>
		<path d="${lines.join('')}" stroke="${gold}" stroke-width="2"/>
		<g fill="${pale}">${dots.join('')}</g>
		${rosettes.join('')}`,
		`${rules(gold, pale)}${corners('corner', gold, pale)}${medallion}`,
		`<g id="rosette"><circle cx="${X}" cy="${Y}" r="4.8" fill="${wine}" stroke="${gold}" stroke-width="1.6"/><circle cx="${X}" cy="${Y}" r="1.9" fill="${pale}"/></g>`
	);
}

export const BACK_ART = { rivermind, current, lattice };
