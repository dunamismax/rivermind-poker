<script lang="ts">
	// The design reference: every color, frame, button, field, card and sprite
	// in the pixel kit, as the site draws them. See docs/design.md.
	import { CARD_BACKS, CARD_RANKS } from '#lib/card-assets.ts';
	import paletteCss from '#lib/art/palette.css?raw';
	import PlayingCard from '#lib/components/PlayingCard.svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import type { Suit } from '#lib/protocol.ts';

	const palette = [...paletteCss.matchAll(/--([a-z-]+): (#[0-9a-f]{6});/g)].map(
		([, name, hex]) => ({
			name: name.replace(/-/g, ' '),
			hex
		})
	);
	const suits: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];
	const buttons = ['', 'red', 'blue', 'amber', 'green', 'gold'];
	const frames = [
		'px-panel',
		'px-raised',
		'px-inset',
		'px-gold',
		'px-glow',
		'px-danger',
		'px-paper'
	];
	const chips = ['white', 'red', 'blue', 'green', 'black', 'violet', 'gold'];
	const avatars = [
		...Array.from({ length: 6 }, (_, i) => `avatar-person-${i}`),
		'avatar-heuristic',
		'avatar-random',
		'avatar-calling-station',
		'avatar-bot'
	];
	let range = $state(40);
</script>

<svelte:head>
	<title>Design reference · RiverMind Poker</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<SiteHeader />

<main>
	<h2>Design reference</h2>
	<p class="lead">
		Every piece of the pixel kit as the site draws it. Art pixels are drawn at 2x for the interface;
		cards at a whole number of screen pixels per art pixel, the size <code>--k</code> asks for.
		Sources live in <code>web/art/</code>; run <code>pnpm art</code> after changing them.
	</p>

	<section>
		<h3>Palette</h3>
		<ul class="palette">
			{#each palette as color (color.name)}
				<li>
					<svg viewBox="0 0 8 8" aria-hidden="true">
						<rect width="8" height="8" fill={color.hex} />
					</svg>
					<span>{color.name}</span>
					<code>{color.hex}</code>
				</li>
			{/each}
		</ul>
	</section>

	<section>
		<h3>Type: RiverMind Pixel</h3>
		<p class="t40 t-gold">40px · No-limit hold’em</p>
		<p class="t30">30px · Pot 12,450 · A♠ K♥</p>
		<p class="t20">20px · The quick brown fox jumps over the lazy dog. 0123456789</p>
		<p class="t15 t-muted">15px · secondary text, hand log, tags (crisp on 2x screens)</p>
	</section>

	<section>
		<h3>Buttons</h3>
		<div class="row">
			{#each buttons as color (color)}
				<button type="button" class="px-btn {color}">{color || 'slate'}</button>
			{/each}
			<button type="button" class="px-btn amber" disabled>disabled</button>
			<button type="button" class="px-btn small">small</button>
			<button type="button" class="px-btn" aria-pressed="true">pressed</button>
		</div>
	</section>

	<section>
		<h3>Frames</h3>
		<div class="row">
			{#each frames as frame (frame)}<div class="frame {frame}">{frame}</div>{/each}
		</div>
	</section>

	<section>
		<h3>Fields</h3>
		<div class="row fields">
			<label>
				<span>Select</span>
				<select class="px-field"><option>50/100</option><option>100/200</option></select>
			</label>
			<label>
				<span>Number</span>
				<input class="px-field" type="number" value="2400" />
			</label>
			<label class="grow">
				<span>Slider: {range}</span>
				<input class="px-range" type="range" min="0" max="100" bind:value={range} />
			</label>
		</div>
	</section>

	<section>
		<h3>Cards</h3>
		<div class="deck">
			{#each suits as suit (suit)}
				<div class="suit">
					{#each CARD_RANKS as rank (rank)}<PlayingCard card={{ rank, suit }} />{/each}
				</div>
			{/each}
			<div class="suit">
				{#each CARD_BACKS as back (back)}
					<figure class="back">
						<PlayingCard card={null} {back} />
						<figcaption>{back}</figcaption>
					</figure>
				{/each}
				<figure class="back">
					<PlayingCard card={undefined} />
					<figcaption>slot</figcaption>
				</figure>
			</div>
		</div>
		<div class="sizes">
			<div class="k1">
				<PlayingCard card={{ rank: 13, suit: 'hearts' }} /><span>--k: 0.75</span>
			</div>
			<div class="k2"><PlayingCard card={{ rank: 13, suit: 'hearts' }} /><span>--k: 1</span></div>
			<div class="k3"><PlayingCard card={{ rank: 13, suit: 'hearts' }} /><span>--k: 1.4</span></div>
			<div class="k4"><PlayingCard card={{ rank: 13, suit: 'hearts' }} /><span>--k: 2</span></div>
		</div>
	</section>

	<section>
		<h3>Sprites</h3>
		<div class="row sprites">
			{#each chips as chip (chip)}<span class="sprite chip chip-{chip}" title="chip-{chip}"
				></span>{/each}
			<span class="sprite pot-pile" title="pot-pile"></span>
			<span class="sprite dealer-button" title="dealer-button"></span>
			<span class="sprite mini-cards" title="mini-cards"></span>
			<span class="sprite emblem" title="emblem"></span>
		</div>
		<div class="row sprites">
			{#each avatars as avatar (avatar)}<span class="sprite avatar {avatar}" title={avatar}
				></span>{/each}
		</div>
	</section>
</main>

<style>
	main {
		max-width: 1180px;
		margin: 0 auto;
		padding: 24px 16px 64px;
		display: grid;
		gap: 32px;
	}
	h2 {
		font-size: var(--fs-xl);
		color: var(--gold);
		text-shadow: var(--shadow-text);
	}
	h3 {
		font-size: var(--fs-l);
		margin-bottom: 12px;
		text-shadow: var(--shadow-text);
	}
	.lead {
		color: var(--mist);
		max-width: 60ch;
	}
	code {
		font-family: var(--font);
		color: var(--gold-light);
	}
	.palette {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 8px 16px;
	}
	.palette li {
		display: grid;
		grid-template-columns: 32px 1fr;
		column-gap: 8px;
		align-items: center;
		font-size: var(--fs-s);
	}
	.palette svg {
		grid-row: span 2;
		width: 32px;
		height: 32px;
		box-shadow: 0 0 0 var(--px) var(--ink);
	}
	.palette code {
		color: var(--haze);
	}
	.t40 {
		font-size: var(--fs-xl);
	}
	.t30 {
		font-size: var(--fs-l);
	}
	.t20 {
		font-size: var(--fs);
	}
	.t15 {
		font-size: var(--fs-s);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
	}
	.frame {
		padding: 12px 16px;
		min-width: 140px;
	}
	.fields label {
		display: grid;
		gap: 6px;
	}
	.fields .grow {
		flex: 1;
		min-width: 220px;
	}
	.deck {
		--k: 1;
		display: grid;
		gap: 10px;
	}
	.suit {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.sizes {
		display: flex;
		align-items: end;
		gap: 24px;
		margin-top: 16px;
	}
	.sizes > div {
		display: grid;
		justify-items: center;
		gap: 6px;
		color: var(--mist);
	}
	.back {
		display: grid;
		justify-items: center;
		gap: 4px;
		width: 120px;
		margin: 0;
		color: var(--mist);
		font-size: var(--fs-s);
	}
	.k1 {
		--k: 0.75;
	}
	.k2 {
		--k: 1;
	}
	.k3 {
		--k: 1.4;
	}
	.k4 {
		--k: 2;
	}
	.sprites .avatar {
		width: 64px;
		height: 64px;
	}
	@media (max-width: 639px) {
		.deck {
			--k: 0.75;
		}
		.sizes {
			flex-wrap: wrap;
		}
	}
</style>
