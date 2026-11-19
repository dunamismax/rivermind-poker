<script lang="ts">
	import type { ActionKind, HandInfo, Legal } from '../protocol-v2.ts';
	import { callLabel, clampAmount, presets, raiseLabel } from './bet.ts';

	let {
		legal,
		hand,
		turnSeq,
		disabled,
		onact
	}: {
		legal: Legal;
		hand: HandInfo;
		/** Identifies the turn, so the amount resets for each new one. */
		turnSeq: number;
		disabled: boolean;
		onact: (action: ActionKind, amount?: number) => void;
	} = $props();

	let amount = $state(0);
	let lastTurn = -1;
	$effect.pre(() => {
		if (turnSeq !== lastTurn) {
			lastTurn = turnSeq;
			amount = legal.min_to;
		}
	});

	const sizes = $derived(presets(legal, hand));
	const target = $derived(clampAmount(amount, legal));
	const canRaise = $derived(legal.raise_kind !== null && legal.max_to >= legal.min_to);
</script>

<div class="panel" role="group" aria-label="Your action">
	<div class="main">
		{#if legal.can_fold}
			<button type="button" class="fold" {disabled} onclick={() => onact('fold')}>Fold</button>
		{/if}
		<button
			type="button"
			class="call"
			{disabled}
			onclick={() => onact(legal.can_check ? 'check' : 'call')}
		>
			{callLabel(legal)}
		</button>
		{#if canRaise}
			<button
				type="button"
				class="raise"
				{disabled}
				onclick={() => onact(legal.raise_kind ?? 'bet', target)}
			>
				{raiseLabel(legal, target)}
			</button>
		{/if}
	</div>
	{#if canRaise && legal.max_to > legal.min_to}
		<div class="sizing">
			<div class="presets">
				{#each sizes as preset (preset.label)}
					<button
						type="button"
						class:chosen={preset.amount === target}
						aria-label={`${preset.label}: ${preset.amount}`}
						{disabled}
						onclick={() => (amount = preset.amount)}
					>
						{preset.label}
					</button>
				{/each}
			</div>
			<div class="slider">
				<input
					type="range"
					min={legal.min_to}
					max={legal.max_to}
					step="1"
					bind:value={amount}
					aria-label={legal.raise_kind === 'bet' ? 'Bet amount' : 'Raise to'}
					{disabled}
				/>
				<input
					type="number"
					min={legal.min_to}
					max={legal.max_to}
					step="1"
					bind:value={amount}
					onblur={() => (amount = target)}
					aria-label={legal.raise_kind === 'bet' ? 'Bet amount in chips' : 'Raise to, in chips'}
					{disabled}
				/>
			</div>
		</div>
	{/if}
</div>

<style>
	.panel {
		display: grid;
		gap: 10px;
		background: var(--panel);
		border-radius: var(--radius);
		padding: 12px;
	}
	.main {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		gap: 8px;
	}
	.main button {
		padding: 12px 8px;
		border-radius: 10px;
		border: none;
		font-weight: 600;
		color: var(--text);
		background: var(--panel-2);
		min-height: 48px;
	}
	.main .raise {
		background: var(--accent);
		color: var(--accent-text);
	}
	.main .fold {
		background: #3a1f1c;
	}
	.sizing {
		display: grid;
		gap: 8px;
	}
	.presets {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 6px;
	}
	.presets button {
		padding: 8px 2px;
		border-radius: 8px;
		border: 1px solid var(--panel-2);
		background: transparent;
		color: var(--text);
		font-size: 0.85rem;
	}
	.presets button.chosen {
		border-color: var(--accent);
		color: var(--accent);
	}
	.slider {
		display: grid;
		grid-template-columns: 1fr 96px;
		gap: 10px;
		align-items: center;
	}
	input[type='range'] {
		width: 100%;
		accent-color: var(--accent);
	}
	input[type='number'] {
		width: 100%;
		padding: 8px;
		border-radius: 8px;
		border: 1px solid var(--panel-2);
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 420px) {
		.presets button {
			font-size: 0.75rem;
		}
		.slider {
			grid-template-columns: 1fr 80px;
		}
	}
</style>
