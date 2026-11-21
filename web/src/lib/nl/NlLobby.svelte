<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import PlayingCard from '../components/PlayingCard.svelte';
	import type { ConfigResponse, TableSummary } from '../protocol-v2.ts';
	import { fetchConfig, fetchInvite } from './api.ts';
	import type { NlConnection } from './connection.svelte.ts';
	import { avatarClass } from './faces.ts';
	import LobbyTables from './LobbyTables.svelte';

	let {
		connection,
		message = '',
		invite = null,
		oninvited
	}: {
		connection: NlConnection;
		message?: string;
		/** An invite code from the page's link, for a private table. */
		invite?: string | null;
		/** The invite was used or turned out to be stale. */
		oninvited?: () => void;
	} = $props();

	const balance = $derived(connection.balance);
	let config = $state<ConfigResponse | null>(null);
	let seats = $state(6);
	/** A bot kind, or `none` to leave the other seats for people. */
	let bots = $state('heuristic');
	let privateTable = $state(false);
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

	let practising = $state(false);
	let practiceError = $state('');

	// Practice (P6.0b): one click to a heads-up hand against RiverMind Easy,
	// with practice chips, whatever the wallet holds.
	async function practice() {
		practising = true;
		practiceError = '';
		try {
			await connection.practice();
		} catch (e) {
			practiceError = `Could not start practice: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			practising = false;
		}
	}

	let invited = $state<TableSummary | null>(null);
	let inviteError = $state('');
	let joining = $state(false);

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
		if (invite) {
			fetchInvite(invite)
				.then((table) => (invited = table))
				.catch((e: unknown) => {
					inviteError = e instanceof Error ? e.message : String(e);
					oninvited?.();
				});
		}
	});

	async function start(event: SubmitEvent) {
		event.preventDefault();
		starting = true;
		error = '';
		try {
			await connection.newTable({
				seats,
				bots: bots === 'none' ? null : bots,
				big_blind: bigBlind,
				buy_in: buyInBlinds * bigBlind,
				private: privateTable
			});
		} catch (e) {
			error = `Could not start a table: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			starting = false;
		}
	}

	async function accept(table: TableSummary) {
		joining = true;
		inviteError = '';
		try {
			if (table.free_seats + table.bot_seats > 0 || table.hold) {
				await connection.takeSeat(table.table_id, { invite });
			} else {
				await connection.joinWaitlist(table.table_id, invite);
				invited = await fetchInvite(invite ?? '');
				return;
			}
			oninvited?.();
		} catch (e) {
			inviteError = e instanceof Error ? e.message : String(e);
		} finally {
			joining = false;
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
		<section class="practice px-panel" aria-labelledby="practice-title">
			<h3 id="practice-title" class="visually-hidden">Practice</h3>
			<button
				type="button"
				class="px-btn amber practice-start"
				disabled={practising}
				onclick={practice}
			>
				{practising ? 'Dealing…' : 'Practice vs bots'}
			</button>
			<p class="note">
				Heads-up against the RiverMind Easy bot with {(
					config?.practice_stack ?? 10000
				).toLocaleString('en-US')} practice chips. Your wallet is not touched, and you get a fresh stack
				whenever you run out.
			</p>
			{#if practiceError}<p class="error" role="alert">{practiceError}</p>{/if}
		</section>
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
		<nav class="links" aria-label="More">
			<a class="px-btn small" href={resolve('/hands')}>Your hands</a>
			<a class="px-btn small" href={resolve('/fairness')}>Rules and fair dealing</a>
		</nav>
		{#if message}<p class="closed px-panel" role="status">{message}</p>{/if}
		{#if invited}
			<section class="invite px-gold" aria-labelledby="invite-title">
				<h3 id="invite-title">You are invited</h3>
				<p>
					{invited.name}: blinds {invited.small_blind}/{invited.big_blind}, {invited.people}
					{invited.people === 1 ? 'person' : 'people'} seated.
				</p>
				{#if invited.waitlist_position !== null}
					<p>You are number {invited.waitlist_position} in line for a seat.</p>
				{:else}
					<button
						type="button"
						class="px-btn amber"
						disabled={joining || (balance !== null && balance < invited.min_buy_in)}
						onclick={() => accept(invited!)}
					>
						{joining
							? 'Seating…'
							: invited.free_seats + invited.bot_seats > 0 || invited.hold
								? 'Take a seat'
								: 'Join the waitlist'}
					</button>
				{/if}
			</section>
		{/if}
		{#if inviteError}<p class="error" role="alert">{inviteError}</p>{/if}
	</section>

	<div class="side">
		<LobbyTables {connection} {config} {balance} />

		<section class="setup px-panel" aria-labelledby="setup-title">
			<h2 id="setup-title" class="setup-title">Start a table</h2>
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
						<label class="pick bot">
							<input type="radio" name="bots" value="none" bind:group={bots} />
							<span class="px-btn">
								<span
									class="sprite avatar {avatarClass({ kind: 'human', bot: null, name: 'You' })}"
									aria-hidden="true"
								></span>
								<span class="text">
									<span class="name">No bots</span>
									<span class="note">Seats wait for people.</span>
								</span>
							</span>
						</label>
					</div>
					<p class="field-note">Bots give up their seats when people want them.</p>
				</fieldset>
				<label class="private">
					<input type="checkbox" bind:checked={privateTable} />
					<span>
						Private table
						<span class="note">Not listed; share its invite link.</span>
					</span>
				</label>
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
		--k: 1.4;
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
	.hero h2 {
		font-size: var(--fs-xl);
		color: var(--color-gold);
		text-shadow:
			0 var(--px) 0 var(--color-amber-deep),
			0 calc(2 * var(--px)) 0 var(--color-ink);
	}
	.intro,
	.closed,
	.short {
		color: var(--color-mist);
	}
	.closed {
		padding: 6px 10px;
	}
	.practice {
		display: grid;
		gap: 8px;
		padding: 12px 14px;
	}
	.practice-start {
		min-height: 64px;
		font-size: var(--fs-l);
		width: 100%;
	}
	.practice .note {
		color: var(--color-mist);
		font-size: var(--fs-s);
	}
	.wallet {
		display: grid;
		gap: 2px;
		padding: 8px 12px;
	}
	.wallet .label {
		color: var(--color-mist);
	}
	.wallet .amount {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: var(--fs-l);
		color: var(--color-gold);
		text-shadow: var(--shadow-text);
	}
	.wallet strong {
		font-weight: normal;
	}
	.wallet .hint {
		color: var(--color-haze);
		font-size: var(--fs-s);
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.side {
		display: grid;
		gap: 16px;
		min-width: 0;
	}
	.setup {
		padding: 12px 14px 14px;
	}
	.setup-title {
		font-size: var(--fs-l);
		color: var(--color-gold);
		text-shadow: var(--shadow-text);
		margin-bottom: 12px;
	}
	.field-note {
		margin-top: 6px;
		color: var(--color-haze);
		font-size: var(--fs-s);
	}
	.private {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		color: var(--color-paper-shade);
		cursor: pointer;
	}
	.private input {
		width: 20px;
		height: 20px;
		margin-top: 2px;
		accent-color: var(--color-gold);
	}
	.private .note {
		display: block;
		color: var(--color-mist);
		font-size: var(--fs-s);
	}
	.invite {
		display: grid;
		gap: 10px;
		padding: 10px 12px 12px;
		color: var(--color-ink);
	}
	.invite h3 {
		font-size: var(--fs-l);
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
	legend {
		padding-inline: 2px;
	}
	legend,
	.field-label {
		display: block;
		margin-bottom: 8px;
		color: var(--color-gold);
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
		color: var(--color-ink);
		text-shadow: 0 var(--px) 0 var(--color-gold-light);
	}
	.pick input:focus-visible + .px-btn {
		outline: var(--px) solid var(--color-gold-light);
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
		color: var(--color-mist);
		text-shadow: none;
	}
	.bot input:checked + .px-btn .note {
		color: var(--color-amber-deep);
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
	.hero .error {
		margin-top: 0;
	}

	@media (max-width: 799px) {
		.lobby {
			grid-template-columns: minmax(0, 1fr);
			gap: 16px;
			margin-top: 8px;
		}
		.fan {
			--k: 1;
			justify-content: center;
			padding-left: 0;
		}
		.fan :global(.card:nth-child(n + 2)) {
			margin-left: -28px;
		}
		.hero h2 {
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
