// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
// Court cards. Each figure is drawn once, as the upper half of a framed
// portrait, then turned end for end below a river that crosses the middle.
// Coordinates inside a figure are relative to the top centre of the frame.
import { GOLD, GOLD_DEEP, GOLD_LIGHT, INK, LINE, RIVER, RIVER_LIGHT } from './palette.js';
import { HALF_TURN, centredDash, d, mix, n } from './svg.js';

// The frame sits between the two indices.
const FRAME = { x: 46, y: 10, width: 76, height: 212, radius: 7 };
const TOP = FRAME.y;
const CX = FRAME.x + FRAME.width / 2;

const SKIN = '#f5d9bd';
const CHEEK = '#eab9a0';
const LIPS = '#b83a44';
const IVORY = '#fbf4e2';
const STEEL = '#e3e6ea';
const GROUND = '#f4ecd7';
const RIPPLE = '#ddcb9f';

// Hair and beard colours change by suit, so the twelve courts differ.
const HAIR = {
	spades: { king: '#3b2b23', queen: '#2c221e', jack: '#7a4a24' },
	hearts: { king: '#e6e0d2', queen: '#8a3d20', jack: '#b9802f' },
	clubs: { king: '#7b4a2a', queen: '#d2a14a', jack: '#3b2b23' },
	diamonds: { king: '#c1974f', queen: '#5c3524', jack: '#2c221e' }
};

// A second fabric that sits well beside each ink: felt green beside red and
// blue, wine beside black and green.
const WINE = '#9b2c3b';
const FELT_CLOTH = '#1f6a51';
const ACCENT = { [INK.red]: FELT_CLOTH, [INK.blue]: FELT_CLOTH };
const accentFor = (ink) => ACCENT[ink] ?? WINE;

const outline = `stroke="${LINE}" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"`;
const fine = (colour, width = 0.8) =>
	`fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
const SHADE = '#c98f72';

/** A face looking out of the card. The jaw is drawn per figure. */
function face({ jaw, brows, lashes = false, eyeY = 40 }) {
	const eye = (x) =>
		`<path d="${d`M${x - 3.3} ${eyeY} Q${x} ${eyeY - 2.5} ${x + 3.3} ${eyeY} Q${x} ${eyeY + 1.9} ${x - 3.3} ${eyeY}Z`}" fill="${IVORY}"/>
		<circle cx="${x}" cy="${eyeY - 0.1}" r="1.35" fill="#3a2c24"/>
		<circle cx="${x + 0.4}" cy="${eyeY - 0.6}" r=".4" fill="${IVORY}"/>
		<path d="${d`M${x - 3.7} ${eyeY + 0.2} Q${x} ${eyeY - 3.2} ${x + 3.7} ${eyeY - 0.2}`}" ${fine(LINE, lashes ? 1.4 : 1)}/>`;
	return `<path d="${jaw}" fill="${SKIN}" ${outline}/>
		<ellipse cx="-6.4" cy="${eyeY + 6}" rx="2.8" ry="1.7" fill="${CHEEK}" opacity=".6"/>
		<ellipse cx="6.4" cy="${eyeY + 6}" rx="2.8" ry="1.7" fill="${CHEEK}" opacity=".6"/>
		${eye(-5)}${eye(5)}
		<path d="${d`M-8.8 ${eyeY - 4.4} Q-5.6 ${eyeY - 6.6} -2.2 ${eyeY - 4.8} M8.8 ${eyeY - 4.4} Q5.6 ${eyeY - 6.6} 2.2 ${eyeY - 4.8}`}" ${fine(brows, 1.4)}/>
		<path d="${d`M1.3 ${eyeY - 1} Q2.3 ${eyeY + 2.6} 1.6 ${eyeY + 4.6} M-1.7 ${eyeY + 5.2} Q0 ${eyeY + 6.6} 1.9 ${eyeY + 5.1}`}" ${fine(SHADE, 1)}/>`;
}

/** A hand closed round a staff, the thumb over the fingers, with a cuff below. */
function fist(x, y, cuff) {
	return `<path d="${d`M${x - 6} ${y + 5} H${x + 6} V${y + 8.6} H${x - 6}Z`}" fill="${cuff}" ${outline}/>
		<rect x="${x - 5.6}" y="${y - 5}" width="11.2" height="10.4" rx="3.6" fill="${SKIN}" ${outline}/>
		<path d="${d`M${x - 5.4} ${y + 0.4} H${x + 3} M${x - 5.4} ${y + 2.9} H${x + 3}`}" ${fine(SHADE, 0.8)}/>
		<path d="${d`M${x - 5.2} ${y - 2.2} C${x - 2} ${y - 4.6} ${x + 3.4} ${y - 4.4} ${x + 5.4} ${y - 1.6} C${x + 3} ${y - 0.8} ${x - 1.6} ${y - 0.8} ${x - 5.2} ${y - 2.2}Z`}" fill="${SKIN}" stroke="${SHADE}" stroke-width=".8" stroke-linejoin="round"/>`;
}

/** A sleeve rising from the edge of the frame to a cuff at (x, y). */
function sleeve(x, y, side, fabric) {
	const s = side;
	return `<path d="${d`M${x - 6 * s} ${y} H${x + 6 * s} C${x + 7 * s} ${y + 8} ${x + 8 * s} ${y + 16} ${x + 9 * s} 110 H${44 * s} V${y + 4} C${40 * s} ${y + 1} ${x + 12 * s} ${y - 1} ${x - 6 * s} ${y}Z`}" fill="${fabric}" ${outline}/>
		<path d="${d`M${x + 2 * s} ${y + 4} C${x + 3 * s} ${y + 12} ${x + 3 * s} ${y + 18} ${x + 3 * s} 110`}" ${fine(GOLD_LIGHT, 1)}/>`;
}

/** The main garment: the suit ink, a gold brocade over it and two folds. */
function robe(path, ink) {
	const fold = mix(ink, LINE, 0.45);
	return `<path d="${path}" fill="${ink}" ${outline}/>
	<path d="${path}" fill="url(#brocade)"/>
	<path d="M-31 86Q-33 98-36 110M31 86Q33 98 36 110M-14 92Q-15 101-17 110M14 92Q15 101 17 110" ${fine(fold, 1.2)}/>`;
}

/** A suit pip set in a small gold medallion. */
function medallion(x, y, r, ink) {
	return `<circle cx="${x}" cy="${y}" r="${r}" fill="${IVORY}" stroke="${GOLD_DEEP}" stroke-width="1.5"/>
		<circle cx="${x}" cy="${y}" r="${r - 1.6}" fill="none" stroke="${GOLD}" stroke-width=".5"/>
		<use href="#pip" transform="translate(${x} ${y}) scale(${n((r * 1.18) / 100)})" fill="${ink}"/>`;
}

/** Four-petal gold sprigs scattered on a robe. */
function sprigs(points, colour) {
	return `<g fill="${colour}">${points
		.map(
			([x, y]) =>
				`<path d="${d`M${x} ${y - 2.4} Q${x + 0.7} ${y - 0.7} ${x + 2.4} ${y} Q${x + 0.7} ${y + 0.7} ${x} ${y + 2.4} Q${x - 0.7} ${y + 0.7} ${x - 2.4} ${y} Q${x - 0.7} ${y - 0.7} ${x} ${y - 2.4}Z`}"/>`
		)
		.join('')}</g>`;
}

// The King: a full beard, a five-pointed crown, an ermine cape, a sword
// upright in his right hand and an orb in his left.
function king(ink, suit) {
	const hair = HAIR[suit].king;
	const accent = accentFor(ink);
	const ermine = [-34, -26, -18, 18, 26, 34]
		.map((x) => `<path d="${d`M${x} ${Math.abs(x) > 30 ? 74 : 69} q-1 3 0 4.6 q1-1.6 0-4.6Z`}"/>`)
		.join('');
	return `
	${robe('M-44 70C-34 62-22 60-12 60H12C22 60 34 62 44 70V110H-44Z', ink)}
	${sprigs(
		[
			[-34, 96],
			[-36, 106],
			[34, 104],
			[18, 104],
			[-18, 104]
		],
		GOLD_LIGHT
	)}
	<path d="M-5.6 92H5.6V110H-5.6Z" fill="${GOLD}" ${outline}/>
	<path d="M0 95L3 99 0 103-3 99ZM0 104.6L3 108.6 0 112.6-3 108.6Z" fill="${ink}"/>
	<path d="M-44 80C-36 66-18 60 0 60C18 60 36 66 44 80C36 84 30 81 24 77.4C14 80.4-14 80.4-24 77.4C-30 81-36 84-44 80Z" fill="${IVORY}" ${outline}/>
	<g fill="${LINE}">${ermine}<path d="M-6 74q-1 3 0 4.6q1-1.6 0-4.6ZM6 74q-1 3 0 4.6q1-1.6 0-4.6Z"/></g>
	<path d="M-12 28C-16 30-18 34-16.6 37C-19 40-18.6 44-16.6 46.4C-18 50.6-15 54.4-11 54.4H11C15 54.4 18 50.6 16.6 46.4C18.6 44 19 40 16.6 37C18 34 16 30 12 28Z" fill="${hair}" ${outline}/>
	<path d="M-14.6 33Q-16.4 36-14.6 39M-15.4 42Q-17 45-15 48M14.6 33Q16.4 36 14.6 39M15.4 42Q17 45 15 48" ${fine(mix(hair, LINE, 0.4), 0.8)}/>
	${face({
		jaw: 'M-11 29C-11.6 40-10.6 49-6.4 54.4C-3.2 58 3.2 58 6.4 54.4C10.6 49 11.6 40 11 29Z',
		brows: mix(hair, LINE, 0.25)
	})}
	<path d="M-11.2 42C-11.6 52-8.4 62-3 69L0 73.4 3 69C8.4 62 11.6 52 11.2 42C9.6 46.6 6.6 51.2 3 52.4Q0 51.4-3 52.4C-6.6 51.2-9.6 46.6-11.2 42Z" fill="${hair}" ${outline}/>
	<path d="M-7 55Q-5.6 61.4-2.6 66.4M7 55Q5.6 61.4 2.6 66.4M0 55V70.6" ${fine(mix(hair, LINE, 0.4), 0.8)}/>
	<path d="M-1.9 50.8Q0 52.6 1.9 50.8Q0 50.2-1.9 50.8Z" fill="${LIPS}"/>
	<path d="M0 47.6C-2.6 46.4-6.6 46.6-9.4 50.4C-6.4 49.4-3.2 49.6 0 49.2C3.2 49.6 6.4 49.4 9.4 50.4C6.6 46.6 2.6 46.4 0 47.6Z" fill="${hair}" ${outline}/>
	<path d="M-12.4 24C-12.4 11 12.4 11 12.4 24Z" fill="${accent}" ${outline}/>
	<path d="M-14 23L-15.6 9-10 15.4-7 5-3.4 13.4 0 2 3.4 13.4 7 5 10 15.4 15.6 9 14 23Z" fill="${GOLD}" ${outline}/>
	<path d="M-10.4 18.6L-7 10.4-4.6 17M10.4 18.6L7 10.4 4.6 17M-2 16.4L0 8.6 2 16.4" ${fine(GOLD_DEEP, 0.7)}/>
	<rect x="-14.6" y="22" width="29.2" height="8" rx="1" fill="${GOLD}" ${outline}/>
	<path d="M0 22.8L3 26 0 29.2-3 26Z" fill="${ink}"/>
	<ellipse cx="-8.6" cy="26" rx="2" ry="1.6" fill="${accent}"/><ellipse cx="8.6" cy="26" rx="2" ry="1.6" fill="${accent}"/>
	<g fill="${IVORY}" ${outline}><circle cx="-15.6" cy="8" r="1.9"/><circle cx="-7" cy="4" r="1.9"/><circle cx="0" cy="1.4" r="2.1"/><circle cx="7" cy="4" r="1.9"/><circle cx="15.6" cy="8" r="1.9"/></g>
	<path d="M-19 70Q-10 84 0 86Q10 84 19 70" fill="none" stroke="${GOLD_DEEP}" stroke-width="2.2" stroke-dasharray="2.2 1.1"/>
	${medallion(0, 87, 6.6, ink)}
	${sleeve(-26, 87, -1, accent)}
	<path d="M-27.6 3.6L-26 0-24.4 3.6V73H-27.6Z" fill="${STEEL}" ${outline}/>
	<path d="M-26 5V71" ${fine('#a9b0b8', 0.8)}/>
	<path d="M-34 74.4Q-32 72-29 73.4H-23Q-20 72-18 74.4Q-20 77-23 76.4H-29Q-32 77-34 74.4Z" fill="${GOLD}" ${outline}/>
	${fist(-26, 82, GOLD)}
	${sleeve(26, 87, 1, accent)}
	<path d="M20.6 82H31.4V88H20.6Z" fill="${GOLD}" ${outline}/>
	<path d="M20 79C20 76 32 76 32 79V82.4C32 84 20 84 20 82.4Z" fill="${SKIN}" ${outline}/>
	<circle cx="26" cy="70.6" r="7.4" fill="${GOLD}" ${outline}/>
	<path d="M18.6 70.6H33.4M26 63.2V70.6" stroke="${ink}" stroke-width="1.8"/>
	<path d="M26 63.2V58M23.4 60.2H28.6" stroke="${GOLD_DEEP}" stroke-width="1.7" stroke-linecap="round"/>
	<path d="M21.4 67Q24 65.6 25 66.4" ${fine(GOLD_LIGHT, 1)}/>`;
}

// The Queen: long hair under an iris coronet, a laced bodice and a water
// lily held like a sceptre; a gold fan in her other hand.
function queen(ink, suit) {
	const hair = HAIR[suit].queen;
	const accent = accentFor(ink);
	const pearls = [-12, -8, -4, 0, 4, 8, 12]
		.map((x) => `<circle cx="${x}" cy="${n(63.4 + (x * x) / 52)}" r="1.25"/>`)
		.join('');
	const ribs = [-142, -128, -114, -100]
		.map((a) => {
			const r = (a * Math.PI) / 180;
			return d`M-24 86 L${-24 + 17 * Math.cos(r)} ${86 + 17 * Math.sin(r)}`;
		})
		.join('');
	return `
	<path d="M0 17C-15 17-19.6 30-18.6 44C-18 56-22 68-28 80C-20 84-12 78-10 70H10C12 78 20 84 28 80C22 68 18 56 18.6 44C19.6 30 15 17 0 17Z" fill="${hair}" ${outline}/>
	<path d="M-14 44C-14.6 56-17 66-22 76M14 44C14.6 56 17 66 22 76M-16.4 34C-17.4 48-19.4 62-25 76M16.4 34C17.4 48 19.4 62 25 76M-12 22Q-15 26-15.6 32M12 22Q15 26 15.6 32" ${fine(mix(hair, IVORY, 0.25), 0.7)}/>
	${robe('M-44 78C-36 70-24 66-14 66C-8 70 8 70 14 66C24 66 36 70 44 78V110H-44Z', ink)}
	<path d="M-12 80Q-17 94-12 110M12 80Q17 94 12 110" ${fine(GOLD_LIGHT, 1.2)}/>
	${sprigs(
		[
			[-20, 104],
			[20, 104]
		],
		GOLD_LIGHT
	)}
	<ellipse cx="-33" cy="75" rx="10" ry="7.6" fill="${accent}" ${outline}/>
	<ellipse cx="33" cy="75" rx="10" ry="7.6" fill="${accent}" ${outline}/>
	<path d="M-39 70Q-35 76-37 82M-32 68Q-29 75-31 82.6M39 70Q35 76 37 82M32 68Q29 75 31 82.6" ${fine(GOLD_LIGHT, 1)}/>
	<path d="M-9 75H9L3.6 110H-3.6Z" fill="${IVORY}" ${outline}/>
	<path d="M-7 80L5.6 86M7 80L-5.6 86M-6.2 90L4.8 96M6.2 90L-4.8 96M-5 100L4 106M5 100L-4 106" ${fine(ink, 1)}/>
	<path d="M-5.4 50V61C-11 63-15 65-15 67C-9 75 9 75 15 67C15 65 11 63 5.4 61V50Z" fill="${SKIN}" ${outline}/>
	<path d="M-15.6 67C-9 77 9 77 15.6 67" fill="none" stroke="${GOLD}" stroke-width="2.6"/>
	<g fill="${IVORY}" stroke="${GOLD_DEEP}" stroke-width=".5">${pearls}</g>
	<path d="M0 67V70" stroke="${GOLD_DEEP}" stroke-width="1"/>
	${medallion(0, 73.6, 4.4, ink)}
	${face({
		jaw: 'M-10.2 30C-10.8 42-9.4 50-5.4 54.4C-2.4 57 2.4 57 5.4 54.4C9.4 50 10.8 42 10.2 30Z',
		brows: mix(hair, LINE, 0.3),
		lashes: true
	})}
	<path d="M-3.2 49.8Q-1.4 48.4 0 49.2Q1.4 48.4 3.2 49.8Q0 52.4-3.2 49.8Z" fill="${LIPS}"/>
	<path d="M-11 34C-9.6 26-4 23 0 25.6C4 23 9.6 26 11 34C8 30 4 28.6 0 30.6C-4 28.6-8 30-11 34Z" fill="${hair}" ${outline}/>
	<path d="M-12.4 25.6Q0 19.4 12.4 25.6V29.2Q0 23.4-12.4 29.2Z" fill="${GOLD}" ${outline}/>
	<path d="M0 2C3.6 7 4.4 13 0 21.6C-4.4 13-3.6 7 0 2ZM-9.4 10C-5.4 12.6-4.4 17-6.4 23.2C-10.4 19-11.6 14.6-9.4 10ZM9.4 10C5.4 12.6 4.4 17 6.4 23.2C10.4 19 11.6 14.6 9.4 10Z" fill="${GOLD}" ${outline}/>
	<path d="M0 7.6V17.4M-8.4 14.4L-7 19.6M8.4 14.4L7 19.6" ${fine(ink, 1.4)}/>
	<circle cx="0" cy="25.6" r="1.8" fill="${ink}"/>
	<circle cx="-6.8" cy="24.6" r="1.1" fill="${IVORY}"/><circle cx="6.8" cy="24.6" r="1.1" fill="${IVORY}"/>
	${sleeve(25, 87, 1, accent)}
	<path d="M25 80C25.8 66 26 52 25.6 42" fill="none" stroke="${RIVER}" stroke-width="2.2" stroke-linecap="round"/>
	<path d="M25.6 64C30.4 59.6 34 59.6 36 61.6C33 65 29 66 25.6 64Z" fill="${RIVER}" ${outline}/>
	<g transform="translate(25.6 36)" ${outline}>
		<path d="M0 6C-9 5-12 0-11-4C-6-3-2 0 0 6ZM0 6C9 5 12 0 11-4C6-3 2 0 0 6Z" fill="#f2bcc4"/>
		<path d="M0 6C-6 2-7-4-4-9C-1-6 1-1 0 6ZM0 6C6 2 7-4 4-9C1-6-1-1 0 6Z" fill="${IVORY}"/>
		<path d="M0 6C-3 0-2-7 0-11C2-7 3 0 0 6Z" fill="${ink}"/>
		<circle cy="3.4" r="1.8" fill="${GOLD}"/>
	</g>
	${fist(25, 82, GOLD)}
	${sleeve(-24, 91, -1, accent)}
	<path d="M-24 86L${n(-24 + 17 * Math.cos((-150 * Math.PI) / 180))} ${n(86 + 17 * Math.sin((-150 * Math.PI) / 180))}A17 17 0 0 1 ${n(-24 + 17 * Math.cos((-92 * Math.PI) / 180))} ${n(86 + 17 * Math.sin((-92 * Math.PI) / 180))}Z" fill="${IVORY}" ${outline}/>
	<path d="${ribs}" ${fine(GOLD, 0.8)}/>
	<path d="M${n(-24 + 15 * Math.cos((-150 * Math.PI) / 180))} ${n(86 + 15 * Math.sin((-150 * Math.PI) / 180))}A15 15 0 0 1 ${n(-24 + 15 * Math.cos((-92 * Math.PI) / 180))} ${n(86 + 15 * Math.sin((-92 * Math.PI) / 180))}" ${fine(GOLD, 1.6)}/>
	${fist(-24, 86, GOLD)}`;
}

// The Jack: a river ferryman in a plumed cap with a punt pole and a lantern.
function jack(ink, suit) {
	const hair = HAIR[suit].jack;
	const accent = accentFor(ink);
	return `
	${robe('M-44 74C-34 66-22 62-12 61H12C22 62 34 66 44 74V110H-44Z', ink)}
	<path d="M-30 80V110M-20 78V110M20 78V110M30 80V110" stroke="${accent}" stroke-width="3.6" stroke-linecap="round"/>
	<path d="M-30 80V110M-20 78V110M20 78V110M30 80V110" ${fine(GOLD_LIGHT, 0.7)}/>
	<path d="M-7 72H7V110H-7Z" fill="${accent}" ${outline}/>
	<path d="M-7 98H7V103H-7Z" fill="${GOLD}" ${outline}/>
	<g fill="${GOLD_LIGHT}" ${outline}><circle cx="0" cy="79" r="1.6"/><circle cx="0" cy="86" r="1.6"/><circle cx="0" cy="93" r="1.6"/></g>
	<path d="M-5 50H5V62H-5Z" fill="${SKIN}" ${outline}/>
	<path d="M-26 67C-16 58 16 58 26 67C22 72 16 74 10 73C6 74 3 73 0 71.6C-3 73-6 74-10 73C-16 74-22 72-26 67Z" fill="${IVORY}" ${outline}/>
	<path d="M-20 69.6Q-15 71.6-10 69.6M20 69.6Q15 71.6 10 69.6M0 63V71" ${fine(mix(IVORY, LINE, 0.35), 0.8)}/>
	<path d="M-14.6 46C-17 38-15 30-10 27H10C15 30 17 38 14.6 46C13 43 12 38 10.4 35H-10.4C-12 38-13 43-14.6 46Z" fill="${hair}" ${outline}/>
	${face({
		jaw: 'M-10.4 30C-11 42-9.6 50-5.6 54.6C-2.6 57.4 2.6 57.4 5.6 54.6C9.6 50 11 42 10.4 30Z',
		brows: mix(hair, LINE, 0.35)
	})}
	<path d="M-3.2 50.2Q0 51.4 3.2 50.2Q0 53.4-3.2 50.2Z" fill="${LIPS}"/>
	<path d="M-11.6 37.4C-12.4 33-10.4 30.6-6.4 30.6C-4 32.4-2 32.8 1 31.8C4 33.4 7 33 10 31C11.8 32.6 12.4 35 11.6 37.4C10 35 8 34.4 6 35C3.6 34.6 1.4 34.8-1 35.2C-4 34.4-7 34.4-11.6 37.4Z" fill="${hair}" ${outline}/>
	<path d="M-17.6 27.6C-20.6 17-8.6 10.4 3.6 10.4C16.6 10.4 23 17 20.6 26.2Z" fill="${ink}" ${outline}/>
	<path d="M-6 13.6Q0 18 4 26M6 12Q12 16 13 25" ${fine(accent, 1.6)}/>
	<path d="M-19.6 25.4Q1 31 21.6 24L22.2 28.4Q1 35.6-20 30Z" fill="${GOLD}" ${outline}/>
	<path d="M10 25C13.6 14.6 23.4 6 35.6 3.6C33 9.4 26.4 16.6 14.4 26.4Z" fill="${IVORY}" ${outline}/>
	<path d="M12.2 25.4C17.2 16 25 9.2 33.4 5.6M17 19.4L21 21M21 14.6L25 16.4M25.6 10.4L29 11.6" ${fine(GOLD_DEEP, 0.7)}/>
	${medallion(-12, 28.4, 3.8, ink)}
	${sleeve(-27, 87, -1, accent)}
	<path d="M-27 3V100" stroke="${LINE}" stroke-width="4.8" stroke-linecap="round"/>
	<path d="M-27 3V100" stroke="#9a6a35" stroke-width="2.8" stroke-linecap="round"/>
	<path d="M-29.4 3H-24.6V8H-29.4Z" fill="${GOLD}" ${outline}/>
	${fist(-27, 82, GOLD)}
	${sleeve(25, 71, 1, accent)}
	<path d="M25 66V74" stroke="${GOLD_DEEP}" stroke-width="1.4"/>
	<path d="M18.6 74H31.4L29.6 78.4H20.4Z" fill="${GOLD}" ${outline}/>
	<path d="M20.4 78.4H29.6V93H20.4Z" fill="${GOLD_LIGHT}" ${outline}/>
	<path d="M22.4 80.4H27.6V91H22.4Z" fill="#fff4c4"/>
	<path d="M25 82.6C26.8 85.2 26.8 88 25 89.8C23.2 88 23.2 85.2 25 82.6Z" fill="#ef9f2a"/>
	<path d="M18.6 93H31.4L29.6 97H20.4Z" fill="${GOLD}" ${outline}/>
	<circle cx="25" cy="98.6" r="1.6" fill="${GOLD}" ${outline}/>
	${fist(25, 62, GOLD)}`;
}

const FIGURES = { 11: jack, 12: queen, 13: king };

// A gentle river crosses the middle. The curve is an odd function about the
// centre of the card, so it maps onto itself when the card is turned.
const WAVE = 4.2;
function riverPath(offset) {
	const x0 = FRAME.x - 2;
	const x1 = FRAME.x + FRAME.width + 2;
	const y = 116 + offset;
	const q = FRAME.width / 4;
	return d`M${x0} ${y} C${x0 + q * 0.6} ${y - WAVE * 1.4} ${CX - q * 1.4} ${y - WAVE * 1.4} ${CX} ${y}
		S${x1 - q * 0.6} ${y + WAVE * 1.4} ${x1} ${y}`;
}

export function court(rank, suit, ink) {
	const { x, y, width, height, radius } = FRAME;
	// The clip runs along the river line, back across the top of the frame.
	const clip = `${riverPath(0)}V${y - 2}H${x - 2}Z`;
	const ripples = [20, 30, 40, 52, 64, 78, 92]
		.map((ry) => {
			const yy = TOP + ry;
			return d`M${x} ${yy} q9.5-3 19 0 t19 0 19 0 19 0`;
		})
		.join('');
	return {
		defs: `<pattern id="brocade" width="10" height="10" patternUnits="userSpaceOnUse">
	<path d="M5 2.4L5.7 4.3 7.6 5 5.7 5.7 5 7.6 4.3 5.7 2.4 5 4.3 4.3Z" fill="${GOLD_LIGHT}" opacity=".5"/>
	<g fill="${GOLD_LIGHT}" opacity=".35"><circle r=".7"/><circle cx="10" r=".7"/><circle cy="10" r=".7"/><circle cx="10" cy="10" r=".7"/></g>
</pattern>
<clipPath id="frame"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/></clipPath>
<clipPath id="upper"><path d="${clip}"/></clipPath>
<g id="figure" clip-path="url(#upper)">
	<path d="${ripples}" ${fine(RIPPLE, 0.9)}/>
	<g transform="translate(${CX} ${TOP + 2.6})">${FIGURES[rank](ink, suit)}</g>
</g>`,
		art: `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${GROUND}"/>
<g clip-path="url(#frame)">
	<use href="#figure"/>
	<use href="#figure" transform="${HALF_TURN}"/>
	<path d="${riverPath(0)}" fill="none" stroke="${GOLD}" stroke-width="7.4"/>
	<path d="${riverPath(0)}" fill="none" stroke="${RIVER}" stroke-width="5"/>
	<path d="${riverPath(0)}" fill="none" stroke="${RIVER_LIGHT}" stroke-width="1" ${centredDash(6, 5)}/>
</g>
<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="none" stroke="${GOLD}" stroke-width="2"/>
<rect x="${x + 2.6}" y="${y + 2.6}" width="${width - 5.2}" height="${height - 5.2}" rx="${radius - 2.4}" fill="none" stroke="${GOLD}" stroke-width=".6"/>`
	};
}
