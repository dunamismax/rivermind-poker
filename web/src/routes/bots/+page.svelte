<script lang="ts">
	// The bots and how the trained one was measured (P5.7a, D-7): every strength
	// claim on the site links here, and this page shows the published evaluation
	// of each champion in the registry this build was made with
	// (docs/models.md, src/lib/champions.json).
	import { resolve } from '$app/paths';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import registry from '#lib/champions.json';
	import { winRate } from '#lib/nl/faces.ts';

	const REPOSITORY = 'https://github.com/dunamismax/rivermind-poker/blob/main/docs';
	const OPPONENTS: Record<string, string> = {
		heuristic: 'RiverMind Easy',
		calling_station: 'Calling bot',
		random: 'Random bot',
		min_bettor: 'Min-bet probe'
	};
	interface Row {
		opponent: string;
		name: string | null;
		stack_bb: number;
		hands: number;
		bb_per_100: number;
		ci95: number[];
		gate: boolean;
	}
	interface Level {
		share: number;
		recorded: string;
		evaluation: { report: string; deals: number; seed: number; results: Row[] };
	}
	// A champion's difficulty levels (P5.7) are in the extract once `blueprint level` records one.
	const champions = registry.champions.map((c) => ({
		...c,
		medium: ((c as { levels?: { medium?: Level } }).levels?.medium ?? null) as Level | null,
		// A nine-seat model (P5.6, option 1) plays on the six-seat champion it names.
		buildsOn: ((c as { builds_on?: string }).builds_on ?? null) as string | null
	}));
	/**
	 * The table sizes whose champion the table server plays (`loadTrained` and
	 * `MULTIWAY_SERVED` in runtime.ts). A champion of another format is shown
	 * with its evaluation and marked as not offered yet, never as a bot at the
	 * tables (D-7).
	 */
	const SERVED_SEATS = [2, 6, 9];
	/** Whether a six-seat model is offered, so the heads-up one also plays the two-player hands of bigger tables. */
	const multiway = champions.some((c) => c.seats === 6);
	/** The same for Medium, which plays six seats only where the six-seat model's Medium is recorded. */
	const mediumMultiway = champions.some((c) => c.seats === 6 && c.medium);
	/** Whether a nine-seat model is offered on the six-seat one, and its Medium. */
	const nine = champions.some((c) => c.seats === 9);
	const mediumNine = champions.some((c) => c.seats === 9 && c.medium);
	const wordFor = (n: number) =>
		['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][n - 2] ?? String(n);
	/** Which hands a served model plays (P5.7), as a sentence's end. */
	const playsWhat = (seats: number, bigger = multiway, biggest = nine) =>
		seats === 2
			? bigger
				? 'and it plays every hand with two players dealt in: heads-up tables, and the hands at bigger tables where only two are left'
				: 'and it plays tables of 2 seats only'
			: seats === 6 && biggest
				? 'and it plays hands of three to six players, at tables of three to six seats, and almost every decision at tables of seven to nine (below)'
				: `and it plays hands of three to ${wordFor(seats)} players, at tables of three to ${wordFor(seats)} seats`;
	const opponentName = (row: { opponent: string; name: string | null }) =>
		row.opponent === 'champion'
			? `The champion before it${row.name ? ` (${row.name})` : ''}`
			: row.opponent === 'hard'
				? `RiverMind Hard${row.name ? ` (${row.name})` : ''}`
				: (OPPONENTS[row.opponent] ?? row.opponent);

	const heading = 'mt-10 mb-3 text-m text-gold-light';
	const list = 'list-disc pl-10 [&>li+li]:mt-3';
	const cell = 'px-3 py-2 text-left align-top lt-460:px-2';
	const number = 'px-3 py-2 text-right align-top whitespace-nowrap lt-460:px-2';
	// A phone has no room for the hands column: every matchup has as many, and the note says how many.
	const wide = `${number} lt-460:hidden`;
	// Where the page has room, every table keeps its columns in the same places.
	const narrow = 'ge-600:w-[16%]';
	const middle = 'ge-600:w-[19%]';
	const broad = 'ge-600:w-[27%]';
	// On a phone the interval breaks after “to”.
	const interval =
		'px-3 py-2 text-right align-top whitespace-nowrap lt-460:px-2 lt-460:whitespace-normal';
</script>

<svelte:head>
	<title>The bots · RiverMind Poker</title>
	<meta
		name="description"
		content="The bots at RiverMind Poker’s tables, and the published evaluations behind RiverMind Hard, the trained heads-up bot, and RiverMind Medium."
	/>
</svelte:head>

<SiteHeader>
	<a class="ui-btn small" href={resolve('/')}>Play</a>
</SiteHeader>

<main class="page mx-auto max-w-[860px] p-8">
	<article class="ui-panel px-10 pt-8 pb-10 text-mist">
		<h2 class="mb-5 text-l text-gold text-shadow-ink">The bots</h2>
		<p class="lead text-paper">
			Every bot at a RiverMind table is labelled as a bot and never poses as a person. Anything this
			site says about how well a bot plays comes from a published measurement, shown on this page.
		</p>

		<section aria-labelledby="simple">
			<h3 id="simple" class={heading}>The simple bots</h3>
			<ul class={list}>
				<li>
					<strong class="text-paper">RiverMind Easy</strong> plays its cards with a plan: it raises strong
					hands, folds weak ones and rarely bluffs. It follows hand-written rules and was not trained.
				</li>
				<li><strong class="text-paper">Calling bot</strong> checks or calls almost anything.</li>
				<li><strong class="text-paper">Random bot</strong> picks any legal action.</li>
			</ul>
		</section>

		{#each champions as champion (champion.name)}
			<section aria-labelledby="hard-{champion.format}">
				<h3 id="hard-{champion.format}" class={heading}>RiverMind Hard, {champion.format}</h3>
				{#if champion.buildsOn}
					<p>
						At tables of seven to nine RiverMind Hard plays the six-seat model,
						<code class="text-green-light">{champion.buildsOn}</code>, with one addition. Before the
						flop, the first players to act at a big table sit in seats a six-seat table does not
						have, and their first decision comes from a small table trained for them over {champion.iterations.toLocaleString(
							'en-US'
						)} deals, each choice valued by playing the rest of the hand out with the six-seat model.
						That table is <code class="text-green-light">{champion.name}</code>, promoted on {champion.promoted}.
					</p>
					<p class="mt-5">
						When those early seats all fold, which is most hands, the rest is exactly a six-seat
						hand (folding in turn puts no chips in). When one stays in, the six-seat model plays on
						with the players placed by their order of play, a part that was never trained at nine
						seats. It was measured at full tables of nine.
					</p>
				{:else}
					<p>
						RiverMind Hard is a trained bot. It learned {champion.format} no-limit hold’em by playing
						against itself for {champion.iterations.toLocaleString('en-US')} training iterations, {SERVED_SEATS.includes(
							champion.seats
						)
							? playsWhat(champion.seats)
							: `and it plays tables of ${champion.seats} seats only`}. The model it plays is
						<code class="text-green-light">{champion.name}</code>, promoted on {champion.promoted}.
					</p>
				{/if}
				{#if champion.seats === 6}
					<p class="mt-5">
						A hand with only two players dealt in goes to the heads-up model instead: heads-up is a
						different game, since the button posts the small blind and acts last after the flop. At
						a table of fewer than {wordFor(champion.seats)} it plays as though the first seats to act
						had folded, which is the same game, because folding in turn puts no chips in the pot. It was
						measured at full tables of {wordFor(champion.seats)}.
					</p>
				{/if}
				{#if !SERVED_SEATS.includes(champion.seats)}
					<p class="not-served mt-5 text-paper">
						Not offered at the tables yet: this model has passed the promotion gate, and serving it
						at {champion.seats}-seat tables is still being built.
					</p>
				{/if}
				<p class="mt-5">
					It was measured in duplicate matches. {champion.seats === 2
						? 'Each deal is played twice with the seats swapped, so both sides hold the same cards once'
						: `Each deal is played ${champion.seats} times, the bot once in every seat against ${champion.seats - 1} copies of its opponent, so it holds every seat’s cards once`}
					and luck largely cancels. Results are big blinds won per 100 hands at blinds of 50 and 100,
					with a 95% interval: if the interval’s lower end is above zero, the win is unlikely to be chance.
				</p>
				{#each champion.evaluations as evaluation (evaluation.report)}
					<h4 class="mt-8 mb-3 text-paper">
						{evaluation.candidate !== 'bundle'
							? 'The trained checkpoint, before rounding'
							: SERVED_SEATS.includes(champion.seats)
								? 'The strategy this site serves'
								: 'The strategy as it will be served'}
					</h4>
					<div class="overflow-x-auto">
						<table class="ui-inset w-full border-collapse text-s ge-600:table-fixed">
							<caption class="sr-only">
								Results of {champion.name}, {evaluation.candidate === 'bundle'
									? 'as served'
									: 'as trained'}
							</caption>
							<thead class="text-gold-light">
								<tr>
									<th scope="col" class={cell}>Against, and stacks</th>
									<th scope="col" class="{wide} {narrow}">Hands</th>
									<th scope="col" class="{number} {middle}">Won per 100</th>
									<th scope="col" class="{interval} {broad}">95% interval</th>
								</tr>
							</thead>
							<tbody>
								{#each evaluation.results as row (`${row.opponent}-${row.stack_bb}`)}
									<tr class={row.gate ? 'text-paper' : ''}>
										<th scope="row" class="{cell} font-[400]">
											{opponentName(row)}{#if row.gate}<span class="text-gold-light">*</span>{/if}
											<span class="block text-haze">{row.stack_bb} bb</span>
										</th>
										<td class={wide}>{row.hands.toLocaleString('en-US')}</td>
										<td class={number}>{winRate(row.bb_per_100)}</td>
										<td class={interval}>{winRate(row.ci95[0])} to {winRate(row.ci95[1])}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="mt-3 text-s text-haze">
						<span class="text-gold-light">*</span> The promotion gate: a model is served only if
						each of these intervals is above zero. {evaluation.deals.toLocaleString('en-US')} deals a
						matchup, each played from {champion.seats === 2
							? 'both seats'
							: `all ${champion.seats} seats`}
						({(champion.seats * evaluation.deals).toLocaleString('en-US')} hands), seed {evaluation.seed}.
						<a
							class="text-gold-light"
							href="{REPOSITORY}/{evaluation.report}.md"
							rel="noreferrer external"
						>
							The full report
						</a>
						has every input, so anyone can rerun it and get the same numbers.
					</p>
				{/each}

				<h4 class="mt-8 mb-3 text-paper">What these numbers do not say</h4>
				<ul class={list}>
					<li>
						They measure play against these bots, not against people. No claim is made about how it
						does against you: play it and see.
					</li>
					<li>
						It plays a simplified game: a few bet sizes on each street, and hands grouped into
						buckets of similar strength. Bets it has not seen are mapped to the nearest sizes it
						has.
					</li>
					<li>
						Like every bot here, it sees only its own cards and the table, never yours or the deck.
					</li>
				</ul>

				<h4 class="mt-8 mb-3 text-paper">What the server checks before it plays</h4>
				<p>
					The table server loads the model only if every file matches the registry, so the strategy
					at your table is the one measured above{champion.medium
						? ', for Hard and for Medium'
						: ''}. {champion.buildsOn ? 'Its early table’s' : 'Its strategy file’s'} SHA-256 is
					<code class="text-s break-all text-green-light">
						{(champion.bundle.files as Record<string, string | undefined>)[
							champion.buildsOn ? 'early.u8' : 'strategy.u8'
						]}
					</code>
					and {champion.buildsOn ? 'the six-seat model’s card tables’' : 'its card tables’'} is
					<code class="text-s break-all text-green-light">{champion.bundle.table_set}</code>.
					<a class="text-gold-light" href="{REPOSITORY}/models.md" rel="noreferrer external">
						The model registry
					</a>
					lists every model put to the gate, including those that did not pass.
				</p>
			</section>
			{#if champion.medium}
				{@const level = champion.medium}
				<section aria-labelledby="medium-{champion.format}">
					<h3 id="medium-{champion.format}" class={heading}>RiverMind Medium, {champion.format}</h3>
					<p>
						RiverMind Medium plays each hand either as RiverMind Hard or as RiverMind Easy: at the
						start of a hand it picks one at random, {level.share === 0.5
							? 'each half the time'
							: `Hard ${Math.round(level.share * 100)}% of the time`}, and plays the whole hand that
						way. It uses the same model as Hard,
						<code class="text-green-light">{champion.name}</code>, {champion.buildsOn
							? 'and it plays tables of seven to nine seats'
							: SERVED_SEATS.includes(champion.seats)
								? playsWhat(champion.seats, mediumMultiway, mediumNine)
								: `and it plays tables of ${champion.seats} seats only`}.
					</p>
					<p class="mt-5">
						It has its own measurement, in the same duplicate matches, against the same bots and
						against RiverMind Hard itself:
					</p>
					<div class="mt-5 overflow-x-auto">
						<table class="ui-inset w-full border-collapse text-s ge-600:table-fixed">
							<caption class="sr-only">
								Results of RiverMind Medium made from {champion.name}
							</caption>
							<thead class="text-gold-light">
								<tr>
									<th scope="col" class={cell}>Against, and stacks</th>
									<th scope="col" class="{wide} {narrow}">Hands</th>
									<th scope="col" class="{number} {middle}">Won per 100</th>
									<th scope="col" class="{interval} {broad}">95% interval</th>
								</tr>
							</thead>
							<tbody>
								{#each level.evaluation.results as row (`${row.opponent}-${row.stack_bb}`)}
									<tr>
										<th scope="row" class="{cell} font-[400]">
											{opponentName(row)}
											<span class="block text-haze">{row.stack_bb} bb</span>
										</th>
										<td class={wide}>{row.hands.toLocaleString('en-US')}</td>
										<td class={number}>{winRate(row.bb_per_100)}</td>
										<td class={interval}>{winRate(row.ci95[0])} to {winRate(row.ci95[1])}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="mt-3 text-s text-haze">
						{level.evaluation.deals.toLocaleString('en-US')} deals a matchup, each played from {champion.seats ===
						2
							? 'both seats'
							: `all ${champion.seats} seats against ${champion.seats - 1} copies of its opponent`}
						({(champion.seats * level.evaluation.deals).toLocaleString('en-US')} hands), seed {level
							.evaluation.seed}.
						<a
							class="text-gold-light"
							href="{REPOSITORY}/{level.evaluation.report}.md"
							rel="noreferrer external"
						>
							The full report
						</a>
						has every input. What the numbers above say and do not say about Hard holds for Medium too.
					</p>
				</section>
			{/if}
		{:else}
			<section aria-labelledby="hard-none">
				<h3 id="hard-none" class={heading}>Trained bots</h3>
				<p>No trained bot has passed the promotion gate yet.</p>
			</section>
		{/each}
	</article>
</main>
