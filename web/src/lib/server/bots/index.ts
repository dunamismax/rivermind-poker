// The bots in TypeScript (P4B.6), ported from rivermind/bots, which stays the
// reference: the random, calling-station and RiverMind Easy bots, and the
// trained blueprint read from a serving bundle (`rivermind-poker blueprint
// export`). Bots draw from a `PythonRandom`, seeded per table from the
// operating system's randomness, so a seeded bot plays as its Python
// counterpart does; scripts/bots-parity.ts checks that they agree.

export {
	abstractActions,
	abstractionNamed,
	streetLevel,
	type AbstractAction,
	type Abstraction
} from './abstraction.ts';
export { BlueprintPolicy, pseudoHarmonic, type Stats } from './blueprint.ts';
export {
	BundleError,
	CardTables,
	loadBundle,
	type Bundle,
	type Graph,
	type LoadOptions,
	type Tree
} from './bundle.ts';
export { MultiwayBlueprintPolicy } from './multiway.ts';
export { PythonRandom } from './mt.ts';
export {
	CallingStationPolicy,
	defaultBots,
	HeuristicPolicy,
	MinBetPolicy,
	RandomPolicy,
	type BotRandom,
	type Policy
} from './policies.ts';
