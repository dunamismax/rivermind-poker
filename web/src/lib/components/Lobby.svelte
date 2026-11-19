<script lang="ts">
	import { onMount } from 'svelte';
	import { createTable, fetchConfig } from '../api.ts';
	import type { NewTableResponse, OpponentKind } from '../protocol.ts';

	let { message = '', onseat }: { message?: string; onseat: (seat: NewTableResponse) => void } =
		$props();

	const DESCRIPTIONS: Record<OpponentKind, [string, string]> = {
		random: ['Random bots', 'Pick any legal action uniformly.'],
		checkpoint: ['RiverMind bots', 'Play the trained checkpoint this server loaded.']
	};

	let opponents = $state<OpponentKind[]>([]);
	let choice = $state<OpponentKind>('random');
	let starting = $state(false);
	let error = $state('');

	onMount(() => {
		fetchConfig()
			.then((config) => {
				opponents = config.opponents.length ? config.opponents : ['random'];
			})
			.catch(() => {
				opponents = ['random']; // the server will say if it cannot seat us
			})
			.finally(() => {
				// The strongest opponents the server offers come last.
				choice = opponents[opponents.length - 1];
			});
	});

	async function start() {
		starting = true;
		error = '';
		try {
			onseat(await createTable(choice));
		} catch (e) {
			error = `Could not start a table: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			starting = false;
		}
	}
</script>

<section class="lobby" aria-labelledby="lobby-title">
	<h2 id="lobby-title" class="visually-hidden">New table</h2>
	<p class="lede">
		Three-seat limit hold’em with a 20-card deck (tens through aces). Play chips only.
	</p>
	<fieldset class="opponents">
		<legend>Opponents</legend>
		{#each opponents as kind (kind)}
			<label>
				<input type="radio" name="opponents" value={kind} bind:group={choice} />
				<span>
					{DESCRIPTIONS[kind][0]}
					<small>{DESCRIPTIONS[kind][1]}</small>
				</span>
			</label>
		{/each}
	</fieldset>
	<button class="primary" type="button" disabled={starting || !opponents.length} onclick={start}>
		Sit down
	</button>
	<p class="message" role="status">{error || message}</p>
</section>

<style>
	.lobby {
		display: grid;
		gap: 16px;
		max-width: 420px;
		margin: 8vh auto 0;
	}
	.lede {
		color: var(--muted);
		margin: 0;
	}
	.opponents {
		border: 1px solid var(--panel-2);
		border-radius: var(--radius);
		padding: 12px 16px;
		display: grid;
		gap: 8px;
		margin: 0;
		min-height: 64px;
	}
	legend {
		padding: 0 6px;
		color: var(--muted);
	}
	label {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 6px 0;
	}
	small {
		display: block;
		color: var(--muted);
	}
	.primary {
		background: var(--accent);
		color: var(--accent-text);
		border: 0;
		border-radius: var(--radius);
		padding: 14px 20px;
		font-weight: 600;
	}
	.message {
		color: var(--danger);
		min-height: 1.4em;
		margin: 0;
	}
</style>
