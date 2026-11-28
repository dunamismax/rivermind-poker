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
	/** The size last picked by its button, for as long as the amount is still that size. */
	let picked = $state<string | null>(null);
	let lastTurn = -1;
	$effect.pre(() => {
		if (turnSeq !== lastTurn) {
			lastTurn = turnSeq;
			amount = legal.min_to;
			picked = null;
		}
	});

	// Short faces for the preset buttons; their accessible names stay in full.
	const SHORT: Record<string, string> = { '½ pot': '1/2', '¾ pot': '3/4' };
	const sizes = $derived(presets(legal, hand));
	const target = $derived(clampAmount(amount, legal));
	const canRaise = $derived(legal.raise_kind !== null && legal.max_to >= legal.min_to);
	// One size is lit at a time. Two can come to the same amount (the minimum raise is
	// often half the pot): the one picked is lit then, or else the first of them.
	const lit = $derived(
		(
			sizes.find((size) => size.label === picked && size.amount === target) ??
			sizes.find((size) => size.amount === target)
		)?.label ?? null
	);

	// The three main buttons: tall, with room for a label on two lines.
	const main =
		'min-h-30 px-2 text-center leading-[1.1] whitespace-normal lt-640:min-h-28 lt-640:text-s';
</script>

<div class="panel ui-panel grid animate-slide gap-4 p-2" role="group" aria-label="Your action">
	{#if canRaise && legal.max_to > legal.min_to}
		<div class="sizing grid gap-2">
			<div class="presets grid grid-cols-[repeat(5,1fr)] gap-3 lt-640:gap-2">
				{#each sizes as preset (preset.label)}
					<button
						type="button"
						class="ui-btn small choice p-0"
						aria-pressed={preset.label === lit}
						aria-label={`${preset.label}: ${preset.amount}`}
						{disabled}
						onclick={() => {
							amount = preset.amount;
							picked = preset.label;
						}}
					>
						{SHORT[preset.label] ?? preset.label}
					</button>
				{/each}
			</div>
			<div
				class="slider grid grid-cols-[1fr_104px] items-center gap-6 lt-640:grid-cols-[1fr_96px] lt-640:gap-4"
			>
				<input
					class="ui-range"
					type="range"
					min={legal.min_to}
					max={legal.max_to}
					step="1"
					bind:value={amount}
					aria-label={legal.raise_kind === 'bet' ? 'Bet amount' : 'Raise to'}
					{disabled}
				/>
				<input
					class="ui-field amount w-full text-right"
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
	<div class="main grid auto-cols-[1fr] grid-flow-col gap-4">
		{#if legal.can_fold}
			<button type="button" class="ui-btn red {main}" {disabled} onclick={() => onact('fold')}>
				Fold
			</button>
		{/if}
		<button
			type="button"
			class="ui-btn blue {main}"
			{disabled}
			onclick={() => onact(legal.can_check ? 'check' : 'call')}
		>
			{callLabel(legal)}
		</button>
		{#if canRaise}
			<button
				type="button"
				class="ui-btn amber {main}"
				{disabled}
				onclick={() => onact(legal.raise_kind ?? 'bet', target)}
			>
				{raiseLabel(legal, target)}
			</button>
		{/if}
	</div>
</div>
