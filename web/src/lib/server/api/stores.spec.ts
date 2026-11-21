// The memory stores, for a server without a database (P4B.5a).
import { describe } from 'vitest';
import { MemoryPlayers } from './players.ts';
import { MemorySafety } from './safety.ts';
import { checkLedgersOf, storeSuite } from './stores.testing.ts';
import { MemoryWallet } from './wallet.ts';

describe('memory stores', () => {
	storeSuite(async () => {
		const players = new MemoryPlayers();
		const wallet = new MemoryWallet();
		return {
			players,
			wallet,
			safety: new MemorySafety((id) => players.handleOf(id)),
			checkLedgers: (ids) => checkLedgersOf(wallet, ids)
		};
	});
});
