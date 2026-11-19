<script lang="ts">
	import { onMount } from 'svelte';
	import type { ConfigResponse, NewTableRequest } from '../protocol-v2.ts';
	import { fetchConfig } from './api.ts';

	let {
		message = '',
		onstart
	}: { message?: string; onstart: (request: NewTableRequest) => Promise<void> } = $props();

	let config = $state<ConfigResponse | null>(null);
	let seats = $state(6);
	let bots = $state('heuristic');
	let bigBlind = $state(100);
	// Buy-ins run from 40 to 100 big blinds, the server's default range.
	const BUY_INS = [40, 70, 100];
	let buyInBlinds = $state(100);
	let starting = $state(false);
	let error = $state('');

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

<section class="lobby" aria-label="New table">
	<h2>No-limit hold’em</h2>
	<p class="intro">
		Play money only: chips can never be bought, sold or cashed out. Every bot is labelled as a bot.
	</p>
	{#if message}<p class="closed" role="status">{message}</p>{/if}
	<form onsubmit={start}>
		<fieldset>
			<legend>Seats</legend>
			<div class="choices seats">
				{#each config?.seat_counts ?? [2, 3, 4, 5, 6, 7, 8, 9] as count (count)}
					<label class="chip">
						<input type="radio" name="seats" value={count} bind:group={seats} />
						<span>{count}</span>
					</label>
				{/each}
			</div>
		</fieldset>
		<fieldset>
			<legend>Opponents</legend>
			<div class="choices">
				{#each config?.bots ?? [] as bot (bot.kind)}
					<label class="chip">
						<input type="radio" name="bots" value={bot.kind} bind:group={bots} />
						<span>{bot.label}</span>
					</label>
				{/each}
			</div>
		</fieldset>
		<label class="stakes">
			Blinds
			<select bind:value={bigBlind}>
				{#each config?.stakes ?? [] as stakes (stakes.big_blind)}
					<option value={stakes.big_blind}>{stakes.small_blind}/{stakes.big_blind}</option>
				{/each}
			</select>
		</label>
		<label class="stakes">
			Buy-in
			<select bind:value={buyInBlinds}>
				{#each BUY_INS as blinds (blinds)}
					<option value={blinds}>{blinds * bigBlind} ({blinds} big blinds)</option>
				{/each}
			</select>
		</label>
		<button type="submit" class="start" disabled={starting || !config}>
			{starting ? 'Starting…' : 'Sit down'}
		</button>
	</form>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
	.lobby {
		max-width: 520px;
		margin: 4vh auto 0;
		display: grid;
		gap: 12px;
	}
	h2 {
		margin: 0;
	}
	.intro,
	.closed {
		color: var(--muted);
		margin: 0;
	}
	form {
		display: grid;
		gap: 14px;
	}
	fieldset {
		border: none;
		margin: 0;
		padding: 0;
	}
	legend {
		margin-bottom: 6px;
		font-weight: 600;
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.chip input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}
	.chip span {
		display: inline-block;
		padding: 8px 14px;
		border-radius: 999px;
		border: 1px solid var(--panel-2);
		background: var(--panel);
		cursor: pointer;
		min-width: 44px;
		text-align: center;
	}
	.chip input:checked + span {
		border-color: var(--accent);
		color: var(--accent);
	}
	.chip input:focus-visible + span {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.stakes {
		display: flex;
		gap: 10px;
		align-items: center;
		font-weight: 600;
	}
	select {
		font: inherit;
		padding: 6px 8px;
		border-radius: 8px;
		background: var(--panel);
		color: var(--text);
		border: 1px solid var(--panel-2);
	}
	.start {
		padding: 12px;
		border-radius: var(--radius);
		border: none;
		background: var(--accent);
		color: var(--accent-text);
		font-weight: 700;
	}
	.error {
		color: var(--danger);
		margin: 0;
	}
</style>
