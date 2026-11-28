<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { tableCardUrls } from '../card-assets.ts';
	import ConnectionStatus from '../components/ConnectionStatus.svelte';
	import PlayingCard from '../components/PlayingCard.svelte';
	import type {
		BotOption,
		HandDetail,
		RelationKind,
		ReportReason,
		TableView
	} from '../protocol-v2.ts';
	import ActionPanel from './ActionPanel.svelte';
	import { fetchConfig, fetchHand, findHand } from './api.ts';
	import { describeEvent, potLines } from './bet.ts';
	import type { NlConnection } from './connection.svelte.ts';
	import { chipFor } from './faces.ts';
	import { inviteLink as inviteLinkFor } from './lobby.ts';
	import HandReplay from './HandReplay.svelte';
	import { betClass, clockLeft, placeClass, sideClass } from './layout.ts';
	import NlSeat from './NlSeat.svelte';
	import NlVoice from './NlVoice.svelte';
	import { REACTIONS, REPORT_REASONS, VOICE_REPORT_NOTE, relationText } from './safety.ts';
	import { TableVoice } from './voice.svelte.ts';
	import './seat-places.css';

	let { view, connection }: { view: TableView; connection: NlConnection } = $props();

	// Table voice (P4C.6): offered to people seated with someone else, never at practice tables.
	const voice = new TableVoice();
	$effect(() => voice.update(view, connection.relations));
	onDestroy(() => voice.destroy());
	if (typeof window !== 'undefined') {
		(window as unknown as { rivermindVoice?: () => unknown }).rivermindVoice = () =>
			voice.diagnostics();
	}

	// Fetch the faces and the back, so no card pops in mid-deal.
	$effect(() => {
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
		result ? potLines(result, nameOf).map((text, i) => ({ key: i, text })) : []
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

	// Reviewing a finished hand without leaving the table (P6.1). The replay takes
	// the hand log's place beside the table, or sits above the table on an upright
	// screen, so the felt, the clocks and the action panel stay where they are
	// and the next hand can be played with a review open. The settled result
	// offers “Review hand” in the dock, and the hand log “Review last hand”: the
	// seat tools have no room for it on a phone without pushing the table down.
	let review = $state<HandDetail | null>(null);
	let reviewLoading = $state(false);
	let reviewPanel = $state<HTMLElement>();
	let reviewHead = $state<HTMLElement>();
	let reviewButton = $state<HTMLButtonElement>();
	/** Whether the viewer was dealt into the hand on the felt, so it is among their hands. */
	const dealtIn = $derived(
		hand !== null &&
			mine !== null &&
			(hand.posts.some((post) => post.seat === mine) ||
				hand.actions.some((action) => action.seat === mine) ||
				(result?.net[mine] ?? 0) !== 0)
	);
	/** A hand has finished at this table, so there may be one of the viewer's to review. */
	const reviewable = $derived(hand !== null && (result !== null || hand.hand_no > 1));
	const reviewClock = $derived(review && myTurn && view.turn ? clockLeft(view.turn, now) : null);

	/** Open hand `handNo` of this table, or the viewer's newest hand here. */
	async function openReview(handNo: number | null) {
		if (reviewLoading) return;
		reviewLoading = true;
		try {
			const handId = await findHand(view.table_id, handNo);
			if (handId === null) {
				connection.notify(
					handNo === null
						? 'You have not finished a hand at this table yet.'
						: `You were not dealt into hand #${handNo}, so it is not among your hands.`
				);
				return;
			}
			review = await fetchHand(handId);
			await tick();
			// Give the replay the keyboard, and scroll only as far as its heading: on a
			// wide screen that is no scrolling at all, so the action panel stays in view.
			reviewPanel?.focus({ preventScroll: true });
			reviewHead?.scrollIntoView({ block: 'nearest' });
		} catch (e) {
			connection.notify(`Could not open the hand: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			reviewLoading = false;
		}
	}

	function closeReview() {
		review = null;
		reviewButton?.focus({ preventScroll: true });
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
	// A menu that opens from the bar lies over the table at every size, so opening one
	// never moves the table or the seats under the pointer.
	const popover =
		'absolute top-[calc(100%+4px)] left-0 z-7 p-4 [box-shadow:0_0_0_1px_var(--edge),var(--elevation-3)] phone:inset-x-0 phone:w-auto';
	const bet =
		'bet absolute z-2 flex -translate-1/2 animate-pop items-center gap-3 rounded-full bg-[rgb(12_13_21/0.94)] py-1 pr-4 pl-2 text-s whitespace-nowrap text-paper phone:gap-[3px] phone:py-0 phone:pr-2 phone:pl-1 phone:text-xs';
	// A seat nobody is in: a dashed outline on the felt, and a button when the viewer may take it.
	const emptySeat =
		'empty absolute -translate-1/2 border-2 border-dashed bg-[rgb(12_13_21/0.35)] px-5 py-2 text-s rounded-[10px] phone:px-3 phone:py-1';
	const empty = `${emptySeat} phone:text-xs`;
	const openSeat = `${emptySeat} open z-3 cursor-pointer border-gold text-gold-light enabled:hover:bg-[rgb(12_13_21/0.7)] enabled:hover:outline-2 enabled:hover:outline-gold-light focus-visible:bg-[rgb(12_13_21/0.7)] focus-visible:outline-2 focus-visible:outline-gold-light disabled:cursor-default disabled:opacity-60`;

	let sharing = $state(false);
	let copied = $state(false);
	const inviteLink = $derived(view.invite ? inviteLinkFor(location.origin, view.invite) : null);
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

<svelte:window onkeydown={voice.keydown} onkeyup={voice.keyup} />

<!-- Wide screens: the table on the left; the action dock, the seat tools and the hand log in a
     column on the right, narrower on a laptop (`lap:`). Narrow landscape screens (`tall:`): one
     column, the seat tools above the table so they never move, and the dock pinned to the bottom.

     A phone or a tablet held upright (`phone:`) shows the game on its first screen and the rest
     below it. What stands above the table (`--above`: the bar and, on a tablet, the site header),
     the table and a zone as tall as the action panel (`--zone`) add up to the small viewport, the
     one the browser leaves with its toolbars showing, so nothing is cut off on arriving and the
     table never changes size. The dock is the last row and sticks to the bottom of the screen:
     waiting, it is a strip under the seat tools, which sit at the top of the zone; on the viewer's
     turn the panel rises over the zone and stops at the table's edge. The hand log and the
     play-money note follow below the first screen. A phone alone (`pocket:`) has no site header
     and shortens the bar's labels. -->
<section
	class="nl-table grid grid-cols-[minmax(0,1fr)_360px] grid-rows-[auto_auto_auto_1fr_auto] items-start gap-x-8 gap-y-6 lap:grid-cols-[minmax(0,1fr)_300px] tall:grid-cols-1 tall:grid-rows-none phone:gap-4 phone:[--above:132px] phone:[--zone:calc(176px_+_env(safe-area-inset-bottom))] pocket:[--above:calc(max(4px,env(safe-area-inset-top))_+_56px)] pocket:[--zone:calc(172px_+_env(safe-area-inset-bottom))]"
	class:my-turn={myTurn}
	aria-label="Table"
>
	<div
		class="bar relative z-6 col-span-full row-1 flex min-h-24 flex-wrap items-center gap-6 phone:min-h-20 phone:gap-4 pocket:gap-2"
	>
		{#if me}
			<button
				type="button"
				class="ui-btn small leave phone:px-1"
				onclick={() => connection.leave()}
			>
				<span aria-hidden="true">←</span>
				<span>Leave<span class="pocket:sr-only">&#32;table</span></span>
			</button>
		{:else}
			<button
				type="button"
				class="ui-btn small leave phone:px-1"
				onclick={() => connection.leave()}
			>
				<span aria-hidden="true">←</span> Lobby
			</button>
		{/if}
		{#if inviteLink}
			<button
				type="button"
				class="ui-btn small"
				aria-expanded={sharing}
				onclick={() => (sharing = !sharing)}
			>
				Invite
			</button>
		{/if}
		{#if voice.phase !== 'idle'}
			<NlVoice {voice} />
		{/if}
		{#if view.practice}
			<span
				class="practice-tag bg-gold px-4 py-1 text-s whitespace-nowrap text-ink rounded-full [box-shadow:var(--elevation-1)]"
				title="Practice chips: your wallet is not touched"
			>
				Practice
			</span>
		{/if}
		<div
			class="meta flex-1 text-center text-mist capitalize text-shadow-ink phone:text-s pocket:min-w-0 pocket:truncate"
		>
			{#if hand}<span class="pocket:sr-only">Hand&#32;</span>#{hand.hand_no} · {hand.street}{:else}Waiting
				for players{/if}
		</div>
		<div
			class="stakes ml-auto flex items-center gap-3 text-paper-shade text-shadow-ink phone:text-s"
			aria-label="Blinds"
		>
			<span class="sprite chip chip-red size-7 pocket:hidden" aria-hidden="true"></span>{view
				.settings.small_blind}/{view.settings.big_blind}
		</div>
		<!-- A phone has no site header at a table, so its connection lamp is here. -->
		<span class="lamp hidden pocket:inline-flex">
			<ConnectionStatus status={connection.status} />
		</span>
		{#if sharing && inviteLink}
			<div
				class="share ui-inset {popover} flex w-[min(100%,560px)] flex-wrap items-center gap-4"
				role="group"
				aria-label="Invite link"
			>
				<label class="min-w-0 flex-[1_1_260px]">
					<span class="sr-only">Invite link</span>
					<input
						class="ui-field w-full"
						type="text"
						readonly
						value={inviteLink}
						onfocus={(e) => e.currentTarget.select()}
					/>
				</label>
				<button type="button" class="ui-btn small amber" onclick={copyInvite}>
					{copied ? 'Copied' : 'Copy'}
				</button>
				<span class={note}>This private table is not listed: anyone with the link can join.</span>
			</div>
		{/if}
		{#if picked !== null && pickedInfo}
			<div
				class="player-menu ui-inset {popover} grid w-[min(100%,460px)] gap-4 text-mist"
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
						class="ui-btn small"
						aria-pressed={pickedRelation === 'mute'}
						disabled={busy}
						onclick={() => toggle('mute')}
					>
						{pickedRelation === 'mute' ? 'Unmute' : 'Mute'}
					</button>
					<button
						type="button"
						class="ui-btn small red"
						aria-pressed={pickedRelation === 'block'}
						disabled={busy}
						onclick={() => toggle('block')}
					>
						{pickedRelation === 'block' ? 'Unblock' : 'Block'}
					</button>
					<button type="button" class="ui-btn small" onclick={() => (picked = null)}>Close</button>
				</div>
				<p class="hint text-s text-paper-shade">
					Muting hides their reactions. Blocking also keeps quick seat from seating you together.
				</p>
				{#if voice.inVoice && pickedInfo.ref}
					{@const ref = pickedInfo.ref}
					<div
						class="menu-row voice-row flex flex-wrap items-center gap-4"
						role="group"
						aria-label="Voice"
					>
						<button
							type="button"
							class={['ui-btn small', voice.isMuted(ref) && 'red']}
							aria-pressed={voice.isMuted(ref)}
							onclick={() => voice.toggleMute(ref)}
						>
							Mute voice
						</button>
						<label class="flex items-center gap-3 text-s">
							Volume
							<input
								type="range"
								class="ui-range w-80"
								min="0"
								max="200"
								step="5"
								value={Math.round(voice.volumeOf(ref) * 100)}
								aria-valuetext="{Math.round(voice.volumeOf(ref) * 100)}%"
								oninput={(e) => voice.setVolume(ref, Number(e.currentTarget.value) / 100)}
							/>
							<span class="w-20 text-right">{Math.round(voice.volumeOf(ref) * 100)}%</span>
						</label>
					</div>
				{/if}
				<form
					class="menu-row flex flex-wrap items-center gap-4"
					onsubmit={(e) => {
						e.preventDefault();
						sendReport();
					}}
				>
					<label>
						<span class="sr-only">Reason</span>
						<select class="ui-field" bind:value={reason}>
							{#each REPORT_REASONS as option (option.reason)}
								<option value={option.reason}>{option.text}</option>
							{/each}
						</select>
					</label>
					<button type="submit" class="ui-btn small amber" disabled={busy}>Report</button>
				</form>
				{#if reason === 'voice'}<p class="hint text-s text-paper-shade" data-report="voice">
						{VOICE_REPORT_NOTE}
					</p>{/if}
				{#if reported}<p class={note} role="status">{reported}</p>{/if}
			</div>
		{/if}
	</div>

	<!-- The arena leaves room around the felt for the seats on its rail. On a phone or an upright
	     tablet it is what the first screen has left, and never shorter than nine pods and the board
	     need; its foot holds the viewer's seat, which hangs below the felt. -->
	<div
		class="arena col-1 row-[2/5] px-37 pt-32 pb-54 seats-{count} lap:px-33 lap:pt-30 lap:pb-48 {review
			? 'tall:row-4 phone:row-3'
			: 'tall:row-3 phone:row-2'} phone:h-[calc(100svh_-_var(--above)_-_var(--zone))] phone:max-h-[calc((100vw_-_8px)_*_1.45_+_68px)] phone:min-h-[424px] phone:px-0 phone:pt-0 phone:pb-34 tab:pb-46"
	>
		<div
			class="stage relative mx-auto aspect-[21/10] w-[min(100%,calc((100dvh-340px)*2.1))] min-h-[min(420px,calc(100dvh-350px))] min-w-[min(100%,560px)] [--seat-clear:calc(var(--seat-w)/2_+_50px)] [--board-above:82px] [--board-below:86px] [--seat-drop:88px] [--tag-level:64px] [--tag-side:92px] [--seat-w:clamp(176px,13.2vw,190px)] lap:aspect-[18/10] lap:[--board-above:63px] lap:[--board-below:67px] lap:[--seat-w:150px] lap:min-h-[min(400px,calc(100dvh-330px))] lap:w-[min(100%,calc((100dvh-330px)*1.8))] lap:min-w-[min(100%,480px)] tall:aspect-[16/10] tall:min-h-0 tall:w-[min(100%,calc((100dvh-520px)*1.6))] tall:min-w-[min(100%,520px)] phone:aspect-auto phone:h-full phone:w-full phone:min-w-0 phone:[--pod-drop:60px] phone:[--pod-lift:-34px] tab:[--pod-drop:78px] tab:[--pod-lift:-44px]"
		>
			<div class="felt ui-table absolute inset-0 lap:[--table-unit:2px]" aria-hidden="true"></div>
			<div
				class="centre absolute top-[48%] left-1/2 z-1 grid -translate-1/2 justify-items-center gap-4 text-center [--k:1.4] lap:[--k:1] phone:top-1/2 phone:gap-3 tab:[--k:1.4] pocket:top-[51.5%]"
			>
				<div class="pot-line flex min-h-16 items-center gap-5">
					{#if hand && !result}
						<span class="sprite pot-pile" aria-hidden="true"></span>
						<span class="pot text-gold-light text-shadow-ink">Pot {hand.pot}</span>
					{/if}
				</div>
				<!-- On a phone the board's places overlap by 6px; that much is cut off each
				     empty slot's drawn edge, so the row reads as single edges, as the replay's does. -->
				<div
					class="board flex gap-4 lap:gap-2 phone:gap-0 phone:[&>.card+.card]:-ml-3 phone:[&>.card+.slot]:[clip-path:inset(0_0_0_6px)]"
					aria-label="Board"
				>
					{#each board as card, i (i)}
						<PlayingCard {card} />
					{/each}
				</div>
				<div
					class="result min-h-14 text-gold text-shadow-ink phone:max-w-[300px] phone:text-s pocket:max-w-[calc(100vw-208px)]"
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
						voice={voice.seat(seat, info.ref, seat === mine)}
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
			'dock col-2 row-2 grid min-h-98 content-start tall:sticky tall:bottom-0 tall:z-5 tall:col-1 tall:min-h-0 tall:pb-[env(safe-area-inset-bottom)] phone:row-6',
			review ? 'tall:row-5' : 'tall:row-4',
			myTurn && 'tall:bg-[linear-gradient(to_bottom,transparent,var(--color-night)_12px)]'
		]}
	>
		{#if !me}
			<div
				class="join ui-inset grid justify-items-center gap-5 px-6 pt-5 pb-6 text-center text-mist"
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
								class="ui-field w-65 text-right"
								type="number"
								inputmode="numeric"
								min={view.settings.min_buy_in}
								max={view.settings.max_buy_in}
								step="1"
								bind:value={buyIn}
							/>
						</label>
						<button type="submit" class="ui-btn amber" disabled={short || !connection.connected}>
							Sit down
						</button>
						<button
							type="button"
							class="ui-btn small"
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
						class="ui-btn small"
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
						class="ui-btn small"
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
							class="ui-btn amber"
							disabled={seating || short}
							onclick={() => seatTask(() => connection.takeSeat(view.table_id))}
						>
							Sit down
						</button>
					{:else}
						<button
							type="button"
							class="ui-btn amber"
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
				class="waiting refill ui-inset grid min-h-32 place-items-center gap-4 px-6 py-4 text-center text-mist phone:min-h-28 phone:text-s"
				role="group"
				aria-label="Out of practice chips"
			>
				<p role="status">You are out of practice chips.</p>
				<button
					type="button"
					class="ui-btn amber"
					disabled={!connection.connected}
					onclick={() => connection.refill()}
				>
					Play again with {view.settings.max_buy_in.toLocaleString('en-US')} chips
				</button>
				{#if result && hand && dealtIn}
					<button
						type="button"
						class="ui-btn small"
						disabled={reviewLoading}
						onclick={() => openReview(hand.hand_no)}
					>
						Review hand
					</button>
				{/if}
			</div>
		{:else}
			<div
				class="waiting ui-inset flex min-h-32 flex-wrap items-center justify-center gap-x-6 gap-y-2 px-6 py-2 text-center text-mist phone:min-h-28 phone:py-0 phone:text-s"
			>
				<p role="status">
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
				{#if result && hand && dealtIn}
					<button
						type="button"
						class="ui-btn small"
						disabled={reviewLoading}
						onclick={() => openReview(hand.hand_no)}
					>
						Review hand
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if me}
		<div
			class="tools col-2 row-3 flex flex-wrap items-center justify-center gap-4 tall:col-1 tall:row-2 tall:justify-start phone:min-h-(--zone) phone:content-start phone:justify-center phone:gap-3 phone:pt-2 {review
				? 'phone:row-4'
				: 'phone:row-3'}"
		>
			{#if view.you.sitting_out || view.you.sitting_out_next}
				<button type="button" class="ui-btn small green" onclick={() => connection.sitIn()}>
					I’m back
				</button>
			{:else}
				<button type="button" class="ui-btn small" onclick={() => connection.sitOut()}>
					<span>Sit out<span class="pocket:sr-only">&#32;next hand</span></span>
				</button>
			{/if}
			{#if view.practice && opponents.length > 1}
				<button
					type="button"
					class="ui-btn small"
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
						class="opponents order-last flex flex-[1_1_100%] flex-wrap justify-center gap-3 tall:justify-start phone:justify-center"
						role="group"
						aria-label="Practice opponent"
					>
						{#each opponents as option (option.kind)}
							<button
								type="button"
								class="ui-btn small"
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
				class="ui-btn small"
				aria-expanded={reacting}
				aria-controls="reactions"
				onclick={() => (reacting = !reacting)}
			>
				React
			</button>
			<!-- React stands beside the first button, and the rebuy after them: where the row is
			     too narrow for all three, the amount and its button wrap together. The rows a
			     button opens come last, whatever opened them. -->
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
							class="ui-field w-60 text-right phone:min-h-20 phone:w-42"
							type="number"
							inputmode="numeric"
							min="1"
							max={rebuyRoom}
							step="1"
							bind:value={rebuyAmount}
						/>
					</label>
					<button type="submit" class="ui-btn small">Rebuy</button>
				</form>
			{/if}
			{#if view.you.pending_rebuy}
				<span class={note}>+{view.you.pending_rebuy} after this hand</span>
			{/if}
			{#if reacting}
				<div
					id="reactions"
					class="reactions order-last flex flex-[1_1_100%] flex-wrap justify-center gap-3 tall:justify-start phone:justify-center pocket:flex-nowrap pocket:justify-start pocket:overflow-x-auto"
					role="group"
					aria-label="Reactions"
				>
					{#each REACTIONS as option (option.kind)}
						<button
							type="button"
							class="ui-btn small"
							disabled={!connection.connected}
							onclick={() => connection.react(option.kind)}
						>
							{option.text}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{:else}
		<!-- The zone is kept for someone watching too: the offer of a seat stands in it. -->
		<div
			class="zone hidden phone:block phone:min-h-(--zone) {review ? 'phone:row-4' : 'phone:row-3'}"
			aria-hidden="true"
		></div>
	{/if}

	{#if review}
		<section
			class="review ui-inset col-2 row-4 grid content-start gap-4 self-start p-4 tall:col-1 tall:row-3 phone:row-2"
			aria-label="Hand review"
			tabindex="-1"
			bind:this={reviewPanel}
		>
			<div class="grid scroll-mt-4 gap-1" bind:this={reviewHead}>
				<div class="flex items-center justify-between gap-4">
					<h2 class="text-m text-gold text-shadow-ink">Hand #{review.hand.hand_no}</h2>
					<button type="button" class="ui-btn small" onclick={closeReview}>Close</button>
				</div>
				<!-- Always one line, so the steps below never move when the turn comes round. -->
				<p class="min-h-[21px] truncate text-s text-paper-shade">
					{#if reviewClock}
						<span class="text-gold-light" role="status">Your turn at the table</span>
						<span aria-hidden="true">
							· {reviewClock.bank ? 'time bank ' : ''}{reviewClock.seconds}s
						</span>
					{:else}
						{review.hand.practice ? 'Practice · ' : ''}Blinds {review.hand.small_blind}/{review.hand
							.big_blind}
					{/if}
				</p>
			</div>
			<HandReplay detail={review} />
		</section>
	{:else}
		<section
			class="log ui-inset col-2 row-4 max-h-[440px] min-h-60 self-stretch overflow-auto p-4 lap:max-h-[360px] tall:col-1 tall:row-5 tall:max-h-[220px] phone:row-4 phone:max-h-none"
			aria-label="Hand log"
		>
			<div class="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<h2 class="text-m text-gold text-shadow-ink">Hand log</h2>
				{#if me}
					<button
						type="button"
						class="ui-btn small"
						title={reviewable ? undefined : 'No hand has finished here yet'}
						disabled={!reviewable || reviewLoading}
						bind:this={reviewButton}
						onclick={() => openReview(result && hand && dealtIn ? hand.hand_no : null)}
					>
						Review last hand
					</button>
				{/if}
			</div>
			<ol class="grid gap-2 text-s text-mist">
				{#each lines as line (line.seq)}<li class="first:text-paper">{line.text}</li>{/each}
			</ol>
		</section>
	{/if}
	<p class="play-money col-span-full row-5 text-center text-s text-haze tall:row-6 phone:row-5">
		Play chips only: they can never be bought, sold or cashed out.
	</p>
</section>
