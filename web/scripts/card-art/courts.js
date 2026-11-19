// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
// Each upper portrait is clipped on the diagonal and repeated at 180 degrees.
const OUTLINE = '#25241f';
const SKIN = '#fff1d1';
const GOLD = '#edbd62';
const TEAL = '#287062';
const IVORY = '#fff7e1';

// The Jack wears a feathered pilot's cap and carries an oar.
const JACK = `
	<path d="M49 132V111Q57 96 80 87L99 83Q117 89 124 110L132 132Z" fill="currentColor"/>
	<path d="M52 128Q61 108 83 99L93 104Q76 116 75 130Z" fill="${TEAL}"/>
	<path d="M96 85L109 93 97 111 85 104 77 109 70 98 79 90Z" fill="${IVORY}"/>
	<path d="M103 59Q108 70 101 81L90 94 80 88 83 83H73Q69 82 70 75L65 73 71 65 72 56Z" fill="${SKIN}"/>
	<path d="M71 59Q82 55 91 58L89 65Q91 70 95 67Q102 63 100 71Q98 77 94 76L91 85Q103 84 107 73L107 55Z" fill="${OUTLINE}"/>
	<path d="M60 58Q69 51 72 45Q84 33 102 41L111 52 109 59Q87 67 60 62Z" fill="currentColor"/>
	<path d="M68 56Q88 57 109 51L111 56Q88 63 65 60Z" fill="${GOLD}"/>
	<path d="M95 48Q102 30 118 28L115 36 120 34Q111 47 99 50Z" fill="${GOLD}"/>
	<path d="M101 44L115 31M75 67L79 66M73 78H77" fill="none"/>
	<path d="M102 130L113 63 117 63 108 130Z" fill="${IVORY}"/>
	<path d="M112 71L111 61 114 42Q116 37 120 41L122 45 118 66 116 72Z" fill="${TEAL}"/>
	<path d="M101 105Q108 99 113 101L114 108Q109 113 103 111Z" fill="${SKIN}"/>
	<path d="M54 120Q66 109 75 108M80 120L88 114" fill="none" stroke="${GOLD}" stroke-width="3"/>
`;

// The Queen's iris sceptre echoes the reeds along the table's river motif.
const QUEEN = `
	<path d="M48 132Q52 110 69 96L84 88 100 90Q114 97 125 121L128 132Z" fill="currentColor"/>
	<path d="M61 131L83 95 95 102 79 131Z" fill="${TEAL}"/>
	<path d="M103 93L113 101 104 112 90 107 77 118 69 108 79 94Z" fill="${IVORY}"/>
	<path d="M66 78Q63 57 75 49Q85 42 98 49Q110 56 105 70L99 86 101 94 88 103 72 100 67 92Z" fill="${OUTLINE}"/>
	<path d="M96 55Q104 55 104 65L110 73 104 76V82Q102 85 94 85L97 93 90 99 82 94 85 80Q77 75 82 69Q87 66 90 72Q94 64 96 55Z" fill="${SKIN}"/>
	<path d="M70 78Q72 65 84 63M71 87Q78 85 81 78M72 93Q77 92 79 89" fill="none" stroke="${GOLD}"/>
	<path d="M69 56L67 43 77 48 84 34 92 46 102 39 102 53Q85 50 69 56Z" fill="${GOLD}"/>
	<path d="M76 51Q88 47 97 49M99 68L103 69M100 79H104" fill="none"/>
	<circle cx="85" cy="79" r="2.8" fill="${GOLD}" stroke-width="1.5"/>
	<path d="M52 130L58 72 62 72 57 130Z" fill="${GOLD}"/>
	<path d="M60 81Q56 75 50 75Q50 66 55 62L58 69Q57 57 62 53Q67 59 64 69L69 63Q72 75 60 81Z" fill="${TEAL}"/>
	<path d="M59 76L62 61" fill="none" stroke="${GOLD}" stroke-width="1.6"/>
	<path d="M53 106Q59 101 64 105L63 112Q57 116 52 113Z" fill="${SKIN}"/>
	<path d="M88 107L92 113 88 119 84 113Z" fill="${GOLD}"/>
	<path d="M96 120Q106 117 111 111" fill="none" stroke="${GOLD}" stroke-width="3"/>
`;

// The King's crenellated crown and upright blade have a distinct silhouette.
const KING = `
	<path d="M44 132L49 113Q61 97 80 87L98 86Q116 93 126 114L132 132Z" fill="currentColor"/>
	<path d="M51 126Q61 108 81 96L91 104 74 132H57Z" fill="${TEAL}"/>
	<path d="M58 115L70 103 79 113 68 127Z" fill="${GOLD}"/>
	<path d="M65 59Q67 49 81 47L101 51Q109 63 101 78L104 91 87 103 72 97 66 81Z" fill="${OUTLINE}"/>
	<path d="M74 55H94L93 65Q89 73 96 73Q102 74 95 80L89 79Q87 91 80 95Q72 94 70 87L73 81Q68 80 68 76L62 74 68 66 68 59Z" fill="${SKIN}"/>
	<path d="M69 75Q75 72 82 76L86 81Q79 78 72 80M75 85Q77 88 81 85" fill="none"/>
	<path d="M66 58L63 38H72L76 45 82 36H89L94 45 99 38H107L103 59Z" fill="${GOLD}"/>
	<path d="M67 51H103M73 66L77 65" fill="none"/>
	<path d="M83 51L87 47 91 51 87 56Z" fill="currentColor" stroke-width="1.3"/>
	<path d="M92 95L108 101 99 115 82 106Z" fill="${IVORY}"/>
	<path d="M110 89L110 50 115 38 120 50 117 89Z" fill="${IVORY}"/>
	<path d="M115 48L114 84" fill="none" stroke="${GOLD}"/>
	<path d="M105 86H122V91H117V107H111V91H105Z" fill="${GOLD}"/>
	<path d="M108 100Q114 95 120 99L120 106Q115 110 108 107Z" fill="${SKIN}"/>
	<path d="M96 116L89 126 80 120 83 115" fill="none" stroke="${GOLD}" stroke-width="3"/>
`;

const PORTRAITS = { 11: JACK, 12: QUEEN, 13: KING };

export function court(rank) {
	return `<defs>
	<clipPath id="half"><path d="M43 19H125V104L43 128Z"/></clipPath>
	<clipPath id="frame"><rect x="43" y="19" width="82" height="194" rx="10"/></clipPath>
</defs>
<rect x="43" y="19" width="82" height="194" rx="10" fill="#eee7d6"/>
<g clip-path="url(#frame)">
	<g id="portrait" clip-path="url(#half)">
		<path d="M44 45Q53 43 61 36Q73 25 93 30Q106 33 123 23M44 55Q57 53 67 43M44 65Q51 63 57 59M105 69Q113 74 125 69M101 77Q112 82 124 78" fill="none" stroke="#bea881" stroke-width="2"/>
		<g stroke="${OUTLINE}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">
			${PORTRAITS[rank]}
		</g>
	</g>
	<use href="#portrait" transform="rotate(180 84 116)"/>
	<path d="M43 128L125 104" fill="none" stroke="${GOLD}" stroke-width="2.6"/>
</g>
<rect x="43" y="19" width="82" height="194" rx="10" fill="none" stroke="#a97d34" stroke-width="2.5"/>`;
}
