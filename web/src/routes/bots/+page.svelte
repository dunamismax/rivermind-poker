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
	const champions = registry.champions;
	const opponentName = (row: { opponent: string; name: string | null }) =>
		row.opponent === 'champion'
			? `The champion before it${row.name ? ` (${row.name})` : ''}`
			: (OPPONENTS[row.opponent] ?? row.opponent);

	const heading = 'mt-10 mb-3 text-m text-gold-light';
	const list = 'list-disc pl-10 [&>li+li]:mt-3';
	const cell = 'px-3 py-2 text-left align-top lt-460:px-2';
	const number = 'px-3 py-2 text-right align-top whitespace-nowrap lt-460:px-2';
	// A phone has no room for the hands column: every matchup has as many, and the note says how many.
	const wide = `${number} lt-460:hidden`;
	// On a phone the interval breaks after “to”.
	const interval =
		'px-3 py-2 text-right align-top whitespace-nowrap lt-460:px-2 lt-460:whitespace-normal';
</script>

<svelte:head>
	<title>The bots · RiverMind Poker</title>
	<meta
		name="description"
		content="The bots at RiverMind Poker’s tables, and the published evaluation behind RiverMind Hard, the trained heads-up bot."
	/>
</svelte:head>

<SiteHeader>
	<a class="px-btn small" href={resolve('/')}>Play</a>
</SiteHeader>

<main class="page mx-auto max-w-[860px] p-8">
	<article class="px-panel px-10 pt-8 pb-10 text-mist">
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
				<p>
					RiverMind Hard is a trained bot. It learned {champion.format} no-limit hold’em by playing against
					itself for {champion.iterations.toLocaleString('en-US')} training iterations, and it plays tables
					of {champion.seats} seats only. The model it plays is
					<code class="text-green-light">{champion.name}</code>, promoted on {champion.promoted}.
				</p>
				<p class="mt-5">
					It was measured in duplicate matches. Each deal is played twice with the seats swapped, so
					both sides hold the same cards once and luck largely cancels. Results are big blinds won
					per 100 hands at blinds of 50 and 100, with a 95% interval: if the interval’s lower end is
					above zero, the win is unlikely to be chance.
				</p>
				{#each champion.evaluations as evaluation (evaluation.report)}
					<h4 class="mt-8 mb-3 text-paper">
						{evaluation.candidate === 'bundle'
							? 'The strategy this site serves'
							: 'The trained checkpoint, before rounding'}
					</h4>
					<div class="overflow-x-auto">
						<table class="px-inset w-full border-collapse text-s">
							<caption class="sr-only">
								Results of {champion.name}, {evaluation.candidate === 'bundle'
									? 'as served'
									: 'as trained'}
							</caption>
							<thead class="text-gold-light">
								<tr>
									<th scope="col" class={cell}>Against, and stacks</th>
									<th scope="col" class={wide}>Hands</th>
									<th scope="col" class={number}>Won per 100</th>
									<th scope="col" class={interval}>95% interval</th>
								</tr>
							</thead>
							<tbody>
								{#each evaluation.results as row (`${row.opponent}-${row.stack_bb}`)}
									<tr class={row.gate ? 'text-paper' : ''}>
										<th scope="row" class="{cell} font-normal">
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
						matchup, each played from both seats ({(2 * evaluation.deals).toLocaleString('en-US')} hands),
						seed {evaluation.seed}.
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
					at your table is the one measured above. Its strategy file’s SHA-256 is
					<code class="text-s break-all text-green-light">
						{champion.bundle.files['strategy.u8']}
					</code>
					and its card tables’ is
					<code class="text-s break-all text-green-light">{champion.bundle.table_set}</code>.
					<a class="text-gold-light" href="{REPOSITORY}/models.md" rel="noreferrer external">
						The model registry
					</a>
					lists every model put to the gate, including those that did not pass.
				</p>
			</section>
		{:else}
			<section aria-labelledby="hard-none">
				<h3 id="hard-none" class={heading}>Trained bots</h3>
				<p>No trained bot has passed the promotion gate yet.</p>
			</section>
		{/each}
	</article>
</main>
