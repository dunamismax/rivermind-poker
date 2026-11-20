<script lang="ts">
	// Your hands (P4.6): the finished hands this player was dealt into, newest
	// first, each with every card they may see: their own, the board and the
	// hands shown at showdown. Folded and mucked hands never reach the page.
	// `/hands?hand=ID` opens one of the player's hands directly.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import PlayingCard from '#lib/components/PlayingCard.svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import { ApiError, fetchHand, fetchHands, startSession } from '#lib/nl/api.ts';
	import type { HandDetail, HandSummary } from '#lib/protocol-v2.ts';

	let hands = $state<HandSummary[]>([]);
	let more = $state(false);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let open = $state<HandDetail | null>(null);
	let opening = $state<string | null>(null);

	const when = (at: number) =>
		new Date(at * 1000).toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	const signed = (n: number) =>
		n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US');

	async function load(before: string | null = null) {
		loading = true;
		error = null;
		try {
			let page;
			try {
				page = await fetchHands(before);
			} catch (e) {
				if (!(e instanceof ApiError) || e.status !== 401) throw e;
				await startSession();
				page = await fetchHands(before);
			}
			hands = before ? [...hands, ...page.hands] : page.hands;
			more = page.more;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function show(handId: string) {
		opening = handId;
		try {
			open = await fetchHand(handId);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			opening = null;
		}
	}

	function close() {
		open = null;
		replaceState(resolve('/hands'), {});
	}

	onMount(() => {
		const wanted = new URLSearchParams(location.search).get('hand');
		void load().then(() => {
			if (wanted) void show(wanted);
		});
	});
</script>

<svelte:head>
	<title>Your hands · RiverMind Poker</title>
</svelte:head>

<SiteHeader>
	<a class="px-btn small" href={resolve('/')}>Play</a>
</SiteHeader>

<main class="page">
	<section class="px-panel intro">
		<h2>Your hands</h2>
		<p>
			Every hand you were dealt into, newest first. Open one to see your cards, the board, every
			action and the hands shown at showdown. Folded and mucked hands stay hidden.
			<a href={resolve('/fairness')}>How dealing works</a>
		</p>
	</section>

	{#if open}
		<section
			class="px-panel detail"
			aria-label="Hand {open.hand.hand_no} at {open.hand.table_name}"
		>
			<div class="detail-top">
				<h3>{open.hand.table_name} · hand #{open.hand.hand_no}</h3>
				<button type="button" class="px-btn small" onclick={close}>Close</button>
			</div>
			<p class="meta">
				{#if open.hand.practice}Practice chips ·
				{/if}{when(open.hand.at)} · Blinds {open.hand.small_blind}/{open.hand.big_blind} · Pot {open.hand.pot.toLocaleString(
					'en-US'
				)}
			</p>
			<div class="board" aria-label="Board">
				{#each Array.from({ length: 5 }, (_, i) => open!.hand.board[i]) as card, i (i)}
					<PlayingCard {card} />
				{/each}
			</div>
			<ul class="seats">
				{#each open.seats as seat (seat.seat)}
					<li class:you={seat.you}>
						<span class="who">
							{seat.name}{#if seat.kind === 'bot'}<span class="tag">
									Bot
								</span>{/if}{#if seat.you}<span class="tag gold">
									You
								</span>{/if}{#if open.button === seat.seat}<span class="tag">Button</span>{/if}
						</span>
						<span
							class="hole"
							class:card-peek={seat.cards}
							aria-label={seat.cards ? 'Cards' : 'Cards not shown'}
						>
							{#if seat.cards}
								{#each seat.cards as card (`${card.rank}${card.suit}`)}<PlayingCard {card} />{/each}
							{:else}
								<span class="hidden-cards">Not shown</span>
							{/if}
						</span>
						<span class="net" class:won={seat.net > 0} class:lost={seat.net < 0}>
							{signed(seat.net)}
						</span>
					</li>
				{/each}
			</ul>
			<h4>Hand history</h4>
			<pre class="px-inset">{open.text}</pre>
		</section>
	{/if}

	<section class="px-panel list" aria-label="Hands">
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		{#if hands.length === 0 && !loading && !error}
			<p>No hands yet. <a href={resolve('/')}>Sit down at a table</a> and they will appear here.</p>
		{:else}
			<ol>
				{#each hands as hand (hand.hand_id)}
					<li class="row px-inset">
						<button
							type="button"
							class="open"
							aria-current={open?.hand.hand_id === hand.hand_id ? 'true' : undefined}
							disabled={opening !== null}
							onclick={() => show(hand.hand_id)}
						>
							<span class="title">{hand.table_name} · hand #{hand.hand_no}</span>
							<span class="when">
								{#if hand.practice}<span class="tag gold first">Practice</span>{/if}{when(hand.at)}
							</span>
							<span class="cards card-peek" aria-hidden="true">
								{#each hand.cards as card (`${card.rank}${card.suit}`)}<PlayingCard {card} />{/each}
							</span>
							<span class="net" class:won={hand.net > 0} class:lost={hand.net < 0}>
								{signed(hand.net)}
							</span>
						</button>
					</li>
				{/each}
			</ol>
			{#if more}
				<button
					type="button"
					class="px-btn"
					disabled={loading}
					onclick={() => load(hands.at(-1)?.hand_id ?? null)}
				>
					Older hands
				</button>
			{/if}
		{/if}
		{#if loading}<p role="status">Loading hands…</p>{/if}
	</section>
</main>

<style>
	.page {
		max-width: 900px;
		margin: 0 auto;
		padding: 16px;
		display: grid;
		gap: 16px;
		color: var(--mist);
	}
	.px-panel {
		padding: 12px 16px 16px;
	}
	h2,
	h3,
	h4 {
		margin: 0 0 8px;
		font-weight: normal;
		color: var(--gold);
		text-shadow: var(--shadow-text);
	}
	h2 {
		font-size: var(--fs-l);
	}
	h3,
	h4 {
		font-size: var(--fs);
	}
	h4 {
		margin-top: 16px;
		color: var(--gold-light);
	}
	p {
		margin: 0;
		line-height: 1.4;
	}
	a:not(.px-btn) {
		color: var(--gold-light);
	}
	.detail-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}
	.meta,
	.when {
		color: var(--paper-shade);
		font-size: var(--fs-s);
	}
	.board,
	.hole {
		display: flex;
		gap: 4px;
	}
	.board {
		margin: 12px 0;
	}
	/* Whole cards where there is room; phones keep the compact peek. */
	@media (min-width: 600px) {
		.hole {
			--k: 1;
			width: auto;
			height: auto;
			overflow: visible;
		}
		.hole :global(.card + .card) {
			margin-left: -26px;
		}
	}
	@media (max-width: 599px) {
		.board :global(.card + .card) {
			margin-left: -14px;
		}
		.page {
			padding: 8px;
		}
	}
	.seats {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.seats li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto 90px;
		align-items: center;
		gap: 10px;
		padding: 4px 0;
		border-bottom: var(--px) solid var(--deep-slate);
	}
	.seats li.you .who {
		color: var(--gold-light);
	}
	.who {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag {
		margin-left: 6px;
		padding: 0 6px;
		font-size: var(--fs-s);
		color: var(--violet-light);
		background: var(--ink);
	}
	.tag.gold {
		color: var(--ink);
		background: var(--gold);
	}
	.tag.first {
		margin: 0 6px 0 0;
	}
	.hidden-cards {
		font-size: var(--fs-s);
		color: var(--paper-shade);
	}
	.net {
		text-align: right;
		color: var(--paper-shade);
	}
	.net.won {
		color: var(--green-light);
	}
	.net.lost {
		color: var(--red-light);
	}
	pre {
		margin: 0;
		padding: 10px;
		max-height: 420px;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: inherit;
		font-size: var(--fs-s);
		line-height: 1.5;
		color: var(--paper);
	}
	ol {
		list-style: none;
		margin: 0 0 12px;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.open {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto 90px;
		grid-template-areas:
			'title cards net'
			'when cards net';
		align-items: center;
		column-gap: 12px;
		width: 100%;
		padding: 6px 8px;
		border: 0;
		background: none;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}
	.open:hover .title,
	.open:focus-visible .title,
	.open[aria-current='true'] .title {
		color: var(--gold-light);
	}
	.title {
		grid-area: title;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.when {
		grid-area: when;
	}
	.cards {
		grid-area: cards;
	}
	.open .net {
		grid-area: net;
	}
	.error {
		color: var(--red-light);
		margin-bottom: 8px;
	}
</style>
