// What the voice service writes to its log: counts, durations and errors,
// never a handle, an address or a token (docs/voice.md, ground rules). The
// service writes no such thing on purpose; `redact` is the second line, for
// what comes from elsewhere, such as an error message or mediasoup's own log.

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
// Anything with two or more colon-separated hex groups and a `::` or seven
// colons: IPv6 addresses, with or without brackets and a port.
const IPV6 = /\[?(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:%\w+)?\]?(?::\d{1,5})?/gi;
// What a token, a key, a public reference or an id looks like: a long run of
// base64 or hex with a digit in it. Words, even long hyphenated ones, are left.
const LONG = /[A-Za-z0-9+/_=-]{20,}/g;
const HEX = /\b[0-9a-f]{12,}\b/gi;
const hidden = (match: string) => (/[0-9]/.test(match) ? '[…]' : match);

export function redact(text: string): string {
	return text
		.replace(IPV4, '[address]')
		.replace(IPV6, (match) => (/[0-9a-f]:|:[0-9a-f]|::/i.test(match) ? '[address]' : match))
		.replace(LONG, hidden)
		.replace(HEX, hidden);
}

export type Log = (line: string) => void;

// Lines go to standard output, where the systemd journal keeps them.
export const consoleLog: Log = (line) => console.log(redact(line));
