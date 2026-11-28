<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import PlayingCard from '../components/PlayingCard.svelte';
	import type { BotOption, ConfigResponse, TableSummary } from '../protocol-v2.ts';
	import { fetchConfig, fetchInvite } from './api.ts';
	import type { NlConnection } from './connection.svelte.ts';
	import { avatarClass, championLine, seatsNote } from './faces.ts';
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

	const legend = 'mb-4 block px-1 text-gold text-shadow-ink';
	const fieldLabel = 'field-label mb-4 block text-gold text-shadow-ink';
	// A choice is a radio button hidden behind the kit button that is its face.
	const radio = 'absolute size-px opacity-0';
	const opponent =
		'ui-btn choice w-full cursor-pointer justify-start gap-6 px-4 py-3 text-left whitespace-normal';
	const opponentNote = 'note text-s text-mist text-shadow-none group-has-checked:text-amber-deep';

	let practising = $state(false);
	let practiceError = $state('');

	// Practice (P6.0b): one click to a heads-up hand against RiverMind Easy,
	// with practice chips, whatever the wallet holds. A trained bot the server
	// offers is one more click away (P5.7a).
	async function practice(bot: string | null = null) {
		practising = true;
		practiceError = '';
		try {
			await connection.practice(bot);
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
		medium: 'Half Hard, half Easy.',
		hard: 'Trained by self-play.',
		calling_station: 'Calls almost anything.',
		random: 'Does whatever it likes.'
	};
	/** A bot's note, with the table sizes it plays when it does not play them all. */
	function botNote(bot: BotOption): string {
		const note = BOT_NOTES[bot.kind] ?? '';
		return bot.seats ? `${note} ${seatsNote(bot.seats)}`.trim() : note;
	}
	/** The trained bots to practise against: those that play two seats, from the easiest up. */
	const trained = $derived(
		(config?.bots ?? []).filter((b) => b.champion && (!b.seats || b.seats.includes(2)))
	);
	/** What a trained bot is, before its published result (D-7). */
	const TRAINED_NOTES: Record<string, string> = {
		medium: 'plays half its hands as RiverMind Hard and half as RiverMind Easy.',
		hard: 'is a trained bot.'
	};
	/** The bots that play a table of the chosen size. */
	const offered = $derived((config?.bots ?? []).filter((b) => !b.seats || b.seats.includes(seats)));
	// A bot that does not play the chosen size gives way to RiverMind Easy.
	$effect(() => {
		if (config && bots !== 'none' && !offered.some((b) => b.kind === bots)) {
			bots = offered.find((b) => b.kind === 'heuristic')?.kind ?? offered[0]?.kind ?? 'none';
		}
	});

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

<div
	class="lobby mt-[4vh] grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-start gap-16 lt-800:mt-4 lt-800:grid-cols-1 lt-800:gap-8"
>
	<section class="hero grid content-start gap-8" aria-labelledby="game-title">
		<!-- Three cards fanned from the bottom centre, the middle one raised in front. -->
		<div
			class="fan flex pt-4 pb-2 pl-6 [--k:1.4] lt-800:justify-center lt-800:pl-0 lt-800:[--k:1] [&>.card]:origin-bottom [&>.card:nth-child(1)]:[transform:rotate(-8deg)] [&>.card:nth-child(2)]:z-1 [&>.card:nth-child(2)]:[transform:translateY(-10px)] [&>.card:nth-child(3)]:[transform:rotate(8deg)] [&>.card:nth-child(n+2)]:-ml-20 lt-800:[&>.card:nth-child(n+2)]:-ml-14"
			aria-hidden="true"
		>
			<PlayingCard card={{ rank: 14, suit: 'spades' }} />
			<PlayingCard card={{ rank: 13, suit: 'hearts' }} />
			<PlayingCard card={null} />
		</div>
		<h2
			id="game-title"
			class="text-xl text-gold text-shadow-title lt-800:text-center lt-800:text-l"
		>
			No-limit hold’em
		</h2>
		<p class="intro text-mist lt-800:text-center lt-800:text-s">
			Play money only: chips can never be bought, sold or cashed out, and have no value. Every bot
			is labelled as a bot.
		</p>
		<!-- First on the page: someone who followed a friend's link came for this, and on a
		     phone anything below practice is a screen away. -->
		{#if invited}
			<section class="invite ui-gold grid gap-5 px-6 pt-5 pb-6" aria-labelledby="invite-title">
				<h3 id="invite-title" class="text-l text-gold text-shadow-ink">You are invited</h3>
				<p>
					{invited.name}: blinds {invited.small_blind}/{invited.big_blind}, {invited.people}
					{invited.people === 1 ? 'person' : 'people'} seated.
				</p>
				{#if invited.waitlist_position !== null}
					<p>You are number {invited.waitlist_position} in line for a seat.</p>
				{:else}
					<button
						type="button"
						class="ui-btn amber"
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
		{#if inviteError}<p class="error text-red-light" role="alert">{inviteError}</p>{/if}
		<section class="practice ui-panel grid gap-4 px-7 py-6" aria-labelledby="practice-title">
			<h3 id="practice-title" class="sr-only">Practice</h3>
			<button
				type="button"
				class="ui-btn amber practice-start min-h-32 w-full text-l"
				disabled={practising}
				onclick={() => practice()}
			>
				{practising ? 'Dealing…' : 'Practice vs bots'}
			</button>
			<p class="note text-s text-mist">
				Heads-up against the RiverMind Easy bot with {(
					config?.practice_stack ?? 10000
				).toLocaleString('en-US')} practice chips. Your wallet is not touched, and you get a fresh stack
				whenever you run out.
			</p>
			{#each trained as bot (bot.kind)}
				<div class="trained ui-inset grid gap-4 px-5 py-4" role="group" aria-label={bot.label}>
					<div class="flex items-start gap-5">
						<span
							class="sprite avatar {avatarClass({ kind: 'bot', bot: bot.kind, name: '' })}"
							aria-hidden="true"
						></span>
						<p class="note text-s text-mist">
							<strong class="text-gold text-shadow-ink">{bot.label}</strong>
							{TRAINED_NOTES[bot.kind] ?? TRAINED_NOTES.hard}
							{bot.champion ? championLine(bot.champion) : ''}
							<a class="text-gold-light" href={resolve('/bots')}>How it was measured</a>
						</p>
					</div>
					<!-- The label wraps where it must: in a wide system font (DejaVu Sans on Linux)
					     "Practice vs RiverMind Medium" is wider than a 375px phone leaves it. -->
					<button
						type="button"
						class="ui-btn blue practice-trained w-full whitespace-normal text-center"
						disabled={practising}
						onclick={() => practice(bot.kind)}
					>
						Practice vs {bot.label}
					</button>
				</div>
			{/each}
			{#if practiceError}<p class="error text-red-light" role="alert">{practiceError}</p>{/if}
		</section>
		{#if balance !== null}
			<p class="wallet ui-inset grid gap-1 px-6 py-4" role="status" aria-live="polite">
				<span class="label text-mist">Your play chips</span>
				<span class="amount flex items-center gap-5 text-l text-gold text-shadow-ink">
					<span class="sprite chip chip-gold" aria-hidden="true"></span>
					<strong>{balance.toLocaleString('en-US')}</strong>
				</span>
				<span class="hint text-s text-haze">
					New players start with 20,000; below 10,000, a visit tops you up once a day.
				</span>
			</p>
		{/if}
		<nav class="links flex flex-wrap gap-4" aria-label="More">
			<a class="ui-btn small" href={resolve('/hands')}>Your hands</a>
			<a class="ui-btn small" href={resolve('/fairness')}>Rules and fair dealing</a>
			<a class="ui-btn small" href={resolve('/bots')}>The bots</a>
		</nav>
		{#if message}<p class="closed ui-panel px-5 py-3 text-mist" role="status">{message}</p>{/if}
	</section>

	<div class="side grid min-w-0 gap-8">
		<LobbyTables {connection} {config} {balance} />

		<section class="setup ui-panel px-7 pt-6 pb-7" aria-labelledby="setup-title">
			<h2 id="setup-title" class="setup-title mb-6 text-l text-gold text-shadow-ink">
				Start a table
			</h2>
			<form class="grid gap-9" onsubmit={start}>
				<fieldset class="min-w-0">
					<legend class={legend}>Seats</legend>
					<div
						class="choices seats grid grid-cols-[repeat(8,1fr)] gap-3 lt-460:grid-cols-[repeat(4,1fr)]"
					>
						{#each config?.seat_counts ?? [2, 3, 4, 5, 6, 7, 8, 9] as count (count)}
							<label class="pick relative block">
								<input type="radio" class={radio} name="seats" value={count} bind:group={seats} />
								<span class="ui-btn choice w-full cursor-pointer">{count}</span>
							</label>
						{/each}
					</div>
				</fieldset>
				<fieldset class="min-w-0">
					<legend class={legend}>Opponents</legend>
					<div class="choices bots grid gap-4">
						{#each offered as bot (bot.kind)}
							<label class="pick bot group relative block">
								<input type="radio" class={radio} name="bots" value={bot.kind} bind:group={bots} />
								<span class={opponent}>
									<span
										class="sprite avatar {avatarClass({ kind: 'bot', bot: bot.kind, name: '' })}"
										aria-hidden="true"
									></span>
									<span class="text grid gap-2 leading-[1.15]">
										<span class="name">{bot.label}</span>
										{#if botNote(bot)}<span class={opponentNote}>
												{botNote(bot)}
											</span>{/if}
									</span>
								</span>
							</label>
						{/each}
						<label class="pick bot group relative block">
							<input type="radio" class={radio} name="bots" value="none" bind:group={bots} />
							<span class={opponent}>
								<span
									class="sprite avatar {avatarClass({ kind: 'human', bot: null, name: 'You' })}"
									aria-hidden="true"
								></span>
								<span class="text grid gap-2 leading-[1.15]">
									<span class="name">No bots</span>
									<span class={opponentNote}>Seats wait for people.</span>
								</span>
							</span>
						</label>
					</div>
					<p class="field-note mt-3 text-s text-haze">
						Bots give up their seats when people want them.
					</p>
				</fieldset>
				<label class="private flex cursor-pointer items-start gap-5 text-paper-shade">
					<input type="checkbox" class="mt-1 size-10 accent-gold" bind:checked={privateTable} />
					<span>
						Private table
						<span class="note block text-s text-mist">Not listed; share its invite link.</span>
					</span>
				</label>
				<div class="stakes grid grid-cols-[1fr_1.6fr] gap-6 lt-460:grid-cols-[1fr]">
					<label>
						<span class={fieldLabel}>Blinds</span>
						<select class="ui-field w-full" bind:value={bigBlind}>
							{#each config?.stakes ?? [] as stakes (stakes.big_blind)}
								<option value={stakes.big_blind}>{stakes.small_blind}/{stakes.big_blind}</option>
							{/each}
						</select>
					</label>
					<label>
						<span class={fieldLabel}>Buy-in</span>
						<select class="ui-field w-full" bind:value={buyInBlinds}>
							{#each BUY_INS as blinds (blinds)}
								<option value={blinds} disabled={!affordable.includes(blinds)}>
									{blinds * bigBlind} ({blinds} big blinds)
								</option>
							{/each}
						</select>
					</label>
				</div>
				{#if !affordable.length}
					<p class="short text-mist" role="status">
						Not enough play chips for these blinds. Pick lower blinds, or come back tomorrow for a
						top-up.
					</p>
				{/if}
				<button
					type="submit"
					class="ui-btn amber start min-h-32 text-l"
					disabled={starting || !config || !affordable.length}
				>
					{starting ? 'Dealing…' : 'Sit down'}
				</button>
			</form>
			{#if error}<p class="error mt-5 text-red-light" role="alert">{error}</p>{/if}
		</section>
	</div>
</div>
