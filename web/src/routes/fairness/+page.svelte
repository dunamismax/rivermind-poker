<script lang="ts">
	// Rules and fairness (P4.6): how the cards are dealt and kept private, and
	// the table rules where card rooms differ. docs/rules.md is the full text.
	import { resolve } from '$app/paths';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import { BOT_RULES, CONDUCT, TABLE_RULES } from '#lib/nl/content.ts';

	const heading = 'mt-10 mb-3 text-m text-gold-light';
	const list = 'list-disc pl-10 [&>li+li]:mt-3';
</script>

<svelte:head>
	<title>Rules and fair dealing · RiverMind Poker</title>
	<meta
		name="description"
		content="How RiverMind Poker shuffles and deals, keeps every hand private, and runs its no-limit hold’em tables."
	/>
</svelte:head>

<SiteHeader>
	<a class="ui-btn small" href={resolve('/')}>Play</a>
</SiteHeader>

<main class="page mx-auto max-w-[860px] p-8">
	<article class="ui-panel px-10 pt-8 pb-10 text-mist">
		<h2 class="mb-5 text-l text-gold text-shadow-ink">Rules and fair dealing</h2>
		<p class="lead text-paper">
			RiverMind Poker deals no-limit Texas hold’em for play chips only: chips can never be bought,
			sold or cashed out, and have no value. This page explains how every hand is dealt and how the
			tables run.
		</p>

		<section aria-labelledby="dealing">
			<h3 id="dealing" class={heading}>How the cards are dealt</h3>
			<ul class={list}>
				<li>
					Every hand uses a full 52-card deck, shuffled from scratch on the server before the hand.
					The shuffle draws on the operating system’s cryptographic random number generator (Node’s
					<code class="text-green-light">crypto.randomInt</code>), the same source used for
					passwords and keys, so no one can predict or influence the order of the cards.
				</li>
				<li>
					Cards come off the top of the deck in order, as a dealer deals them: two hole cards to
					each player, starting left of the button, and a burn card before the flop, the turn and
					the river.
				</li>
				<li>
					The server deals and keeps the deck. Your browser is sent your own cards and the board,
					never anyone else’s hole cards or the cards still in the deck. Cards are revealed only
					when a hand is shown at showdown.
				</li>
				<li>
					Hands that are folded or mucked stay hidden from everyone, including in hand histories.
				</li>
			</ul>
		</section>

		<section aria-labelledby="bots">
			<h3 id="bots" class={heading}>Bots play by the same rules</h3>
			<ul class={list}>
				{#each BOT_RULES as rule (rule)}<li>{rule}</li>{/each}
			</ul>
		</section>

		<section aria-labelledby="history">
			<h3 id="history" class={heading}>Check any hand you played</h3>
			<p>
				Every finished hand is stored. <a class="text-gold-light" href={resolve('/hands')}>
					Your hands
				</a> lists the hands you were dealt into, with your cards, the board, every action and every hand
				shown at showdown, so you can check how each one played out.
			</p>
		</section>

		<section aria-labelledby="table-rules">
			<h3 id="table-rules" class={heading}>Table rules</h3>
			<dl class="my-10 [&>dd]:mt-1 [&>dd]:ml-10 [&>dt]:mt-5 [&>dt]:text-paper">
				{#each TABLE_RULES as rule (rule.term)}<dt>{rule.term}</dt>
					<dd>{rule.text}</dd>{/each}
			</dl>
		</section>

		<section aria-labelledby="voice-code">
			<h3 id="voice-code" class={heading}>Check the code that encrypts voice</h3>
			<p>
				Table voice is encrypted in your browser, by code this site sends it, so the encryption is
				only as trustworthy as that code. The source is public, and each release publishes
				<a class="text-gold-light" href="/voice-files.json" rel="external">
					the hash of every file
				</a> its pages run, voice’s own first. Anyone can build the same version from the source and compare.
			</p>
		</section>

		<section aria-labelledby="conduct">
			<h3 id="conduct" class={heading}>Playing fair</h3>
			<p>{CONDUCT}</p>
		</section>
	</article>
</main>
