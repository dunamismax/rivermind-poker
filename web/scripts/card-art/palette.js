// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
// One palette for the whole deck: warm card stock, four suit inks chosen to
// stay apart under protan, deutan and tritan colour vision, and the river,
// felt and gold of the site.

export const STOCK = '#fdfbf4';
export const EDGE = '#cdc3ab';

export const INK = {
	black: '#14161b',
	red: '#d3202c',
	green: '#08806a',
	blue: '#2b34c4'
};

export const INKS = {
	standard: { spades: INK.black, hearts: INK.red, clubs: INK.black, diamonds: INK.red },
	'four-colour': { spades: INK.black, hearts: INK.red, clubs: INK.green, diamonds: INK.blue }
};

export const GOLD = '#c39431'; // on card stock
export const GOLD_DEEP = '#8a6420';
export const GOLD_LIGHT = '#ecc867';
export const FELT = '#0f4a37';
export const RIVER = '#2f7f8c';
export const RIVER_LIGHT = '#8cc3c4';
export const LINE = '#1d1b18'; // outline of the court figures
