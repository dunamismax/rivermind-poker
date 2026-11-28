// Words that the site's content pages and the iPhone app both show (P5D.8): the table
// rules and how bots play on /fairness, and the simple bots and the caveats on /bots.
// The pages render them as they are, and the app's ports (`ContentWords.swift`) are held
// to them by the display fixture (`pnpm ios:fixtures`). Plain text only: a page wraps a
// label in <strong> itself.

/** “Table rules” on /fairness: each term, and what it means at RiverMind's tables. */
export const TABLE_RULES: readonly { term: string; text: string }[] = [
	{
		term: 'Blinds and the button',
		text: 'The two players left of the button post the small and big blinds. Heads-up, the button posts the small blind and acts first before the flop. The button moves one seat after every hand.'
	},
	{
		term: 'Joining',
		text: 'A player who sits down is dealt in from the next hand, with no missed-blind charges. A seat can be held for a player for 60 seconds while they buy in.'
	},
	{
		term: 'Betting',
		text: 'No-limit: a bet or raise can be any amount from the minimum up to all your chips. A raise must be at least as large as the last full bet or raise. An all-in for less than a full raise does not reopen the betting for players who have already acted.'
	},
	{
		term: 'Pots',
		text: 'An uncalled bet is returned. When players are all-in for different amounts, side pots are formed, and each pot goes to the best hand among the players in it. Split pots are shared equally; an odd chip goes to the first winner left of the button.'
	},
	{
		term: 'Showdown',
		text: 'Hands are shown in order, and a hand that cannot win or tie is mucked unseen. When players are all-in with no more betting possible, their hands are shown at once.'
	},
	{
		term: 'The clock',
		text: 'Each turn has 20 seconds, then a 30-second time bank that grows back by 2 seconds a hand. When both run out you check if you can, and fold otherwise. A player who is away for a full orbit is sat out.'
	}
];

/** “Bots play by the same rules” on /fairness. */
export const BOT_RULES: readonly string[] = [
	'Bots are always labelled. They decide from the same view a person in their seat would have: their own cards and what happened at the table. They never see other hole cards or the deck.',
	'Bots keep seats warm: when a person wants a seat at a table of bots, a bot finishes its hand and gives the seat up.'
];

/** “Playing fair” on /fairness. */
export const CONDUCT =
	'There is no chat: players can send a few preset reactions. Select a player’s name at the table to mute, block or report them. Reports, and signs of players working together such as two people at one table from the same network, are kept for review.';

/** The opening of /bots. */
export const BOTS_LEAD =
	'Every bot at a RiverMind table is labelled as a bot and never poses as a person. Anything this site says about how well a bot plays comes from a published measurement, shown on this page.';

/** “The simple bots” on /bots: each one's label, then what follows it. */
export const SIMPLE_BOTS: readonly { label: string; text: string }[] = [
	{
		label: 'RiverMind Easy',
		text: 'plays its cards with a plan: it raises strong hands, folds weak ones and rarely bluffs. It follows hand-written rules and was not trained.'
	},
	{ label: 'Calling bot', text: 'checks or calls almost anything.' },
	{ label: 'Random bot', text: 'picks any legal action.' }
];

/** “What these numbers do not say” on /bots, under each trained bot. */
export const BOT_CAVEATS: readonly string[] = [
	'They measure play against these bots, not against people. No claim is made about how it does against you: play it and see.',
	'It plays a simplified game: a few bet sizes on each street, and hands grouped into buckets of similar strength. Bets it has not seen are mapped to the nearest sizes it has.',
	'Like every bot here, it sees only its own cards and the table, never yours or the deck.'
];

/** How a trained bot was measured, under its heading on /bots and in the app. */
export function measuredText(seats: number): string {
	const how =
		seats === 2
			? 'Each deal is played twice with the seats swapped, so both sides hold the same cards once'
			: `Each deal is played ${seats} times, the bot once in every seat against ${seats - 1} copies of its opponent, so it holds every seat’s cards once`;
	return `It was measured in duplicate matches. ${how} and luck largely cancels. Results are big blinds won per 100 hands at blinds of 50 and 100, with a 95% interval: if the interval’s lower end is above zero, the win is unlikely to be chance.`;
}

/** The repository the published reports are read from. */
export const REPOSITORY = 'https://github.com/dunamismax/rivermind-poker/blob/main';
