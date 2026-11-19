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

	// Short faces for the preset buttons; their accessible names stay in full.
	const SHORT: Record<string, string> = { '½ pot': '1/2', '¾ pot': '3/4' };
	const sizes = $derived(presets(legal, hand));
	const target = $derived(clampAmount(amount, legal));
	const canRaise = $derived(legal.raise_kind !== null && legal.max_to >= legal.min_to);
</script>

<div class="panel px-panel" role="group" aria-label="Your action">
	{#if canRaise && legal.max_to > legal.min_to}
		<div class="sizing">
			<div class="presets">
				{#each sizes as preset (preset.label)}
					<button
						type="button"
						class="px-btn small"
						aria-pressed={preset.amount === target}
						aria-label={`${preset.label}: ${preset.amount}`}
						{disabled}
						onclick={() => (amount = preset.amount)}
					>
						{SHORT[preset.label] ?? preset.label}
					</button>
				{/each}
			</div>
			<div class="slider">
				<input
					class="px-range"
					type="range"
					min={legal.min_to}
					max={legal.max_to}
					step="1"
					bind:value={amount}
					aria-label={legal.raise_kind === 'bet' ? 'Bet amount' : 'Raise to'}
					{disabled}
				/>
				<input
					class="px-field amount"
					type="number"
					inputmode="numeric"
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
	<div class="main">
		{#if legal.can_fold}
			<button type="button" class="px-btn red" {disabled} onclick={() => onact('fold')}>
				Fold
			</button>
		{/if}
		<button
			type="button"
			class="px-btn blue"
			{disabled}
			onclick={() => onact(legal.can_check ? 'check' : 'call')}
		>
			{callLabel(legal)}
		</button>
		{#if canRaise}
			<button
				type="button"
				class="px-btn amber"
				{disabled}
				onclick={() => onact(legal.raise_kind ?? 'bet', target)}
			>
				{raiseLabel(legal, target)}
			</button>
		{/if}
	</div>
</div>

<style>
	.panel {
		display: grid;
		gap: 8px;
		padding: 4px;
		animation: slide 0.18s steps(3, end);
	}
	.main {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		gap: 8px;
	}
	.main .px-btn {
		min-height: 60px;
		padding: 0 4px;
		white-space: normal;
		text-align: center;
		line-height: 1.1;
	}
	.sizing {
		display: grid;
		gap: 4px;
	}
	.presets {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 6px;
	}
	.presets .px-btn {
		padding: 0;
		font-size: var(--fs-s);
	}
	.presets .px-btn[aria-pressed='true'] {
		--btn-down: url('../art/ui/button-gold-down.png');
		color: var(--ink);
		text-shadow: none;
	}
	.slider {
		display: grid;
		grid-template-columns: 1fr 104px;
		gap: 12px;
		align-items: center;
	}
	.amount {
		width: 100%;
		text-align: right;
	}
	@keyframes slide {
		from {
			transform: translateY(8px);
			opacity: 0;
		}
	}
	@media (max-width: 639px) {
		.main .px-btn {
			min-height: 56px;
			font-size: var(--fs-s);
		}
		.slider {
			grid-template-columns: 1fr 96px;
			gap: 8px;
		}
		.presets {
			gap: 4px;
		}
	}
</style>
