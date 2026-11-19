<script lang="ts">
	import { onMount } from 'svelte';
	import PlayingCard from '../components/PlayingCard.svelte';
	import type { ConfigResponse, NewTableRequest } from '../protocol-v2.ts';
	import { fetchConfig } from './api.ts';
	import { avatarClass } from './faces.ts';

	let {
		message = '',
		balance = null,
		onstart
	}: {
		message?: string;
		/** Play chips in the wallet, once known. */
		balance?: number | null;
		onstart: (request: NewTableRequest) => Promise<void>;
	} = $props();

	let config = $state<ConfigResponse | null>(null);
	let seats = $state(6);
	let bots = $state('heuristic');
	let bigBlind = $state(100);
	// Buy-ins run from 40 to 100 big blinds, the server's default range.
	const BUY_INS = [40, 70, 100];
	let buyInBlinds = $state(100);
	const affordable = $derived(
		BUY_INS.filter((blinds) => balance === null || blinds * bigBlind <= balance)
	);
	// Keep the choice within the wallet: the largest buy-in it covers.
	$effect(() => {
		if (affordable.length && !affordable.includes(buyInBlinds)) buyInBlinds = affordable.at(-1)!;
	});
	let starting = $state(false);
	let error = $state('');

	const BOT_NOTES: Record<string, string> = {
		heuristic: 'Plays its cards with a plan.',
		calling_station: 'Calls almost anything.',
		random: 'Does whatever it likes.'
	};

	onMount(() => {
		fetchConfig()
			.then((value) => {
				config = value;
				if (!value.bots.some((b) => b.kind === bots)) bots = value.bots[0]?.kind ?? bots;
			})
			.catch((e: unknown) => {
				error = `Could not reach the table server: ${e instanceof Error ? e.message : String(e)}`;
			});
	});

	async function start(event: SubmitEvent) {
		event.preventDefault();
		starting = true;
		error = '';
		try {
			await onstart({ seats, bots, big_blind: bigBlind, buy_in: buyInBlinds * bigBlind });
		} catch (e) {
			error = `Could not start a table: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			starting = false;
		}
	}
</script>

<div class="lobby">
	<section class="hero" aria-labelledby="game-title">
		<div class="fan" aria-hidden="true">
			<PlayingCard card={{ rank: 14, suit: 'spades' }} />
			<PlayingCard card={{ rank: 13, suit: 'hearts' }} />
			<PlayingCard card={null} />
		</div>
		<h2 id="game-title">No-limit hold’em</h2>
		<p class="intro">
			Play money only: chips can never be bought, sold or cashed out, and have no value. Every bot
			is labelled as a bot.
		</p>
		{#if balance !== null}
			<p class="wallet px-inset" role="status" aria-live="polite">
				<span class="label">Your play chips</span>
				<span class="amount">
					<span class="sprite chip chip-gold" aria-hidden="true"></span>
					<strong>{balance.toLocaleString('en-US')}</strong>
				</span>
				<span class="hint">
					New players start with 20,000; below 10,000, a visit tops you up once a day.
				</span>
			</p>
		{/if}
		{#if message}<p class="closed px-panel" role="status">{message}</p>{/if}
	</section>

	<section class="setup px-panel" aria-label="New table">
		<form onsubmit={start}>
			<fieldset>
				<legend>Seats</legend>
				<div class="choices seats">
					{#each config?.seat_counts ?? [2, 3, 4, 5, 6, 7, 8, 9] as count (count)}
						<label class="pick">
							<input type="radio" name="seats" value={count} bind:group={seats} />
							<span class="px-btn">{count}</span>
						</label>
					{/each}
				</div>
			</fieldset>
			<fieldset>
				<legend>Opponents</legend>
				<div class="choices bots">
					{#each config?.bots ?? [] as bot (bot.kind)}
						<label class="pick bot">
							<input type="radio" name="bots" value={bot.kind} bind:group={bots} />
							<span class="px-btn">
								<span
									class="sprite avatar {avatarClass({ kind: 'bot', bot: bot.kind, name: '' })}"
									aria-hidden="true"
								></span>
								<span class="text">
									<span class="name">{bot.label}</span>
									{#if BOT_NOTES[bot.kind]}<span class="note">{BOT_NOTES[bot.kind]}</span>{/if}
								</span>
							</span>
						</label>
					{/each}
				</div>
			</fieldset>
			<div class="stakes">
				<label>
					<span class="field-label">Blinds</span>
					<select class="px-field" bind:value={bigBlind}>
						{#each config?.stakes ?? [] as stakes (stakes.big_blind)}
							<option value={stakes.big_blind}>{stakes.small_blind}/{stakes.big_blind}</option>
						{/each}
					</select>
				</label>
				<label>
					<span class="field-label">Buy-in</span>
					<select class="px-field" bind:value={buyInBlinds}>
						{#each BUY_INS as blinds (blinds)}
							<option value={blinds} disabled={!affordable.includes(blinds)}>
								{blinds * bigBlind} ({blinds} big blinds)
							</option>
						{/each}
					</select>
				</label>
			</div>
			{#if !affordable.length}
				<p class="short" role="status">
					Not enough play chips for these blinds. Pick lower blinds, or come back tomorrow for a
					top-up.
				</p>
			{/if}
			<button
				type="submit"
				class="px-btn amber start"
				disabled={starting || !config || !affordable.length}
			>
				{starting ? 'Dealing…' : 'Sit down'}
			</button>
		</form>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
	</section>
</div>

<style>
	.lobby {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
		gap: 32px;
		align-items: start;
		margin-top: 4vh;
	}
	.hero {
		display: grid;
		gap: 16px;
		align-content: start;
	}
	.fan {
		--k: 3;
		display: flex;
		padding: 8px 0 4px 12px;
	}
	.fan :global(.card) {
		transform-origin: bottom center;
	}
	.fan :global(.card:nth-child(1)) {
		transform: rotate(-8deg);
	}
	.fan :global(.card:nth-child(2)) {
		margin-left: -40px;
		transform: translateY(-10px);
		z-index: 1;
	}
	.fan :global(.card:nth-child(3)) {
		margin-left: -40px;
		transform: rotate(8deg);
	}
	h2 {
		font-size: var(--fs-xl);
		color: var(--gold);
		text-shadow:
			0 var(--px) 0 var(--amber-deep),
			0 calc(2 * var(--px)) 0 var(--ink);
	}
	.intro,
	.closed,
	.short {
		color: var(--mist);
	}
	.closed {
		padding: 6px 10px;
	}
	.wallet {
		display: grid;
		gap: 2px;
		padding: 8px 12px;
	}
	.wallet .label {
		color: var(--mist);
	}
	.wallet .amount {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: var(--fs-l);
		color: var(--gold);
		text-shadow: var(--shadow-text);
	}
	.wallet strong {
		font-weight: normal;
	}
	.wallet .hint {
		color: var(--haze);
		font-size: var(--fs-s);
	}

	.setup {
		padding: 12px 14px 14px;
	}
	form {
		display: grid;
		gap: 18px;
	}
	fieldset {
		border: none;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	legend,
	.field-label {
		display: block;
		margin-bottom: 8px;
		color: var(--gold);
		text-shadow: var(--shadow-text);
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.seats {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
	}
	.pick {
		position: relative;
		display: block;
	}
	.pick input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}
	.pick .px-btn {
		width: 100%;
		cursor: pointer;
	}
	.pick input:checked + .px-btn {
		--btn-up: url('../art/ui/button-gold.png');
		color: var(--ink);
		text-shadow: 0 var(--px) 0 var(--gold-light);
	}
	.pick input:focus-visible + .px-btn {
		outline: var(--px) solid var(--gold-light);
		outline-offset: var(--px);
	}
	.bots {
		display: grid;
		gap: 8px;
	}
	.bot .px-btn {
		justify-content: flex-start;
		gap: 12px;
		padding: 6px 8px;
		white-space: normal;
		text-align: left;
	}
	.bot .text {
		display: grid;
		gap: 2px;
	}
	.bot .note {
		font-size: var(--fs-s);
		color: var(--mist);
		text-shadow: none;
	}
	.bot input:checked + .px-btn .note {
		color: var(--amber-deep);
	}
	.stakes {
		display: grid;
		grid-template-columns: 1fr 1.6fr;
		gap: 12px;
	}
	.stakes select {
		width: 100%;
	}
	.start {
		min-height: 64px;
		font-size: var(--fs-l);
	}
	.error {
		color: var(--danger);
		margin-top: 10px;
	}

	@media (max-width: 799px) {
		.lobby {
			grid-template-columns: minmax(0, 1fr);
			gap: 16px;
			margin-top: 8px;
		}
		.fan {
			--k: 2;
			justify-content: center;
			padding-left: 0;
		}
		.fan :global(.card:nth-child(n + 2)) {
			margin-left: -28px;
		}
		h2 {
			font-size: var(--fs-l);
			text-align: center;
		}
		.intro {
			text-align: center;
			font-size: var(--fs-s);
		}
	}
	@media (max-width: 459px) {
		.seats {
			grid-template-columns: repeat(4, 1fr);
		}
		.stakes {
			grid-template-columns: 1fr;
		}
	}
</style>
