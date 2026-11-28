<script lang="ts">
	// Your hands (P4.6): the finished hands this player was dealt into, newest
	// first, each with every card they may see: their own, the board and the
	// hands shown at showdown. Folded and mucked hands never reach the page.
	// An open hand can be stepped through from the blinds to the result (P6.1).
	// `/hands?hand=ID` opens one of the player's hands directly.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import PlayingCard from '#lib/components/PlayingCard.svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import { ApiError, fetchHand, fetchHands, startSession } from '#lib/nl/api.ts';
	import HandReplay from '#lib/nl/HandReplay.svelte';
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

	const panel = 'px-8 pt-6 pb-8';
	/** A result's colour: won, lost or even. */
	const tone = (net: number) =>
		net > 0 ? 'won text-green-light' : net < 0 ? 'lost text-red-light' : 'text-paper-shade';

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
	<a class="ui-btn small" href={resolve('/')}>Play</a>
</SiteHeader>

<main class="page mx-auto grid max-w-[900px] gap-8 p-8 text-mist lt-600:p-4">
	<section class="ui-panel intro {panel}">
		<h2 class="mb-4 text-l text-gold text-shadow-ink">Your hands</h2>
		<p>
			Every hand you were dealt into, newest first. Open one to step through it: your cards, the
			board, every action and the hands shown at showdown. Folded and mucked hands stay hidden.
			<a class="text-gold-light" href={resolve('/fairness')}>How dealing works</a>
		</p>
	</section>

	{#if open}
		<section
			class="ui-panel detail {panel}"
			aria-label="Hand {open.hand.hand_no} at {open.hand.table_name}"
		>
			<div class="detail-top mb-3 flex items-center justify-between gap-6">
				<h3 class="text-m text-gold text-shadow-ink">
					{open.hand.table_name} · hand #{open.hand.hand_no}
				</h3>
				<button type="button" class="ui-btn small" onclick={close}>Close</button>
			</div>
			<p class="meta text-s text-paper-shade">
				{open.hand.practice ? 'Practice chips · ' : ''}{when(open.hand.at)} · Blinds {open.hand
					.small_blind}/{open.hand.big_blind} · Pot {open.hand.pot.toLocaleString('en-US')}
			</p>
			<div class="my-6">
				<HandReplay detail={open} roomy />
			</div>
			<h4 class="mt-8 mb-4 text-m text-gold-light text-shadow-ink">Hand history</h4>
			<pre
				class="ui-inset max-h-[420px] overflow-auto p-5 text-s leading-[1.5] wrap-anywhere whitespace-pre-wrap text-paper">{open.text}</pre>
		</section>
	{/if}

	<section class="ui-panel list {panel}" aria-label="Hands">
		{#if error}<p class="error mb-4 text-red-light" role="alert">{error}</p>{/if}
		{#if hands.length === 0 && !loading && !error}
			<p>
				No hands yet. <a class="text-gold-light" href={resolve('/')}>Sit down at a table</a> and they
				will appear here.
			</p>
		{:else}
			<ol class="mb-6 grid gap-3">
				{#each hands as hand (hand.hand_id)}
					<li class="row ui-inset">
						<button
							type="button"
							class="open group grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto_90px] items-center gap-x-6 px-4 py-3 text-left lt-460:grid-cols-[minmax(0,1fr)_auto_64px] lt-460:gap-x-3"
							aria-current={open?.hand.hand_id === hand.hand_id ? 'true' : undefined}
							disabled={opening !== null}
							onclick={() => show(hand.hand_id)}
						>
							<span
								class="title col-1 row-1 truncate group-hover:text-gold-light lt-460:line-clamp-2 lt-460:whitespace-normal group-focus-visible:text-gold-light group-aria-[current=true]:text-gold-light"
							>
								{hand.table_name} · hand #{hand.hand_no}
							</span>
							<!-- The tag and the time each stay whole: on a phone the time goes under the tag. -->
							<span
								class="when col-1 row-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-s text-paper-shade"
							>
								{#if hand.practice}<span class="tag gold first bg-gold px-3 text-s text-ink">
										Practice
									</span>{/if}<span class="whitespace-nowrap">{when(hand.at)}</span>
							</span>
							<span class="cards card-peek col-2 row-[1/3]" aria-hidden="true">
								{#each hand.cards as card (`${card.rank}${card.suit}`)}<PlayingCard {card} />{/each}
							</span>
							<span class="net col-3 row-[1/3] text-right {tone(hand.net)}">
								{signed(hand.net)}
							</span>
						</button>
					</li>
				{/each}
			</ol>
			{#if more}
				<button
					type="button"
					class="ui-btn"
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
