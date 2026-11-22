<script lang="ts">
	import PlayingCard from '../components/PlayingCard.svelte';
	import type { SeatInfo, Turn } from '../protocol-v2.ts';
	import { avatarClass, botLabel, podName } from './faces.ts';
	import { clockLeft } from './layout.ts';
	import type { SeatVoice } from './voice.svelte.ts';

	let {
		info,
		place,
		side = 'bottom',
		me = false,
		button = false,
		turn = null,
		now,
		won = 0,
		reaction = null,
		relation = '',
		voice = null,
		onselect
	}: {
		info: SeatInfo;
		place: string;
		/** Which way the seat faces the middle (see layout.ts sideOf). */
		side?: string;
		me?: boolean;
		button?: boolean;
		turn?: Turn | null;
		/** The server's time now, for the turn clock. */
		now: number;
		won?: number;
		/** A reaction showing beside the seat (P4.5). */
		reaction?: string | null;
		/** `Muted` or `Blocked` when the viewer muted or blocked this player. */
		relation?: string;
		/** This person in table voice, while the viewer is in it (P4C.6). */
		voice?: SeatVoice | null;
		/** Opens the menu to mute, block or report this player; set only for other people. */
		onselect?: () => void;
	} = $props();

	const SEGMENTS = 12;
	const segments = Array.from({ length: SEGMENTS }, (_, i) => i);
	const acting = $derived(turn !== null && turn.seat === info.seat);
	const clock = $derived(acting && turn ? clockLeft(turn, now) : null);
	const lit = $derived(clock ? Math.ceil(clock.fraction * SEGMENTS) : 0);
	const status = $derived(
		info.leaving
			? 'Leaving'
			: info.sitting_out
				? 'Sitting out'
				: info.folded
					? 'Folded'
					: info.all_in
						? 'All-in'
						: !info.connected && info.kind === 'human'
							? 'Away'
							: ''
	);
	const label = $derived(
		`${me ? 'Your seat' : `Seat ${info.seat + 1}`}: ${info.name}${info.kind === 'bot' ? ' (bot)' : ''}`
	);
	const frame = $derived(acting ? 'px-glow' : me ? 'px-gold' : 'px-panel');
	const dim = $derived(info.folded || info.sitting_out);

	// On phones (`phone:`, which is also a tablet held upright, where `tab:` then
	// adjusts it) the other players are compact pods centred on their place, with a
	// small card-back badge; the cards they show sit by the pod, towards the
	// middle. The viewer keeps a full seat with large cards, on a phone (`pocket:`)
	// as wide as the pods on the bottom corners leave between them.
	const seat = $derived(
		me
			? 'z-2 w-100 [--k:1.4] lap:w-86 lap:[--k:1] phone:w-110 tab:w-120 tab:[--k:1.4] pocket:w-[min(220px,calc(75%-92px))]'
			: 'z-1 w-88 [--k:1] lap:w-75 phone:w-42 phone:text-s phone:[--k:0.5] tab:w-75 tab:text-m'
	);
	/**
	 * Where a pod's shown cards go, by the side of the table it sits on: under a seat
	 * in the top row, beside one at the side, and above one on a bottom corner, where
	 * the viewer's own seat is beside it (a tablet has room next to the pod's top).
	 */
	const SHOWN: Record<string, string> = {
		'side-left': 'phone:top-1/2 phone:left-[calc(100%+2px)] phone:-translate-y-1/2',
		'side-right': 'phone:top-1/2 phone:right-[calc(100%+2px)] phone:-translate-y-1/2',
		'side-top': 'phone:top-[calc(100%+20px)] phone:left-1/2 phone:-translate-x-1/2',
		'side-low-left':
			'phone:bottom-[calc(100%-4px)] phone:left-0 tab:bottom-1/2 tab:left-[calc(100%+2px)]',
		'side-low-right':
			'phone:bottom-[calc(100%-4px)] phone:right-0 tab:bottom-1/2 tab:right-[calc(100%+2px)]'
	};
	/**
	 * The card-back badge peeks out over a top corner of the pod: the one towards the
	 * middle, or the outer one on a bottom corner of the table, whose bet sits over the
	 * inner one.
	 */
	const BADGE: Record<string, string> = {
		'side-left': 'phone:-right-4',
		'side-top': 'phone:-right-4',
		'side-right': 'phone:-left-4',
		'side-low-left': 'phone:-left-4',
		'side-low-right': 'phone:-right-4'
	};
	/** A pod wears the dealer button on a corner the badge and the bet leave free. */
	const DEALER: Record<string, string> = {
		'side-left': 'phone:-top-6 phone:right-auto phone:-left-3',
		'side-top': 'phone:-top-6 phone:right-auto phone:-left-3',
		'side-right': 'phone:-top-6 phone:-right-3',
		'side-low-left': 'phone:top-auto phone:right-auto phone:-bottom-4 phone:-left-3',
		'side-low-right': 'phone:top-auto phone:-right-3 phone:-bottom-4'
	};
	// A bot's pod leaves out the words its name shares with the others ("Easy 4"); the
	// whole name stays in the seat's label and title, and on every wider seat.
	const parts = $derived(!me && info.kind === 'bot' ? podName(info.name) : null);
	const tag =
		'mt-1 bg-ink px-3 text-s leading-10 whitespace-nowrap phone:px-2 phone:text-xs phone:leading-7 tab:text-s tab:leading-10';
	/** The glyph and the words for this person's place in table voice. */
	const VOICE: Record<SeatVoice['state'], { glyph: string; text: string }> = {
		talking: { glyph: 'voice-mic', text: 'In voice' },
		muted: { glyph: 'voice-mic-muted', text: 'Muted' },
		deafened: { glyph: 'voice-phones-muted', text: 'Deafened' },
		listening: { glyph: 'voice-phones', text: 'Listening only' },
		out: { glyph: 'voice-out', text: 'Not in voice' }
	};
	const voiceTag = $derived(voice ? VOICE[voice.state] : null);
	const voiceText = $derived(
		voice && voiceTag
			? `${voiceTag.text}${voice.speaking ? ', speaking' : ''}${voice.mutedByMe ? ', muted by you' : ''}`
			: ''
	);
	const lamp = $derived(
		clock?.bank
			? 'fill-red-light'
			: clock && clock.fraction < 0.3
				? 'fill-gold'
				: 'fill-green-light'
	);
</script>

<div
	class="seat absolute grid -translate-1/2 grid-cols-1 justify-items-center text-m leading-[1.2] {place} {side} {seat}"
	class:me
	class:acting
	class:dim
	role="group"
	aria-label={label}
	data-seat={info.seat}
>
	<div
		class={[
			'hand flex justify-center',
			!info.cards && 'backs',
			dim && 'opacity-55',
			!me &&
				'phone:absolute phone:z-2 phone:justify-start phone:overflow-hidden tab:overflow-visible',
			!me && SHOWN[side],
			!me && !info.cards && 'phone:hidden'
		]}
	>
		{#if info.cards}
			{#each info.cards as card (`${card.rank}${card.suit}`)}
				<PlayingCard {card} />
			{/each}
		{:else if info.has_cards}
			<PlayingCard card={null} />
			<PlayingCard card={null} />
		{/if}
	</div>
	<div
		class={[
			'plate relative flex min-h-26 w-full items-center gap-4 px-2 py-1 phone:min-h-0 phone:gap-2 phone:px-1',
			frame,
			me ? 'phone:py-0' : 'phone:block phone:pt-1 phone:pb-0 phone:text-center',
			dim && 'opacity-55',
			acting && 'animate-nudge',
			voice?.speaking && 'speaking outline-2 outline-offset-2 outline-green-light animate-speak'
		]}
	>
		<span
			class={['sprite avatar lap:size-12', avatarClass(info), !me && 'phone:hidden']}
			aria-hidden="true"
		></span>
		<div class="who min-w-0 flex-1">
			{#if onselect}
				<button
					type="button"
					class="name pick block w-full cursor-pointer truncate text-left text-shadow-ink hover:text-gold-light hover:underline focus-visible:text-gold-light focus-visible:underline"
					title={info.name}
					aria-haspopup="dialog"
					aria-label="{info.name}: mute, block or report"
					onclick={onselect}
				>
					{info.name}
				</button>
			{:else}
				<div class={['name truncate text-shadow-ink', me && 'text-gold']} title={info.name}>
					{#if parts}{#each parts as part, i (i)}{#if part.pod}{part.text}{:else}<span
									class="phone:hidden"
								>
									{part.text}
								</span>{/if}{/each}{:else}{info.name}{/if}
				</div>
			{/if}
			<div
				class={[
					'stack flex items-center gap-3 text-gold-light text-shadow-ink',
					!me && 'phone:justify-center phone:gap-2'
				]}
			>
				<span class="sprite chip chip-gold size-7 phone:size-[11px]" aria-hidden="true"
				></span>{info.stack}
				{#if voice && voiceTag}
					<span
						class={[
							'voice ml-auto flex items-center',
							!me && 'phone:ml-0',
							voice.mutedByMe && 'opacity-60'
						]}
						title={voiceText}
						data-voice={voice.state}
						data-speaking={voice.speaking ? 'true' : undefined}
					>
						<span
							class="sprite voice-glyph {voiceTag.glyph} size-11 phone:size-[11px] tab:size-11"
							aria-hidden="true"
						></span>
						<span class="sr-only">{voiceText}</span>
					</span>
				{/if}
			</div>
		</div>
		{#if reaction}<div
				class="bubble px-paper pointer-events-none absolute bottom-[calc(100%-6px)] left-1/2 z-4 -translate-x-1/2 animate-fade px-4 py-1 text-s leading-10 whitespace-nowrap text-ink"
				role="status"
			>
				<span class="sr-only">{info.name}: </span>{reaction}
			</div>{/if}
		{#if button}<span
				class={[
					'sprite dealer-button dealer absolute -top-7 -right-5 phone:size-9',
					me ? 'phone:-top-5 phone:-right-4' : DEALER[side]
				]}
				title="Dealer button"
			></span>{/if}
		{#if info.has_cards && !info.cards}
			<span
				class={[
					'sprite mini-cards hidden',
					!me && 'phone:absolute phone:-top-12 phone:-z-1 phone:block phone:h-13 phone:w-14',
					!me && BADGE[side]
				]}
				aria-hidden="true"
			></span>
		{/if}
	</div>
	<div
		class={[
			'below grid justify-items-center',
			!me && 'phone:absolute phone:inset-x-0 phone:top-full'
		]}
	>
		<div class="tags flex min-h-0 justify-center gap-3">
			{#if info.kind === 'bot'}
				<span class="bot text-violet-light {tag}">
					Bot{#if !info.name.startsWith(botLabel(info.bot))}<span class="kind phone:hidden">
							· {botLabel(info.bot)}
						</span>{/if}
				</span>
			{/if}
			{#if status}<span class="status text-paper-shade {tag}">{status}</span>{/if}
			{#if relation}<span class="status muted text-red-light {tag}">{relation}</span>{/if}
		</div>
		{#if clock}
			<div
				class={[
					'clock mt-2 flex items-center gap-3 text-s text-shadow-ink phone:mt-1 phone:gap-2',
					clock.bank
						? 'bank text-red-light'
						: clock.fraction < 0.3
							? 'low text-gold'
							: 'text-green-light'
				]}
			>
				<svg
					class="block h-4 w-37"
					viewBox="0 0 {SEGMENTS * 3 + 1} 4"
					aria-hidden="true"
					shape-rendering="crispEdges"
				>
					<rect class="fill-ink" x="0" y="0" width={SEGMENTS * 3 + 1} height="4" />
					{#each segments as i (i)}
						<rect
							class={i < lit ? lamp : 'fill-deep-slate'}
							x={1 + i * 3}
							y="1"
							width="2"
							height="2"
						/>
					{/each}
				</svg>
				<span class={['secs', !me && 'phone:hidden']}>
					{clock.bank ? 'Bank ' : ''}{clock.seconds}s
				</span>
			</div>
		{/if}
	</div>
	{#if won > 0}<div
			class="won pointer-events-none absolute top-0 left-1/2 z-3 -translate-x-1/2 -translate-y-[60%] animate-rise text-l text-gold [text-shadow:0_2px_0_var(--color-ink),2px_0_0_var(--color-ink),-2px_0_0_var(--color-ink),0_-2px_0_var(--color-ink)] phone:text-m"
			role="status"
		>
			+{won}
		</div>{/if}
</div>

<style>
	/*
	 * The cards' geometry follows the art pixel they are drawn at: --hand-a is one
	 * art pixel as PlayingCard snaps it, so the fan and the overlap with the plate
	 * keep to whole device pixels. Everything else about the seat is utilities.
	 */
	.hand {
		--hand-a: calc(
			1px *
				max(
					min(var(--card-min, 1), round(down, var(--dpr, 1), 1)),
					round(nearest, calc(var(--k) * var(--dpr, 1)), 1)
				) /
				var(--dpr, 1)
		);
		min-height: calc(95 * var(--hand-a) * 0.55);
		margin-bottom: calc(-95 * var(--hand-a) * 0.3);
	}
	.hand :global(.card + .card) {
		margin-left: calc(-26 * var(--hand-a));
		transform: rotate(4deg) translateY(calc(2 * var(--hand-a)));
		transform-origin: bottom left;
	}
	.hand :global(.card:first-child:not(:last-child)) {
		transform: rotate(-4deg);
		transform-origin: bottom right;
	}

	/* A pod's shown cards: at least 2 device pixels per art pixel so the indices
	   read, fanned tight and cut to a 58 × 50 window (the first card's index and
	   the second card's corner) so the pod stays small. */
	@media (max-width: 639px), (max-width: 1099px) and (orientation: portrait) {
		.seat:not(.me) .hand {
			--k: 0.75;
			--card-min: 2;
			width: calc(58 * var(--hand-a));
			height: calc(50 * var(--hand-a));
			min-height: 0;
			margin: 0;
		}
		.seat:not(.me) .hand :global(.card) {
			transform: none;
		}
		.seat:not(.me) .hand :global(.card + .card) {
			margin-left: calc(-53 * var(--hand-a));
		}
	}
	/* Upright tablets have room for the whole cards. */
	@media (min-width: 640px) and (max-width: 1099px) and (orientation: portrait) {
		.seat:not(.me) .hand {
			--k: 1;
			width: auto;
			height: auto;
		}
		.seat:not(.me) .hand :global(.card + .card) {
			margin-left: calc(-49 * var(--hand-a));
		}
	}
</style>
