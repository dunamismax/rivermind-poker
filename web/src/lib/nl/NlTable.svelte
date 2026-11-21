<script lang="ts">
	import { onMount } from 'svelte';
	import { tableCardUrls } from '../card-assets.ts';
	import PlayingCard from '../components/PlayingCard.svelte';
	import type { BotOption, RelationKind, ReportReason, TableView } from '../protocol-v2.ts';
	import ActionPanel from './ActionPanel.svelte';
	import { fetchConfig } from './api.ts';
	import { describeEvent } from './bet.ts';
	import type { NlConnection } from './connection.svelte.ts';
	import { chipFor } from './faces.ts';
	import { betClass, placeClass, sideClass } from './layout.ts';
	import NlSeat from './NlSeat.svelte';
	import { REACTIONS, REPORT_REASONS, relationText } from './safety.ts';
	import './seat-places.css';

	let { view, connection }: { view: TableView; connection: NlConnection } = $props();

	// Fetch the faces and the back once, so no card pops in mid-deal.
	onMount(() => {
		for (const src of tableCardUrls()) new Image().src = src;
	});

	// The turn clocks tick on the local clock, shifted to the server's.
	let localNow = $state(Date.now() / 1000);
	$effect(() => {
		const timer = setInterval(() => (localNow = Date.now() / 1000), 250);
		return () => clearInterval(timer);
	});
	const now = $derived(localNow - connection.clockOffset);

	const count = $derived(view.settings.seat_count);
	const mine = $derived(view.you.seat);
	const me = $derived(mine === null ? null : view.seats[mine]);
	const hand = $derived(view.hand);
	const result = $derived(hand?.result ?? null);
	const inHand = $derived(hand !== null && result === null);
	const nameOf = (seat: number) => view.seats[seat]?.name ?? `Seat ${seat + 1}`;
	const board = $derived(Array.from({ length: 5 }, (_, i) => hand?.board[i]));
	const lines = $derived(
		connection.log
			.map((event) => ({
				seq: event.seq,
				text: describeEvent(event, (seat) => event.who ?? nameOf(seat))
			}))
			.filter((line): line is { seq: number; text: string } => line.text !== null)
			.slice(-30)
			.reverse()
	);
	const winners = $derived(
		result
			? result.pots.map((pot, i) => ({
					key: i,
					text: `${pot.winners.map(nameOf).join(' and ')} ${pot.winners.length > 1 ? 'split' : 'wins'} ${pot.amount}${result.pots.length > 1 ? (i === 0 ? ' (main pot)' : ' (side pot)') : ''}`
				}))
			: []
	);
	const waitingFor = $derived(view.turn && view.turn.seat !== mine ? nameOf(view.turn.seat) : null);
	const myTurn = $derived(Boolean(view.you.legal && hand && view.turn));

	// At a practice table the guest can change opponents between hands (P5.7a):
	// RiverMind Easy, or a trained bot the server offers for two seats.
	let opponents = $state<BotOption[]>([]);
	onMount(() => {
		if (!view.practice) return;
		fetchConfig()
			.then((config) => {
				opponents = config.bots.filter(
					(b) => b.kind === 'heuristic' || (b.champion && (!b.seats || b.seats.includes(2)))
				);
			})
			.catch(() => {
				// The table plays on without the choice.
			});
	});
	const opponent = $derived(view.seats.find((seat) => seat?.kind === 'bot')?.bot ?? null);
	let choosing = $state(false);
	/** The kind asked for that has not sat down yet. */
	let asked = $state<string | null>(null);
	const arriving = $derived(
		asked !== null && asked !== opponent ? opponents.find((b) => b.kind === asked) : undefined
	);
	let opponentError = $state('');
	async function playAgainst(kind: string) {
		opponentError = '';
		choosing = false;
		try {
			asked = await connection.practice(kind);
		} catch (e) {
			asked = null;
			opponentError = `Could not change the opponent: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	let rebuyAmount = $state(0);
	const rebuyRoom = $derived(me ? view.settings.max_buy_in - me.stack - view.you.pending_rebuy : 0);
	$effect.pre(() => {
		if (rebuyAmount <= 0 || rebuyAmount > rebuyRoom) rebuyAmount = Math.max(0, rebuyRoom);
	});
	const busted = $derived(me !== null && me.stack === 0 && !inHand);

	// Seating from the table (P4.3): a spectator can hold an empty seat, take
	// any seat, or wait in line; a held seat waits for its player to buy in.
	const hold = $derived(view.you.hold);
	const holdAt = $derived(new Map(view.holds.map((h) => [h.seat, h])));
	const room = $derived(
		view.seats.some((info, seat) => !holdAt.has(seat) && (info === null || info.kind === 'bot'))
	);
	const holdLeft = $derived(hold?.until ? Math.max(0, Math.ceil(hold.until - now)) : null);
	const most = $derived(Math.min(view.settings.max_buy_in, connection.balance ?? Infinity));
	let buyIn = $state(0);
	$effect.pre(() => {
		const low = view.settings.min_buy_in;
		if (buyIn < low || buyIn > view.settings.max_buy_in) buyIn = Math.max(low, most);
	});
	const short = $derived(
		connection.balance !== null && connection.balance < view.settings.min_buy_in
	);
	let seating = $state(false);

	async function seatTask(task: () => Promise<unknown>) {
		seating = true;
		try {
			await task();
		} catch (e) {
			connection.notify(e instanceof Error ? e.message : String(e));
		} finally {
			seating = false;
		}
	}

	// Safety (P4.5): the menu for another person's seat, and the reactions row.
	let picked = $state<number | null>(null);
	const pickedInfo = $derived(picked === null ? null : view.seats[picked]);
	const pickedRelation = $derived(connection.relationOf(pickedInfo?.ref ?? null));
	let reason = $state<ReportReason>('abuse');
	let reported = $state<string | null>(null);
	let busy = $state(false);
	let reacting = $state(false);
	$effect.pre(() => {
		// The menu closes when its player leaves the seat.
		if (picked !== null && (!pickedInfo || pickedInfo.kind !== 'human')) picked = null;
	});

	function pick(seat: number) {
		reported = null;
		picked = picked === seat ? null : seat;
	}

	async function safetyTask(task: () => Promise<void>) {
		busy = true;
		try {
			await task();
		} catch (e) {
			connection.notify(e instanceof Error ? e.message : String(e));
		} finally {
			busy = false;
		}
	}

	function toggle(kind: RelationKind) {
		const seat = picked;
		const ref = pickedInfo?.ref;
		if (seat === null || !ref) return;
		void safetyTask(() =>
			pickedRelation === kind ? connection.unrelate(ref) : connection.relate(seat, kind)
		);
	}

	function sendReport() {
		const seat = picked;
		if (seat === null) return;
		void safetyTask(async () => {
			const recorded = await connection.report(seat, reason);
			reported = recorded
				? 'Thanks: the report was sent for review.'
				: 'You already reported this today; it counts once.';
		});
	}

	const note = 'note text-green-light text-shadow-ink';
	const bet =
		'bet absolute z-2 flex -translate-1/2 animate-pop items-center gap-3 bg-[rgb(12_13_21/0.72)] py-1 pr-4 pl-2 text-s whitespace-nowrap text-paper phone:gap-[3px] phone:py-0 phone:pr-2 phone:pl-1 phone:text-xs';
	// A seat nobody is in: a dashed outline on the felt, and a button when the viewer may take it.
	const emptySeat =
		'empty absolute -translate-1/2 border-2 border-dashed bg-[rgb(12_13_21/0.35)] px-5 py-2 text-s phone:px-3 phone:py-1';
	const empty = `${emptySeat} phone:text-xs`;
	const openSeat = `${emptySeat} open z-3 cursor-pointer border-gold text-gold-light enabled:hover:bg-[rgb(12_13_21/0.7)] enabled:hover:outline-2 enabled:hover:outline-gold-light focus-visible:bg-[rgb(12_13_21/0.7)] focus-visible:outline-2 focus-visible:outline-gold-light disabled:cursor-default disabled:opacity-60`;

	let sharing = $state(false);
	let copied = $state(false);
	const inviteLink = $derived(
		view.invite ? `${location.origin}/?invite=${encodeURIComponent(view.invite)}` : null
	);
	async function copyInvite() {
		if (!inviteLink) return;
		try {
			await navigator.clipboard.writeText(inviteLink);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// The field shows the link to copy by hand.
		}
	}
</script>

<!-- Wide screens: the table on the left; the action dock, the seat tools and the hand log in a
     column on the right, narrower on a laptop (`lap:`). Upright and narrow screens (`tall:`): one
     column, the seat tools above the table so they never move, and the dock pinned to the bottom. -->
<section
	class="nl-table grid grid-cols-[minmax(0,1fr)_360px] grid-rows-[auto_auto_auto_1fr_auto] items-start gap-x-8 gap-y-6 lap:grid-cols-[minmax(0,1fr)_300px] tall:grid-cols-1 tall:grid-rows-none phone:gap-4"
	class:my-turn={myTurn}
	aria-label="Table"
>
	<div
		class="bar col-span-full row-1 flex min-h-24 flex-wrap items-center gap-6 phone:min-h-20 phone:gap-4"
	>
		{#if me}
			<button
				type="button"
				class="px-btn small leave phone:px-1"
				onclick={() => connection.leave()}
			>
				<span aria-hidden="true">←</span> Leave table
			</button>
		{:else}
			<button
				type="button"
				class="px-btn small leave phone:px-1"
				onclick={() => connection.leave()}
			>
				<span aria-hidden="true">←</span> Lobby
			</button>
		{/if}
		{#if inviteLink}
			<button
				type="button"
				class="px-btn small"
				aria-expanded={sharing}
				onclick={() => (sharing = !sharing)}
			>
				Invite
			</button>
		{/if}
		{#if view.practice}
			<span
				class="practice-tag bg-gold px-4 py-1 text-s whitespace-nowrap text-ink [box-shadow:0_2px_0_var(--color-amber-deep)]"
				title="Practice chips: your wallet is not touched"
			>
				Practice
			</span>
		{/if}
		<div class="meta flex-1 text-center text-mist capitalize text-shadow-ink phone:text-s">
			{#if hand}Hand #{hand.hand_no} · {hand.street}{:else}Waiting for players{/if}
		</div>
		<div
			class="stakes ml-auto flex items-center gap-3 text-paper-shade text-shadow-ink phone:text-s"
			aria-label="Blinds"
		>
			<span class="sprite chip chip-red size-7" aria-hidden="true"></span>{view.settings
				.small_blind}/{view.settings.big_blind}
		</div>
		{#if sharing && inviteLink}
			<div
				class="share px-inset flex flex-[1_1_100%] flex-wrap items-center gap-4 p-4"
				role="group"
				aria-label="Invite link"
			>
				<label class="min-w-0 flex-[1_1_260px]">
					<span class="sr-only">Invite link</span>
					<input
						class="px-field w-full"
						type="text"
						readonly
						value={inviteLink}
						onfocus={(e) => e.currentTarget.select()}
					/>
				</label>
				<button type="button" class="px-btn small amber" onclick={copyInvite}>
					{copied ? 'Copied' : 'Copy'}
				</button>
				<span class={note}>This private table is not listed: anyone with the link can join.</span>
			</div>
		{/if}
		{#if picked !== null && pickedInfo}
			<div
				class="player-menu px-inset grid flex-[1_1_100%] gap-4 p-4 text-mist"
				role="dialog"
				aria-label="Player {pickedInfo.name}"
			>
				<p class="who-menu">
					<strong class="text-gold-light">{pickedInfo.name}</strong>{#if pickedRelation}<span
							class={note}
						>
							{` · ${relationText(pickedRelation)}`}
						</span>{/if}
				</p>
				<div class="menu-row flex flex-wrap items-center gap-4">
					<button
						type="button"
						class="px-btn small"
						aria-pressed={pickedRelation === 'mute'}
						disabled={busy}
						onclick={() => toggle('mute')}
					>
						{pickedRelation === 'mute' ? 'Unmute' : 'Mute'}
					</button>
					<button
						type="button"
						class="px-btn small red"
						aria-pressed={pickedRelation === 'block'}
						disabled={busy}
						onclick={() => toggle('block')}
					>
						{pickedRelation === 'block' ? 'Unblock' : 'Block'}
					</button>
					<button type="button" class="px-btn small" onclick={() => (picked = null)}>Close</button>
				</div>
				<p class="hint text-s text-paper-shade">
					Muting hides their reactions. Blocking also keeps quick seat from seating you together.
				</p>
				<form
					class="menu-row flex flex-wrap items-center gap-4"
					onsubmit={(e) => {
						e.preventDefault();
						sendReport();
					}}
				>
					<label>
						<span class="sr-only">Reason</span>
						<select class="px-field" bind:value={reason}>
							{#each REPORT_REASONS as option (option.reason)}
								<option value={option.reason}>{option.text}</option>
							{/each}
						</select>
					</label>
					<button type="submit" class="px-btn small amber" disabled={busy}>Report</button>
				</form>
				{#if reported}<p class={note} role="status">{reported}</p>{/if}
			</div>
		{/if}
	</div>

	<!-- The arena leaves room around the felt for the seats on its rail. -->
	<div
		class="arena col-1 row-[2/5] px-37 pt-32 pb-54 seats-{count} lap:px-33 lap:pt-30 lap:pb-48 tall:row-3 phone:px-0 phone:pt-0 phone:pb-32"
	>
		<div
			class="stage relative mx-auto aspect-[21/10] w-[min(100%,calc((100dvh-340px)*2.1))] min-w-[min(100%,560px)] lap:aspect-[18/10] lap:w-[min(100%,calc((100dvh-330px)*1.8))] lap:min-w-[min(100%,480px)] tall:aspect-[16/10] tall:w-[min(100%,calc((100dvh-520px)*1.6))] tall:min-w-[min(100%,520px)] phone:aspect-[3/4] phone:max-h-[calc(100dvh-380px)] phone:min-h-[420px] phone:w-full phone:min-w-0"
		>
			<div class="felt px-table absolute inset-0 lap:[--table-px:2px]" aria-hidden="true"></div>
			<div
				class="centre absolute top-[48%] left-1/2 z-1 grid -translate-1/2 justify-items-center gap-4 text-center [--k:1.4] lap:[--k:1] phone:top-1/2 phone:gap-3 tab:[--k:1.4]"
			>
				<div class="pot-line flex min-h-16 items-center gap-5">
					{#if hand && !result}
						<span class="sprite pot-pile" aria-hidden="true"></span>
						<span class="pot text-gold-light text-shadow-ink">Pot {hand.pot}</span>
					{/if}
				</div>
				<div class="board flex gap-4 phone:gap-0 phone:[&>.card+.card]:-ml-3" aria-label="Board">
					{#each board as card, i (i)}
						<PlayingCard {card} />
					{/each}
				</div>
				<div
					class="result min-h-14 text-gold text-shadow-ink phone:max-w-[300px] phone:text-s"
					role="status"
				>
					{#each winners as line (line.key)}<div>{line.text}</div>{/each}
				</div>
			</div>
			{#each view.seats as info, seat (seat)}
				{#if info}
					<NlSeat
						{info}
						place={placeClass(seat, mine, count)}
						side={sideClass(seat, mine, count)}
						me={seat === mine}
						button={hand?.button === seat}
						turn={inHand ? view.turn : null}
						{now}
						won={result ? (result.winnings[seat] ?? 0) : 0}
						reaction={connection.reactions[seat]?.text ?? null}
						relation={relationText(connection.relationOf(info.ref))}
						onselect={info.kind === 'human' && seat !== mine ? () => pick(seat) : undefined}
					/>
					{#if info.bet > 0 && !result}
						<div class="{bet} {betClass(seat, mine, count)}">
							<span
								class="sprite chip size-11 phone:size-7 {chipFor(
									info.bet,
									view.settings.big_blind
								)}"
								aria-hidden="true"
							></span>
							<span>Bet {info.bet}</span>
						</div>
					{/if}
				{:else if holdAt.has(seat)}
					<div class="held border-amber-dark text-amber {empty} {placeClass(seat, mine, count)}">
						{hold?.seat === seat ? 'Your seat' : 'Held'}
					</div>
				{:else if mine === null && !hold && view.you.waitlist_position === null}
					<button
						type="button"
						class="{openSeat} {placeClass(seat, mine, count)}"
						disabled={seating || short}
						onclick={() => seatTask(() => connection.holdSeat(seat))}
					>
						Sit here<span class="sr-only">, seat {seat + 1}</span>
					</button>
				{:else}
					<div
						class="border-felt-light text-haze {empty} {placeClass(seat, mine, count)}"
						aria-hidden="true"
					>
						Empty
					</div>
				{/if}
			{/each}
		</div>
	</div>

	<!-- The dock keeps its height whether or not it is the viewer's turn, so nothing below it moves
	     when the action panel opens. -->
	<div
		class={[
			'dock col-2 row-2 grid min-h-98 content-start tall:sticky tall:bottom-0 tall:z-5 tall:col-1 tall:row-4 tall:min-h-0 tall:pb-[env(safe-area-inset-bottom)]',
			myTurn && 'tall:bg-[linear-gradient(to_bottom,transparent,var(--color-night)_12px)]'
		]}
	>
		{#if !me}
			<div
				class="join px-inset grid justify-items-center gap-5 px-6 pt-5 pb-6 text-center text-mist"
				role="group"
				aria-label="Take a seat"
			>
				{#if hold?.ready}
					<p role="status">
						Seat {hold.seat + 1} is held for you{holdLeft !== null ? ` for ${holdLeft}s` : ''}. Buy
						in to sit down.
					</p>
					<form
						class="buy-in flex flex-wrap items-center justify-center gap-4"
						onsubmit={(e) => {
							e.preventDefault();
							connection.sit(hold!.seat, Math.floor(buyIn));
						}}
					>
						<label>
							<span class="sr-only">Buy-in</span>
							<input
								class="px-field w-65 text-right"
								type="number"
								inputmode="numeric"
								min={view.settings.min_buy_in}
								max={view.settings.max_buy_in}
								step="1"
								bind:value={buyIn}
							/>
						</label>
						<button type="submit" class="px-btn amber" disabled={short || !connection.connected}>
							Sit down
						</button>
						<button
							type="button"
							class="px-btn small"
							disabled={seating}
							onclick={() => seatTask(() => connection.giveUpHold())}
						>
							Give up
						</button>
					</form>
					<p class="hint text-s text-haze">
						Buy in for {view.settings.min_buy_in.toLocaleString('en-US')} to {view.settings.max_buy_in.toLocaleString(
							'en-US'
						)} play chips.
					</p>
				{:else if hold}
					<p role="status">Seat {hold.seat + 1} is yours when the bot there finishes this hand.</p>
					<button
						type="button"
						class="px-btn small"
						disabled={seating}
						onclick={() => seatTask(() => connection.giveUpHold())}
					>
						Give up the seat
					</button>
				{:else if view.you.waitlist_position !== null}
					<p role="status">
						You are number {view.you.waitlist_position} in line. A seat is held for you when one opens.
					</p>
					<button
						type="button"
						class="px-btn small"
						disabled={seating}
						onclick={() => seatTask(() => connection.leaveWaitlist(view.table_id))}
					>
						Leave the line
					</button>
				{:else}
					<p role="status">
						You are watching.{short ? ' You need more play chips to sit at this table.' : ''}
					</p>
					{#if room}
						<button
							type="button"
							class="px-btn amber"
							disabled={seating || short}
							onclick={() => seatTask(() => connection.takeSeat(view.table_id))}
						>
							Sit down
						</button>
					{:else}
						<button
							type="button"
							class="px-btn amber"
							disabled={seating || short}
							onclick={() => seatTask(() => connection.joinWaitlist(view.table_id))}
						>
							Join the waitlist
						</button>
					{/if}
				{/if}
			</div>
		{:else if view.you.legal && hand && view.turn}
			<ActionPanel
				legal={view.you.legal}
				{hand}
				turnSeq={view.turn.seq}
				disabled={!connection.connected || connection.pending}
				onact={(action, amount) => connection.act(action, amount)}
			/>
		{:else if busted && view.practice}
			<div
				class="waiting refill px-inset grid min-h-32 place-items-center gap-4 px-6 py-4 text-center text-mist phone:min-h-28 phone:text-s"
				role="group"
				aria-label="Out of practice chips"
			>
				<p role="status">You are out of practice chips.</p>
				<button
					type="button"
					class="px-btn amber"
					disabled={!connection.connected}
					onclick={() => connection.refill()}
				>
					Play again with {view.settings.max_buy_in.toLocaleString('en-US')} chips
				</button>
			</div>
		{:else}
			<p
				class="waiting px-inset grid min-h-32 place-items-center px-6 text-center text-mist phone:min-h-28 phone:text-s"
				role="status"
			>
				{#if busted}
					You are out of chips. Rebuy to keep playing.
				{:else if view.you.sitting_out}
					You are sitting out.
				{:else if waitingFor}
					Waiting for {waitingFor}…
				{:else if result}
					Next hand soon…
				{:else}
					&nbsp;
				{/if}
			</p>
		{/if}
	</div>

	{#if me}
		<div
			class="tools col-2 row-3 flex flex-wrap items-center justify-center gap-4 tall:col-1 tall:row-2 tall:justify-start phone:gap-3"
		>
			{#if view.you.sitting_out || view.you.sitting_out_next}
				<button type="button" class="px-btn small green" onclick={() => connection.sitIn()}>
					I’m back
				</button>
			{:else}
				<button type="button" class="px-btn small" onclick={() => connection.sitOut()}>
					Sit out next hand
				</button>
			{/if}
			{#if rebuyRoom > 0 && !me.leaving && !view.practice}
				<form
					class="rebuy flex items-center gap-3"
					onsubmit={(e) => {
						e.preventDefault();
						connection.rebuy(Math.floor(rebuyAmount));
					}}
				>
					<label>
						<span class="sr-only">Rebuy amount</span>
						<input
							class="px-field w-60 text-right phone:min-h-20 phone:w-42"
							type="number"
							inputmode="numeric"
							min="1"
							max={rebuyRoom}
							step="1"
							bind:value={rebuyAmount}
						/>
					</label>
					<button type="submit" class="px-btn small">Rebuy</button>
				</form>
			{/if}
			{#if view.you.pending_rebuy}
				<span class={note}>+{view.you.pending_rebuy} after this hand</span>
			{/if}
			{#if view.practice && opponents.length > 1}
				<button
					type="button"
					class="px-btn small"
					aria-expanded={choosing}
					aria-controls="opponents"
					onclick={() => (choosing = !choosing)}
				>
					Opponent
				</button>
				{#if arriving}
					<span class={note} role="status">{arriving.label} sits down after this hand</span>
				{/if}
				{#if opponentError}<span class="text-s text-red-light" role="alert">
						{opponentError}
					</span>{/if}
				{#if choosing}
					<div
						id="opponents"
						class="opponents flex flex-[1_1_100%] flex-wrap gap-3"
						role="group"
						aria-label="Practice opponent"
					>
						{#each opponents as option (option.kind)}
							<button
								type="button"
								class="px-btn small"
								aria-pressed={option.kind === (asked ?? opponent)}
								disabled={!connection.connected || option.kind === (asked ?? opponent)}
								onclick={() => playAgainst(option.kind)}
							>
								{option.label}
							</button>
						{/each}
					</div>
				{/if}
			{/if}
			<button
				type="button"
				class="px-btn small"
				aria-expanded={reacting}
				aria-controls="reactions"
				onclick={() => (reacting = !reacting)}
			>
				React
			</button>
			{#if reacting}
				<div
					id="reactions"
					class="reactions flex flex-[1_1_100%] flex-wrap gap-3"
					role="group"
					aria-label="Reactions"
				>
					{#each REACTIONS as option (option.kind)}
						<button
							type="button"
							class="px-btn small"
							disabled={!connection.connected}
							onclick={() => connection.react(option.kind)}
						>
							{option.text}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<section
		class="log px-inset col-2 row-4 max-h-[440px] min-h-60 self-stretch overflow-auto p-4 lap:max-h-[360px] tall:col-1 tall:row-5 tall:max-h-[220px]"
		aria-label="Hand log"
	>
		<h2 class="mb-3 text-m text-gold text-shadow-ink">Hand log</h2>
		<ol class="grid gap-2 text-s text-mist">
			{#each lines as line (line.seq)}<li class="first:text-paper">{line.text}</li>{/each}
		</ol>
	</section>
	<p class="play-money col-span-full row-5 text-center text-s text-haze tall:row-6">
		Play chips only: they can never be bought, sold or cashed out.
	</p>
</section>
