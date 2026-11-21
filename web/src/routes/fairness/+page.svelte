<script lang="ts">
	// Rules and fairness (P4.6): how the cards are dealt and kept private, and
	// the table rules where card rooms differ. docs/rules.md is the full text.
	import { resolve } from '$app/paths';
	import SiteHeader from '#lib/components/SiteHeader.svelte';

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
	<a class="px-btn small" href={resolve('/')}>Play</a>
</SiteHeader>

<main class="page mx-auto max-w-[860px] p-8">
	<article class="px-panel px-10 pt-8 pb-10 text-mist">
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
				<li>
					Bots are always labelled. They decide from the same view a person in their seat would
					have: their own cards and what happened at the table. They never see other hole cards or
					the deck.
				</li>
				<li>
					Bots keep seats warm: when a person wants a seat at a table of bots, a bot finishes its
					hand and gives the seat up.
				</li>
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
				<dt>Blinds and the button</dt>
				<dd>
					The two players left of the button post the small and big blinds. Heads-up, the button
					posts the small blind and acts first before the flop. The button moves one seat after
					every hand.
				</dd>
				<dt>Joining</dt>
				<dd>
					A player who sits down is dealt in from the next hand, with no missed-blind charges. A
					seat can be held for a player for 60 seconds while they buy in.
				</dd>
				<dt>Betting</dt>
				<dd>
					No-limit: a bet or raise can be any amount from the minimum up to all your chips. A raise
					must be at least as large as the last full bet or raise. An all-in for less than a full
					raise does not reopen the betting for players who have already acted.
				</dd>
				<dt>Pots</dt>
				<dd>
					An uncalled bet is returned. When players are all-in for different amounts, side pots are
					formed, and each pot goes to the best hand among the players in it. Split pots are shared
					equally; an odd chip goes to the first winner left of the button.
				</dd>
				<dt>Showdown</dt>
				<dd>
					Hands are shown in order, and a hand that cannot win or tie is mucked unseen. When players
					are all-in with no more betting possible, their hands are shown at once.
				</dd>
				<dt>The clock</dt>
				<dd>
					Each turn has 20 seconds, then a 30-second time bank that grows back by 2 seconds a hand.
					When both run out you check if you can, and fold otherwise. A player who is away for a
					full orbit is sat out.
				</dd>
			</dl>
		</section>

		<section aria-labelledby="conduct">
			<h3 id="conduct" class={heading}>Playing fair</h3>
			<p>
				There is no chat: players can send a few preset reactions. Select a player’s name at the
				table to mute, block or report them. Reports, and signs of players working together such as
				two people at one table from the same network, are kept for review.
			</p>
		</section>
	</article>
</main>
