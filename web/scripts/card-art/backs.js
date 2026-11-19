// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
const GOLD = '#f2c14e';

function mirrored(id, contents) {
	return `<g id="${id}">${contents}</g>
	<use href="#${id}" transform="rotate(180 84 116)"/>`;
}

function back(paper, field, pattern, border) {
	return `<defs><clipPath id="panel"><rect x="9" y="9" width="150" height="214" rx="13"/></clipPath></defs>
<rect x="1" y="1" width="166" height="230" rx="19" fill="${paper}" stroke="${paper}" stroke-width="2"/>
<g clip-path="url(#panel)">
	<rect width="168" height="232" fill="${field}"/>
	${pattern}
</g>
<rect x="15.5" y="15.5" width="137" height="201" rx="9" stroke="${border}" stroke-width="2.2" fill="none"/>`;
}

// A broad river bend and an octagonal seal carry the signature at table size.
function rivermind() {
	const banks = mirrored(
		'banks',
		`<path d="M12 68Q37 60 51 41T84 10 M12 82Q45 73 61 50T100 10 M13 97Q51 90 71 58T118 10 M13 112Q49 105 68 86" fill="none" stroke="#68a28a" stroke-width="2.6"/>
		<path d="M26 27L33 34 26 41 19 34Z M136 54L141 59 136 64 131 59Z" fill="${GOLD}"/>`
	);
	return back(
		'#ede3c9',
		'#123b2b',
		`${banks}
		<path d="M58 63H110L132 85V147L110 169H58L36 147V85Z" fill="#0b231b" stroke="${GOLD}" stroke-width="4"/>
		<path d="M60 72H108L123 87V145L108 160H60L45 145V87Z" fill="none" stroke="#558c72" stroke-width="2"/>
		<path d="M107 81C98 88 89 84 78 87C62 92 62 104 71 111Q77 115 84 116Q91 117 97 121C106 128 106 140 90 145C79 148 70 144 61 151" fill="none" stroke="${GOLD}" stroke-width="9" stroke-linecap="round"/>`,
		GOLD
	);
}

// Two wide silt banks follow the lighter blue channel on a diagonal.
function current() {
	const banks = mirrored(
		'channel-bank',
		`<path d="M-14 12C98 12 68 122 182 122" stroke="#245686" stroke-width="25"/>
		<path d="M-14 27C98 27 68 137 182 137" stroke="#88b9cf" stroke-width="6"/>
		<path d="M-14 50C98 50 70 158 182 158" stroke="#366c9c" stroke-width="13"/>
		<path d="M28 48H52M34 57H48" stroke="#d3e4e5" stroke-width="2.5" stroke-linecap="round"/>`
	);
	return back(
		'#e4ece9',
		'#152d4a',
		`<g fill="none">
			${banks}
			<path d="M-14 62C98 62 70 170 182 170" stroke="#d3e4e5" stroke-width="15"/>
			<path d="M-14 62C98 62 70 170 182 170" stroke="#73b1c9" stroke-width="5"/>
		</g>`,
		'#c9dfe0'
	);
}

// Offset rows of lozenges make a warm, woven field.
function lattice() {
	const upper = [
		[28, 27],
		[84, 27],
		[140, 27],
		[56, 57],
		[112, 57],
		[28, 87],
		[84, 87],
		[140, 87]
	];
	const lozenge = (x, y) =>
		`<g transform="translate(${x} ${y})">
			<path d="M0-21 18 0 0 21-18 0Z" fill="#a24653" stroke="#d98e85" stroke-width="2"/>
			<path d="M0-10 8 0 0 10-8 0Z" fill="#f7d7ad"/>
		</g>`;
	return back(
		'#f5e3cb',
		'#5c2634',
		`${mirrored('upper-lozenges', upper.map(([x, y]) => lozenge(x, y)).join(''))}
		${lozenge(56, 116)}${lozenge(112, 116)}
		<path d="M84 106 92 116 84 126 76 116Z" fill="#e3a565"/>`,
		'#e9b783'
	);
}

export const BACK_ART = { rivermind, current, lattice };
