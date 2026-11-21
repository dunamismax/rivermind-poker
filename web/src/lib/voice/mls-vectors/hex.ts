// Hex strings, as the test vectors write byte strings.
export function hexToBytes(text: string): Uint8Array<ArrayBuffer> {
	if (text.length % 2 || /[^0-9a-f]/i.test(text)) throw new Error('not a hex string');
	const bytes = new Uint8Array(text.length / 2);
	for (let n = 0; n < bytes.length; n++) bytes[n] = parseInt(text.slice(2 * n, 2 * n + 2), 16);
	return bytes;
}

export const bytesToHex = (bytes: Uint8Array): string =>
	[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
