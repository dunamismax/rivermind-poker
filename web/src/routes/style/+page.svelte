<script lang="ts">
	// The design reference: every color, text size, spacing step, frame, button,
	// field, card and sprite in the kit, as the site draws them, with the Tailwind
	// utilities that name them. See docs/design.md.
	import { CARD_BACKS, CARD_RANKS } from '#lib/card-assets.ts';
	import themeCss from '../../styles/theme.css?raw';
	import PlayingCard from '#lib/components/PlayingCard.svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import type { Suit } from '#lib/protocol.ts';

	/** The colors and text sizes, read from the stylesheet that defines them. */
	function tokens(css: string) {
		return {
			palette: [...css.matchAll(/--color-([a-z-]+): (#[0-9a-f]{6});/g)].map(([, name, hex]) => ({
				name: name.replace(/-/g, ' '),
				hex
			})),
			sizes: Object.fromEntries(
				[...css.matchAll(/--text-(xs|s|m|l|xl): (\d+px);/g)].map(([, name, px]) => [name, px])
			)
		};
	}
	const kit = tokens(themeCss);
	const suits: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];
	const buttons = ['', 'red', 'blue', 'amber', 'green', 'gold'];
	const frames = [
		'ui-panel',
		'ui-raised',
		'ui-inset',
		'ui-gold',
		'ui-glow',
		'ui-danger',
		'ui-paper'
	];
	const chips = ['white', 'red', 'blue', 'green', 'black', 'violet', 'gold'];
	// Table voice's glyphs (P4C.6): talking, muted, listening only, deafened, not in voice.
	const voiceGlyphs = [
		'voice-mic',
		'voice-mic-muted',
		'voice-phones',
		'voice-phones-muted',
		'voice-out'
	];
	const avatars = [
		...Array.from({ length: 6 }, (_, i) => `avatar-person-${i}`),
		'avatar-heuristic',
		'avatar-random',
		'avatar-calling-station',
		'avatar-medium',
		'avatar-hard',
		'avatar-bot'
	];
	let range = $state(40);

	const heading = 'mb-6 text-l text-shadow-ink';
	const row = 'row flex flex-wrap items-center gap-6';
	const size = 'grid justify-items-center gap-3 text-mist';
	const note = 'mb-6 max-w-[60ch] text-s text-mist';
	/** Bars as tall as the spacing steps they are labelled with. */
	const RULER: Record<number, string> = {
		1: 'h-1',
		2: 'h-2',
		3: 'h-3',
		4: 'h-4',
		6: 'h-6',
		8: 'h-8',
		12: 'h-12',
		16: 'h-16'
	};
</script>

<svelte:head>
	<title>Design reference · RiverMind Poker</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<SiteHeader />

<main class="mx-auto grid max-w-[1180px] gap-16 px-8 pt-12 pb-32">
	<h2 class="text-xl text-gold text-shadow-ink">Design reference</h2>
	<p class="lead max-w-[60ch] text-mist">
		Every piece of the kit as the site draws it, in CSS with the system's fonts. Its tokens are in <code
			class="text-gold-light"
		>
			web/src/styles/theme.css
		</code>
		and its kit in
		<code class="text-gold-light">kit.css</code>; the cards and sprites are drawn by
		<code class="text-gold-light">pnpm art</code>.
	</p>

	<section>
		<h3 class={heading}>Palette</h3>
		<p class={note}>
			The only colors there are. A utility takes a color's name with hyphens:
			<code class="text-gold-light">bg-felt</code>,
			<code class="text-gold-light">text-gold</code>,
			<code class="text-gold-light">border-deep-slate</code>.
		</p>
		<ul class="palette grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-8 gap-y-4">
			{#each kit.palette as color (color.name)}
				<li class="grid grid-cols-[32px_1fr] items-center gap-x-4 text-s">
					<svg
						class="row-span-2 size-16 [box-shadow:0_0_0_2px_var(--color-ink)]"
						viewBox="0 0 8 8"
						aria-hidden="true"
					>
						<rect width="8" height="8" fill={color.hex} />
					</svg>
					<span>{color.name}</span>
					<code class="text-haze">{color.hex}</code>
				</li>
			{/each}
		</ul>
	</section>

	<section>
		<h3 class={heading}>Type: the system’s fonts</h3>
		<p class="text-xl text-gold text-shadow-ink">{kit.sizes.xl} · text-xl · No-limit hold’em</p>
		<p class="text-l">{kit.sizes.l} · text-l · Pot 12,450 · A♠ K♥</p>
		<p class="text-m">
			{kit.sizes.m} · text-m · The quick brown fox jumps over the lazy dog. 0123456789
		</p>
		<p class="text-s text-mist">
			{kit.sizes.s} · text-s · secondary text, hand log, tags
		</p>
		<p class="text-xs text-mist">{kit.sizes.xs} · text-xs · bets and tags on a phone’s table</p>
	</section>

	<section>
		<h3 class={heading}>Spacing</h3>
		<p class={note}>
			Lengths count spacing steps, 2px each: <code class="text-gold-light">p-3</code> is 6px of
			padding, <code class="text-gold-light">gap-4</code> an 8px gap,
			<code class="text-gold-light">size-7</code> a 14px square.
		</p>
		<div class="flex items-end gap-4">
			{#each [1, 2, 3, 4, 6, 8, 12, 16] as n (n)}
				<div class="grid justify-items-center gap-2 text-s text-mist">
					<span class="block w-4 bg-gold {RULER[n]}"></span>{n}
				</div>
			{/each}
		</div>
	</section>

	<section>
		<h3 class={heading}>Buttons</h3>
		<div class={row}>
			{#each buttons as color (color)}
				<button type="button" class="ui-btn {color}">{color || 'slate'}</button>
			{/each}
			<button type="button" class="ui-btn amber" disabled>disabled</button>
			<button type="button" class="ui-btn small">small</button>
			<button type="button" class="ui-btn" aria-pressed="true">pressed</button>
		</div>
	</section>

	<section>
		<h3 class={heading}>Frames</h3>
		<div class={row}>
			{#each frames as frame (frame)}<div class="frame min-w-70 px-8 py-6 {frame}">
					{frame}
				</div>{/each}
		</div>
	</section>

	<section>
		<h3 class={heading}>Fields</h3>
		<div class="{row} fields">
			<label class="grid gap-3">
				<span>Select</span>
				<select class="ui-field"><option>50/100</option><option>100/200</option></select>
			</label>
			<label class="grid gap-3">
				<span>Number</span>
				<input class="ui-field" type="number" value="2400" />
			</label>
			<label class="grid min-w-[220px] flex-1 gap-3">
				<span>Slider: {range}</span>
				<input class="ui-range" type="range" min="0" max="100" bind:value={range} />
			</label>
		</div>
	</section>

	<section>
		<h3 class={heading}>Cards</h3>
		<div class="deck grid gap-5 [--k:1] lt-640:[--k:0.75]">
			{#each suits as suit (suit)}
				<div class="suit flex flex-wrap gap-3">
					{#each CARD_RANKS as rank (rank)}<PlayingCard card={{ rank, suit }} />{/each}
				</div>
			{/each}
			<div class="suit flex flex-wrap gap-3">
				{#each CARD_BACKS as back (back)}
					<figure class="back grid w-60 justify-items-center gap-2 text-s text-mist">
						<PlayingCard card={null} {back} />
						<figcaption>{back}</figcaption>
					</figure>
				{/each}
				<figure class="back grid w-60 justify-items-center gap-2 text-s text-mist">
					<PlayingCard card={undefined} />
					<figcaption>slot</figcaption>
				</figure>
			</div>
		</div>
		<div class="sizes mt-8 flex items-end gap-12 lt-640:flex-wrap">
			<div class="{size} [--k:0.75]">
				<PlayingCard card={{ rank: 13, suit: 'hearts' }} /><span>--k: 0.75</span>
			</div>
			<div class="{size} [--k:1]">
				<PlayingCard card={{ rank: 13, suit: 'hearts' }} /><span>--k: 1</span>
			</div>
			<div class="{size} [--k:1.4]">
				<PlayingCard card={{ rank: 13, suit: 'hearts' }} /><span>--k: 1.4</span>
			</div>
			<div class="{size} [--k:2]">
				<PlayingCard card={{ rank: 13, suit: 'hearts' }} /><span>--k: 2</span>
			</div>
		</div>
	</section>

	<section>
		<h3 class={heading}>Sprites</h3>
		<div class="{row} sprites">
			{#each chips as chip (chip)}<span class="sprite chip chip-{chip}" title="chip-{chip}"
				></span>{/each}
			<span class="sprite pot-pile" title="pot-pile"></span>
			<span class="sprite dealer-button" title="dealer-button"></span>
			<span class="sprite mini-cards" title="mini-cards"></span>
			<span class="sprite emblem" title="emblem"></span>
		</div>
		<div class="{row} sprites">
			{#each avatars as avatar (avatar)}<span class="sprite avatar size-32 {avatar}" title={avatar}
				></span>{/each}
		</div>
		<div class="{row} sprites voice-glyphs">
			{#each voiceGlyphs as glyph (glyph)}<span class="sprite voice-glyph {glyph}" title={glyph}
				></span>{/each}
		</div>
	</section>
</main>
