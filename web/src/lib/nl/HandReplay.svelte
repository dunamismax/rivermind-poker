<script lang="ts">
	// A finished hand to step through (P6.1): the blinds, each action, each street,
	// the showdown and the result, with the board, the pot, every seat's cards and
	// bets as they stood, and why each pot went where it did. It opens on the
	// result, so the hand reads as it ended; Back and the left arrow walk it
	// backwards. `replay.ts` builds the steps from the hand the viewer was sent,
	// which holds only the cards they may see.
	import PlayingCard from '../components/PlayingCard.svelte';
	import type { HandDetail } from '../protocol-v2.ts';
	import { buildReplay, stageOf, stepForKey } from './replay.ts';

	let {
		detail,
		roomy = false
	}: {
		detail: HandDetail;
		/** On a page of its own: whole cards and larger text where the screen has room. */
		roomy?: boolean;
	} = $props();

	const steps = $derived(buildReplay(detail));
	/** The step chosen, for the hand it was chosen in; another hand opens on its result. */
	let chosen = $state<{ hand: string; index: number } | null>(null);
	const index = $derived(
		chosen?.hand === detail.hand.hand_id
			? Math.min(chosen.index, steps.length - 1)
			: steps.length - 1
	);
	const step = $derived(steps[index]);
	const last = $derived(steps.length - 1);
	/** Five places: the cards dealt so far, then empty slots. */
	const board = $derived(Array.from({ length: 5 }, (_, place) => step.board[place]));

	let root = $state<HTMLElement>();
	let back = $state<HTMLButtonElement>();
	let next = $state<HTMLButtonElement>();

	function go(to: number) {
		const target = Math.max(0, Math.min(last, to));
		// A button about to be disabled would take the keyboard with it: hand the
		// focus to the one that still works.
		const focused = document.activeElement;
		if (focused instanceof HTMLButtonElement && root?.contains(focused)) {
			const backwards = focused.dataset.go === 'first' || focused.dataset.go === 'back';
			if (target === 0 && backwards) next?.focus();
			if (target === last && focused.dataset.go && !backwards) back?.focus();
		}
		chosen = { hand: detail.hand.hand_id, index: target };
	}

	function onkey(event: KeyboardEvent) {
		if (event.defaultPrevented) return;
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		const target = event.target;
		if (!(target instanceof Node && root?.contains(target))) {
			// Elsewhere on the page only the arrows step the hand, and never from a
			// field, where they move the caret or change the value.
			if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
			if (target instanceof Element && target.closest('input, select, textarea')) return;
		}
		const to = stepForKey(event.key, index, steps.length);
		if (to === null) return;
		event.preventDefault();
		go(to);
	}

	const chips = (n: number) => n.toLocaleString('en-US');
	const signed = (n: number) => (n > 0 ? `+${chips(n)}` : chips(n));
	/** A result's colour: won, lost or even. */
	const tone = (net: number) =>
		net > 0 ? 'won text-green-light' : net < 0 ? 'lost text-red-light' : 'text-paper-shade';

	const tag = 'tag bg-ink px-3 text-s text-violet-light';
	const goldTag = 'tag gold bg-gold px-3 text-s text-ink';
	const quiet = 'tag bg-ink px-3 text-s text-paper-shade';
	const control = 'px-btn small px-0';
	// Whole cards where a page has room; otherwise the compact peek.
	const whole =
		'ge-600:h-auto ge-600:w-auto ge-600:overflow-visible ge-600:[--k:1] ge-600:[&>.card+.card]:-ml-13';
</script>

<svelte:window onkeydown={onkey} />

<div
	class={['replay grid gap-4 text-mist', !roomy && 'text-s']}
	bind:this={root}
	data-step={index + 1}
	data-steps={steps.length}
>
	<div class="grid grid-cols-[repeat(4,1fr)] gap-2" role="group" aria-label="Steps of the hand">
		<button
			type="button"
			class={control}
			data-go="first"
			disabled={index === 0}
			onclick={() => go(0)}
		>
			First
		</button>
		<button
			type="button"
			class={control}
			data-go="back"
			aria-keyshortcuts="ArrowLeft"
			disabled={index === 0}
			bind:this={back}
			onclick={() => go(index - 1)}
		>
			Back
		</button>
		<button
			type="button"
			class={control}
			data-go="next"
			aria-keyshortcuts="ArrowRight"
			disabled={index === last}
			bind:this={next}
			onclick={() => go(index + 1)}
		>
			Next
		</button>
		<button
			type="button"
			class={control}
			data-go="last"
			disabled={index === last}
			onclick={() => go(last)}
		>
			Last
		</button>
	</div>
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 text-s">
		<span class="text-paper-shade">{stageOf(step)} · step {index + 1} of {steps.length}</span>
		<span class="text-gold-light text-shadow-ink">Pot {chips(step.pot)}</span>
	</div>
	<!-- Room for three lines, so a short step and a long one leave the board where it is. -->
	<div class="grid min-h-32 content-start gap-1 text-s leading-[1.4] text-paper" role="status">
		{#each step.lines as line, i (i)}<p>{line}</p>{/each}
	</div>
	<!-- Where the board's places overlap, the clean look cuts each empty slot's edge out of the
	     card before it (as far as they overlap), so the row reads as single edges, not crossed ones. -->
	<div
		class={[
			'board flex',
			roomy
				? 'gap-2 lt-600:[&>.card+.card]:-ml-7 clean:lt-600:[&>.card+.slot]:[clip-path:inset(0_0_0_14px)]'
				: '[&>.card+.card]:-ml-12 clean:[&>.card+.slot]:[clip-path:inset(0_0_0_24px)]'
		]}
		aria-label="Board"
	>
		{#each board as card, i (i)}
			<PlayingCard {card} />
		{/each}
	</div>
	<ul class="seats grid gap-1">
		{#each step.seats as seat (seat.seat)}
			{@const acting = step.acting === seat.seat}
			<li
				class={[
					'grid items-center border-b-2 border-deep-slate px-2 py-2',
					roomy
						? 'grid-cols-[minmax(0,1fr)_auto_90px] gap-5 lt-600:gap-3'
						: 'grid-cols-[minmax(0,1fr)_auto_80px] gap-3',
					acting && 'bg-deep-slate'
				]}
				class:you={seat.you}
				class:acting
			>
				<span class="who flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
					{#if acting}<span class="text-gold-light" aria-hidden="true">→</span>{/if}
					<span
						class={[
							'max-w-full truncate',
							seat.you && 'text-gold-light',
							seat.folded && 'opacity-55'
						]}
					>
						{seat.name}
					</span>
					{#if seat.kind === 'bot'}<span class={tag}>Bot</span>{/if}
					{#if seat.you}<span class={goldTag}>You</span>{/if}
					{#if detail.button === seat.seat}<span class={tag}>Button</span>{/if}
					{#if seat.folded}<span class={quiet}>Folded</span>{:else if seat.allIn}<span
							class={quiet}
						>
							All-in
						</span>{/if}
				</span>
				<!-- The viewer's cards as they held them; anyone else's face down until shown. -->
				<span
					class={[
						'hole flex gap-2',
						(seat.cards || !seat.folded) && 'card-peek',
						roomy && whole,
						seat.folded && 'opacity-55'
					]}
					aria-label={seat.cards ? 'Cards' : seat.folded ? 'Folded' : 'Cards not shown'}
				>
					{#if seat.cards}
						{#each seat.cards as card (`${card.rank}${card.suit}`)}<PlayingCard {card} />{/each}
					{:else if !seat.folded}
						<PlayingCard card={null} /><PlayingCard card={null} />
					{/if}
				</span>
				<span class="amount text-right">
					{#if seat.net !== null}
						<span class={['net', tone(seat.net)]}>{signed(seat.net)}</span>
					{:else if seat.bet > 0}
						<span class="bet inline-flex items-center gap-2 text-paper">
							<span class="sprite chip chip-gold size-7" aria-hidden="true"></span><span
								class="sr-only"
							>
								Bet
							</span>
							{chips(seat.bet)}
						</span>
					{/if}
				</span>
			</li>
		{/each}
	</ul>
</div>
