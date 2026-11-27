# RiverMind Poker build tracker

What is left to do on the way to 1.0, and where it stands. Start with **Now**, then read [AGENTS.md](AGENTS.md) for how to work. The [phase overview](#phase-overview) gives the order, and every open step has its acceptance criteria. [docs/roadmap.md](docs/roadmap.md) explains why the phases come in this order.

**Finished work is not kept here.** Once a step or phase is done and recorded, it moves word for word to [docs/build-history.md](docs/build-history.md), with older handoffs. Agents do not read that file: what still applies is here, in AGENTS.md and in the other docs (see [How to keep this file](#how-to-keep-this-file)).

**Jump to:** [Now](#now) · [How to keep this file](#how-to-keep-this-file) · [Settled decisions](#settled-decisions) · [Open questions](#open-questions) · [Phase overview](#phase-overview) · [Phase 6](#phase-6--full-featured-site) · [Phase 7](#phase-7--hardening-and-10-release) · [Release checklist](#10-release-checklist) · [Handoff log](#handoff-log)

## Now

| | |
| --- | --- |
| **Current phase** | [Phase 6 · Full-featured site](#phase-6--full-featured-site), every step built and checked in both looks (D-18). Phases 0 to 5C are complete: Phase 5C, the two looks, closed on 2026-11-27 with clean the default on the live site. Phase 5B's stretch step P5.8 stays open and does not gate 1.0. |
| **Next step** | **P6.0d** (the table on a phone held sideways), the first Phase 6 step whose dependencies are done. Waiting on the owner: P7.1b's first three criteria (their own test with real phones and a mobile network, [docs/voice.md](docs/voice.md#real-phones-a-second-network-and-the-stranger-warning-p71b)), and the push of `main`. |
| **In progress** | Nothing in Phase 6. **P7.1b** (2026-11-24): its fourth criterion is done; its first three wait on the owner. |
| **Background run** | None. Every promoted run's checkpoint and bundle are in `artifacts/models/`, so the run directories under `artifacts/blueprints/` and `artifacts/nine/` can be pruned to free disk. |
| **Blockers** | None. Standing conditions: (1) heavy work (training, table builds, evaluations) may run on this Mac beside the owner's other projects at `nice -n 19` (owner, 2026-11-22), since each is byte for byte a function of its inputs, but load slows it, raises memory use (32 GB here; use fewer workers if it swaps) and breaks timing-sensitive browser tests, so judge a failure by the load. (2) This Mac's disk is short of room (34 GB free on 2026-11-23); a checkpoint is 0.5 GB and a bundle 0.45 GB. (3) Every `pnpm install --frozen-lockfile` runs mediasoup's install script, which downloads its worker from GitHub (or compiles one): CI and the host's build need GitHub's release downloads. (4) The iOS Simulator's microphone gives Safari no audio on this Mac, and other sessions use simulators too (AGENTS.md). (5) `ssh root@ubuntu-vm` can stop at Tailscale SSH's check in a browser, which is the owner's to pass. Due later: the card sprites' source and license at P7.7 (Q-8). |
| **Live site** | https://rivermindpoker.com runs `18f478b` (release `20261127T212118Z-18f478be0d28`, deployed 2026-11-27 with the owner's approval; `/healthz` and `web-live` report the commit), on the D-14 stack: one Node service, `rivermind-poker-web` on 127.0.0.1:4320, serving the pages, the API and the tables on `/ws` from PostgreSQL 18 (`rivermind_poker`), behind Caddy, and `rivermind-poker-voice` beside it (127.0.0.1:4323, media on UDP and TCP 3478; still `bcbf4c9`'s release, unchanged since). What players get: no-limit hold'em at 2 to 9 seats against people and labelled bots (random, calling station, RiverMind Easy, Medium and Hard, Hard playing `hu-m1-s0-1024m` heads-up, `6max-s1-s0-3600m` at three to six and `9max-o1-s0` at seven to nine), guests with play-chip wallets, the lobby with quick seat, waitlists and private invites, safety controls, the fairness pages, replay, one-click practice, end-to-end encrypted table voice (at most 8 rooms and 72 people), and two looks, clean by default and pixel a click away. Models are in `/srv/rivermind-poker/models/`; the web unit's limits are 3 GB and 4 GB (D-17). [CONTRIBUTING.md](CONTRIBUTING.md#deploy-rivermindpokercom) has the rest. |
| **`main`** | `origin/main` is `18f478b` on GitHub and Codeberg (pushed 2026-11-27 with the owner's approval; CI run 46069180920 passed both jobs). Local `main` is ahead by `63fe166` (the live look check and the switch test's wait) and the commit that split this file; not pushed (owner gate). |
| **Last updated** | 2026-11-27 |

## The 1.0 product

RiverMind Poker 1.0 is a free, self-hosted, full-featured poker website at rivermindpoker.com. It uses **play money only, forever**. People play no-limit Texas hold’em at tables of 2 to 9 seats. They can play anonymous strangers, strong AI bots, or both. The site keeps their play-chip balance, hand histories and stats, and offers single-table tournaments. People seated together can talk over live table voice, end-to-end encrypted so that not even the site can listen, which is its headline feature. It works well on desktop and phone. The bots are the best this project can train and measure, and they are always labelled as bots.

The first release after Phase 4 lets a guest practice at any balance, choose a heads-up opponent with a published evaluation, then revisit a decision from the table and play another hand. Table voice (Phase 4C) lands alongside that release. Later work gives people ways to find the game through a rules page or a friend’s link (P6.7, P6.7a). A small playtest and aggregate usage counts (P7.1a) will show where players get stuck and which paths bring them back.

The [release checklist](#10-release-checklist) at the end defines "done" precisely.

## How to keep this file

1. **Orient.** Read **Now**, then [AGENTS.md](AGENTS.md). Run `git status --short --branch` and `git log -5 --oneline`. Preserve unrelated work in the tree.
2. **Choose.** The owner’s current request comes first. Otherwise take **Next step**. If it is blocked, work on a ready prerequisite within the current phase or record what is needed to proceed. Phase entry conditions apply to every step under that heading, in addition to its listed dependencies. Follow the order in the file even where steps retain an older phase number.
3. **Claim.** Put the step ID, a one-line goal and today’s date under **In progress** in **Now**. Claim one step at a time. If parallel sessions share the repo, each claims a different step and stays out of the others’ files.
4. **Build and verify.** The checkboxes indented under a step are its **Done when** criteria. Verify each one through the real entry point, such as the CLI, the browser, the server or the deployed site, as well as through tests. Run the full test suites (Python and, from P1.1 on, web) before committing.
5. **Record.** Tick each criterion as it is verified, then tick the step. Add an `Evidence:` line under the step with the commit hash and the checks you ran. Keep it to one or two sentences; longer write-ups go in a doc and are linked. If you only partly finish, leave the step unchecked, tick what is verified and add a `Remaining:` line saying exactly what is left and why.
6. **Move finished work out.** Once a ticked step's record is complete (its `CI:` and, where it has one, `Deployed:` lines), cut the whole step from here and paste it under the marker line at the top of [docs/build-history.md](docs/build-history.md), under a heading that says the date and what moved. That is an edit at the marker; do not read the rest of that file. A finished step's leftovers that are still open stay here as a line under the step or phase that will do them. When a phase closes, its section moves the same way and the phase overview keeps its one line. Durable facts, rules and lessons go in AGENTS.md or `docs/`, never only in a moved record.
7. **Advance.** Update **Now**: next step, in progress, background runs, blockers, live site, `main` and the date. Keep each cell to the current state, a few sentences at most; what happened goes in evidence lines and the handoff log. When a phase’s exit criteria are all ticked, tick the phase in the [phase overview](#phase-overview) and move **Current phase** forward.
8. **Hand off.** Prepend a short entry to the [handoff log](#handoff-log). Keep the newest three there and move older ones to [docs/build-history.md](docs/build-history.md), at its marker line.

**Changing the plan.** You may split a step (P3.2 becomes P3.2a and P3.2b), add a step you discover is needed, or reword criteria that turned out to be wrong. Say why in the handoff entry. Do not delete unfinished steps, lower acceptance criteria, reorder phases or change a settled decision without the owner. Raise those as an open question instead.

**Owner gates.** Obtain the owner’s explicit approval in the current conversation for each separate action of publishing, pushing to a remote, deploying to the live site or tagging a release. Decisions marked **Owner gate** and anything touching money or real identity also need approval. Server setup is already authorized under D-10. Use the stated defaults for ordinary open questions.

**Step format.** A step is one line, `- [ ] **P<phase>.<step> · Title** · Depends on: <step IDs or none>`, optionally followed by `· **Owner gate:** <action>`. Its criteria are checkboxes indented under it. After them come the record lines: `Evidence:` (the commit and the checks that passed), `CI:` (the GitHub Actions run), `Deployed:` (the revision, the release and the live checks) and, while work is partial, `Remaining:`. Phases open with a goal or entry condition and their exit criteria.

**Ticking.** Tick a box only when the work is committed, the full suites pass and the thing does what its line says, verified through its real entry point. Never delete a ticked item: a finished one moves to the history (rule 6). If a regression undoes one, put it back here unticked and say why in the handoff entry.

**New work and ideas.** Work that a step needs becomes a criterion or a new step in the right phase, with the reason in the handoff entry. A question only the owner can settle becomes an open question with a default. Ideas that do not gate 1.0 go to [Phase 8](#phase-8--after-10-not-gating). Do not leave any of them only in a chat or a commit message.

**IDs.** Phase 0 used task IDs `RM-00` to `RM-10`, which still appear in the code, the docs and the history. From Phase 1 on, steps are `P<phase>.<step>`. Settled decisions are `D-n` and open questions are `Q-n`.

## Settled decisions

These were decided with the owner. Build on them; change one only with the owner’s approval, and record the change here.

| ID | Decision |
| --- | --- |
| D-1 | **Play money only, forever.** Chips can never be bought, sold, cashed out or transferred for value, and the site says so. |
| D-2 | **Backend** (changed by D-14): the site and the table server are one SvelteKit app in TypeScript (strict), run on Node with `adapter-node`. A small custom server built on the adapter’s `handler.js` adds the `/ws` WebSocket (the `ws` package) on the same port. The server is authoritative: it owns the deck, turn order, validation and payouts. Clients see only their own seat’s private information. Python 3.12 with uv stays only for offline work: the reference engine, card tables, training and evaluation. Until the P4B.7 cutover the live backend is still the Python FastAPI server, `serve-nl`. |
| D-3 | **Frontend** (changed by D-14): SvelteKit 3 with Svelte 5 and TypeScript (strict), styled with Tailwind CSS 4 through `@tailwindcss/vite`, on `adapter-node`. The table and lobby stay client-rendered; content pages are server-rendered or pre-rendered. Use pnpm with a committed lockfile, Vitest for unit tests and Playwright for browser tests. Astro is not used for this project. |
| D-4 | **Database** (changed by D-14): PostgreSQL 18, accessed through Drizzle ORM on node-postgres, with SQL migrations kept in Git and generated by `drizzle-kit`. PostgreSQL already runs on ubuntu-vm. From Phase 3 on, persisted state is versioned JSON, not pickle. Until the P4B.7 cutover the live database is migrated by Alembic through SQLAlchemy 2 and psycopg 3. |
| D-5 | **Main game:** no-limit Texas hold’em with a 52-card deck at 2 to 9 seats, played on a new engine. It replaced the Phase 0 short-deck prototype on the live site at P3.7 (D-11). |
| D-6 | **Code layout** (changed by D-14): the site, table server, TypeScript engine, bot serving and database code go in the `web/` SvelteKit app, with server-only code under `web/src/lib/server/`. The `rivermind/` Python package keeps `engine` (the reference engine for training and evaluation) and `bots` (card tables, training, evaluation and the export of serving bundles). `rivermind/server` and `rivermind/db` are fixed but not extended from now on and are removed at P4B.8. `poker_ai/` is legacy, fixed but not extended, until P7.6. The `rivermind-poker` and `poker_ai` commands keep working for offline work. |
| D-7 | **Bots are honest.** Bots are always labelled, never pose as humans, and their strength claims come from published evaluations. |
| D-8 | **Fair dealing:** live tables shuffle with the operating system’s cryptographic randomness: `crypto.randomInt` from `node:crypto` after the P4B.7 cutover, `secrets.SystemRandom` before it. Seeded generators are only for tests, evaluation and training. |
| D-9 | **Hosting:** self-hosted on the owner’s ubuntu-vm. Caddy terminates HTTPS automatically and reverse-proxies to the Node service on 127.0.0.1, which runs as a sandboxed systemd unit (D-14). Deployed with [`deploy/update.sh`](deploy/update.sh). Every push, deploy and release tag needs the owner’s approval (see [AGENTS.md](AGENTS.md)). |
| D-10 | **Server administration** (owner, 2026-11-19): agents may SSH into ubuntu-vm as root and install packages, create and change databases, roles, services, files and configuration, and do whatever setup the project needs there, without asking first. Keep other sites on the host working, follow its conventions and record what changed. Pushing, deploying to the live domain and release tags still follow D-9. |
| D-11 | **Short-deck prototype** (owner, 2026-11-19, answering Q-2): the no-limit game replaces the short-deck game on the live site at the P3.7 cutover. Open short-deck tables are closed with a clear message. Its code stays for reference until P7.6. |
| D-12 | **No sign-in or user accounts before 1.0** (owner, 2026-11-19, answering Q-1): players stay anonymous guests with a signed session cookie (P4.1). P4.7 is declined for 1.0, and optional sign-in (such as passkeys that claim a guest identity) moves to Phase 8. |
| D-13 | **Player priorities** (owner, 2026-11-19). Complete one-click practice, one evaluated heads-up opponent and replay from the table, in that order, before expanding to more bot formats, other site features or release hardening. P5.9 verifies the complete player experience. D-14 puts the stack migration ahead of the remaining two. D-15 runs table voice alongside them and ahead of everything after P5.9. |
| D-14 | **Stack** (owner, 2026-11-20): SvelteKit 3 · Svelte 5 · TypeScript · Tailwind CSS 4 · PostgreSQL 18 with Drizzle ORM · Node (`adapter-node`) · Caddy. This replaces FastAPI, Uvicorn, SQLAlchemy, psycopg and Alembic on the serving path, and `adapter-static` for the client. The live site, table server, WebSockets, engine and bot serving move to TypeScript. Python stays only for offline training and evaluation. It exports versioned serving bundles that Node reads, and differential tests keep the TypeScript engine and bots in step with the Python reference. The migration is Phase 4B and comes before P5.5. D-2, D-3, D-4, D-6, D-8 and D-9 were rewritten to match. |
| D-15 | **Table voice** (owner, 2026-11-20). Live group voice for the people seated at a table is the site’s headline feature and ships in 1.0. It is end-to-end encrypted with no unencrypted fallback: each browser encrypts its Opus frames with SFrame (RFC 9605) under keys from an MLS group (RFC 9420) of the people in voice, and a mediasoup forwarding server relays frames it cannot decrypt. Nothing is recorded, transcribed or stored. Joining is opt-in: the microphone is requested only after a person chooses to join. Bots never take part (D-7). The media server runs as a second Node service, `rivermind-poker-voice`, built from `web/` beside the D-2 server, because it binds a public UDP port and should survive site deploys. The plan is Phase 4C and [docs/voice.md](docs/voice.md): it starts now with the parts that touch no table code, launches after the P4B.7 cutover, runs alongside Phase 5A and goes first when both have a ready step, and must pass before Phase 5B. Text chat stays out of 1.0 (Q-4). The owner’s answers the same day: only seated people speak and hear, with an 18+ note on the voice card and in the terms (Q-10); voice gets stronger noise suppression than the browser’s own, an RNNoise build in WebAssembly, and for it alone the page CSP adds `'wasm-unsafe-eval'` to `script-src` (Q-11). |
| D-16 | **Phase 4C's open items, and real phones** (2026-11-22). The owner approved the launch, had no phone to offer, named the iOS Simulator on this Mac for device checks, and left every open item of Phase 4C to the session's judgment. The session's decisions, each of which the owner may overturn: (1) P4C.8's three findings: a cap of 32 TCP connections to 3478 from one address, in a table of the site's own; the four sandbox settings, once tried with real calls; and the one moderate `pnpm audit` advisory in a development tool accepted. (2) RNNoise's 20.7 ms stands: it is 0.7 ms over the 20 ms aimed at, and a processor of our own could save no more than that. (3) A block keeps the two who blocked each other from hearing each other and removes nobody from the room, as built at P4C.5. (4) Someone who has just left their seat has three seconds before a page counts them as a stranger, as built at P4C.3. (5) Safari in the iOS Simulator stands in for a phone wherever it is a faithful stand-in: the engine, its WebRTC and its rules for the microphone and for a hidden page. It is not one for a phone's processor, microphone and speakers or for a mobile network, so those checks are gathered in P7.1b, which gates 1.0 and does not hold Phase 5B back. |
| D-17 | **Six seats go live with the run's final champion, and the web unit's memory may grow** (owner, 2026-11-22). Serving a six-seat bot is deployed only after the six-seat run `6max-s1-s0` has finished and its final checkpoint has been through the gate; six-seat serving is not deployed with `6max-s1-s0-100m`, though it is built and tested against it. The web service's memory limits on ubuntu-vm (`MemoryHigh` and `MemoryMax` in `deploy/rivermind-poker-web.service`) may be raised or removed as needed: the host has 16 GB with plenty free. P5.7 raised them from 2 GB and 3 GB to 3 GB and 4 GB, on a measured peak of 1.5 GB with both champions loaded. |
| D-18 | **Two looks, clean by default** (owner, 2026-11-27). The site gets a clean, professional look with no pixel art beside the pixel-art look, and players switch between them at any time; once the clean look is finished it is the default. Both looks function identically: one set of pages, components and behaviour, with the look chosen by stylesheet, art and deck. The clean deck is the code-drawn cards from the owner's FeltPrep project, which the owner contributes to RiverMind under GPL-3.0-or-later; everything else in the clean look is hand-drawn SVG or CSS. This is Phase 5C, which goes ahead of Phase 6, and every Phase 6 step is built and checked in both looks. |

## Open questions

Use each default until the owner decides otherwise. **Needed by** names the step that relies on the answer. A missing prerequisite such as proof of the card license stays open until verified.

| ID | Question | Default until decided | Needed by |
| --- | --- | --- | --- |
| Q-1 | Accounts: guest-only, or optional sign-in to keep chips across devices? | **Decided** (D-12): guest-only until after 1.0. | — |
| Q-2 | When does the short-deck prototype leave the live site? | **Decided** (D-11): it is replaced at the Phase 3 cutover (P3.7). | — |
| Q-3 | Tournaments in 1.0? | Single-table sit-and-go in 1.0 (P6.4). Multi-table tournaments after 1.0. | P6.4 |
| Q-4 | Chat? | Voice is decided (D-15): table voice ships in 1.0. No free-text chat in 1.0; preset reactions only (P4.5). | P4.5 |
| Q-5 | Compute for bot training: this Mac only, or rented or extra machines? | Train on this Mac. Reserve ubuntu-vm for serving. Record the measured shortfall if a format needs more compute. | P5.2–P5.3, P5.6 |
| Q-6 | Analytics? | None from third parties. Server-side aggregate counts only (P7.1). | P7.1 |
| Q-7 | Retire the `poker_ai` namespace and its pickled formats at 1.0? | Keep the namespace as a thin legacy package and drop it from the site. | P7.6 |
| Q-8 | Where do the card sprites added in P6.0a come from, and what are their license terms (`8BitDeck_opt*.png`, `Deck Backs*.png`)? | Keep using them; record the source, author and terms in `licenses/` and the README credits, and replace any card whose terms do not allow a GPL site. | P7.7 |
| Q-9 | Voice needs a public media port on the home network, and how much upload bandwidth does the line have? | Port 3478, UDP and TCP. Done on 2026-11-20: the router forwards TCP and UDP 3478 to the Windows host, the Windows host forwards both to ubuntu-vm at 192.168.50.2:3478 with matching Windows Firewall rules, and `ufw` on ubuntu-vm allowed them (D-10) until 2026-11-21, when a host audit closed the port there at the owner’s request because nothing listened on 3478. The deploy of 2026-11-22 that installed the voice unit allowed both again (`update.sh` keeps them), and the voice service listens there. The path from inside the home network, through the router's own address, works over UDP and TCP (P4C.4, and live at P4C.9); from outside it is still to check, with a phone on a mobile network (P7.1b). P4C.7 measured the line from this Mac, which shares it, at 556 to 686 Mbps up, and from ubuntu-vm itself at 385 to 484 Mbps; the voice unit allows 8 rooms and 72 people, which the media worker's one core decides, not the uplink. | P4C.4, P4C.7, P7.1b |
| Q-10 | Who may hear and speak in table voice, and what age statement goes with it? | **Decided** (D-15, owner, 2026-11-20): seated people only; spectators hear nothing, bots never take part and practice tables have no voice. The voice card and the terms (P6.7) say voice is for adults (18+). | — |
| Q-11 | Stronger noise suppression than the browser’s own (an RNNoise build in WebAssembly) needs `'wasm-unsafe-eval'` in the CSP. Allow it? | **Decided** (D-15, owner, 2026-11-20): yes. `'wasm-unsafe-eval'` joins `script-src` for this alone; everything else in the CSP stays as it is. | — |
| Q-12 | Does the clean look also need a light theme? | Dark only for 1.0, a calm card room like the pixel look's night; a light theme can follow in Phase 8. | P5C.2 |

## Phase overview

- [x] **Phase 0 · Prototype and foundation.** Training repairs, a bot baseline, a server-owned table, the browser client, self-hosting and restart-safe tables.
- [x] **Phase 1 · SvelteKit client.** Replace the vanilla client with SvelteKit on the existing protocol, with browser tests and CI.
- [x] **Phase 2 · No-limit hold’em engine.** A correct, tested 52-card no-limit engine for 2 to 9 seats, with hand histories.
- [x] **Phase 3 · Table server v2.** Multi-seat tables on the new engine with PostgreSQL persistence, action clocks and the live cutover.
- [x] **Phase 4 · Multiplayer and identity.** Anonymous players, a play-chip wallet, a lobby, safe multi-human tables and fair dealing.
- [x] **Phase 4B · TypeScript stack migration.** Move the site and table server to SvelteKit on Node with Tailwind CSS 4 and Drizzle (D-14), with no change in what players see. Python keeps only training and evaluation.
- [x] **Phase 4C · Table voice.** Live, end-to-end encrypted group voice for the people at a table, with one-click mute, per-player mute and volume, and mute all (D-15). Launched on 2026-11-22 (P4C.9); real phones and a second network are P7.1b (D-16).
- [x] **Phase 5A · Practice, heads-up opponent and replay.** Build the three player priorities in order. Verify them together through the live browser at P5.9.
- [x] **Phase 5B · Multi-seat bots and difficulty levels.** After P5.9 and the Phase 4C exit, extend the evaluated heads-up pipeline to 6-max, then 9-max.
- [x] **Phase 5C · Two looks: clean and pixel.** A clean, professional look with no pixel art beside the pixel-art look, switched by the player and kept in their browser, with clean the default once finished. One set of pages and behaviour serves both (D-18).
- [ ] **Phase 6 · Full-featured site.** After Phase 5B, finish replay sharing, friend invites, stats, leaderboards, sit-and-go tournaments, settings, accessibility, content pages and installability.
- [ ] **Phase 7 · Hardening and 1.0.** Monitoring, backups, load tests, fast restarts, a security review, cleanup and the release.
- Phase 8 · After 1.0. Ideas that do not gate the release.

---

## Phase 5B · Multi-seat bots and difficulty levels

Complete since 2026-11-24: heads-up, six and nine seats each have a promoted champion with its published evaluation, and RiverMind Easy, Medium and Hard are served at 2 to 9 seats (the steps and their evidence are in [docs/build-history.md](docs/build-history.md)). Its stretch step stays open and does not gate 1.0.

- [ ] **P5.8 · Real-time search (stretch, does not gate 1.0)** · Depends on: P5.9
  - [ ] Depth-limited subgame solving for heads-up runs within the serving budget, and its evaluation shows a significant gain over the blueprint alone. If it is not reached by 1.0, move it to Phase 8.

---

## Phase 6 · Full-featured site

**Starts after the Phase 5B exit criteria and Phase 5C** (D-18). Every Phase 6 step is built and checked in both looks. Its first steps (P6.0, P6.0a, P6.0c, and P6.0b and P6.1 under Phase 5A) are done and in the history. The remaining work adds sharing, multiplayer features and polish.

**Exit criteria**
- [ ] Every step below is shipped on the live site and covered by Playwright tests.
- [ ] Automated accessibility checks report no serious or critical issues.

- Done, with their evidence in [docs/build-history.md](docs/build-history.md): **P6.0** (the pixel-art design system), **P6.0a** (the owner’s card deck), **P6.0c** (the table on one phone screen), and P6.0b and P6.1 under Phase 5A. What they left for later:
  - From P6.0: Remaining (for later steps): a landscape tablet at 1024×768 fits a 9-seat table, but the top seats’ turn clocks can touch the pot label; 15px text is soft on 1x screens, so it is kept to secondary text. P6.0a superseded the face choices. Card-back selection remains in P6.5.
  - From P6.0c: Remaining: the owner has not yet looked at it on a real iPhone: the sizes above are WebKit windows of the size each browser leaves, and iOS's own toolbars and safe areas are unverified until then. On the viewer's turn the panel covers the seat tools (sit out, rebuy, react, opponent) until the page is scrolled. A screen shorter than 656px (an iPhone SE) keeps the table at its least height, and the panel then covers the viewer's clock.

- [ ] **P6.0d · The table on a phone held sideways** · Depends on: P6.0c · Found at P6.0c (2026-11-21)
  - [ ] At 874 × 360 and 956 × 400 the first screen holds the table, every seat at 2 to 9, the viewer's cards and the action panel, with the site header left out and the safe areas beside the screen kept clear. Today a phone held sideways gets the narrow landscape layout, whose dock covers the whole table; it needs its own seat map and smaller board cards, since the felt is about 220px tall. Verify as P6.0c was, with a Playwright test at both sizes.

- [ ] **P6.1a · Share a finished replay** · Depends on: P6.1
  - [ ] Sharing requires the player to create a revocable link from a finished hand. The shared view contains the public actions, board and cards shown at showdown, with generic seat labels. Shared pages serve `noindex`. Verify access and revocation in a second browser context and check the response payload for hidden cards and private table metadata.
- [ ] **P6.2 · Player profile and stats** · Depends on: P4.2, P6.0b
  - [ ] Profiles show hands played and net chips over time, with a graph, plus VPIP, PFR and win rate in big blinds per 100 hands.
  - [ ] Check that adding practice hands leaves competitive stats unchanged and that existing wallet-backed hands still count.
- [ ] **P6.3 · Leaderboards** · Depends on: P6.2, P6.0b
  - [ ] Daily, weekly and all-time boards rank play-chip results. Humans and bots are ranked separately, and boards resist simple abuse such as farming chips from fresh accounts.
  - [ ] The boards count only eligible wallet-backed games. Verify that adding practice hands to a fixture produces the same rankings as the fixture with only wallet-backed games.
- [ ] **P6.4 · Sit-and-go tournaments** · Depends on: P3.7, P4.2 · Scope per Q-3
  - [ ] Single-table tournaments with blind levels, eliminations and play-chip payouts. Bots fill empty seats on request, and tests cover the tournament rules from start to finish.
- [ ] **P6.5 · Settings and polish** · Depends on: P3.6
  - [x] Original artwork for 52 cards in standard and four-colour treatments and three backs with 180° rotational symmetry. The owner brought the artwork forward during Phase 1, and the SvelteKit table defaults to standard faces and the RiverMind back. The SVG deck was replaced by the pixel-art deck in P6.0.
  - [ ] Settings: card backs (18 since P6.0a, whose deck is always four-colour), animation speed, sound with mute, and keyboard shortcuts, including the voice keys from P4C.6. Voice settings stay in the voice panel and appear here too.
  - [ ] Pre-action checkboxes: check/fold and call any. Bets and pot changes are animated.
  - Evidence: `e826f94`. Reviewed after the artwork session: the generator reproduces all 81 committed SVGs byte for byte, and a Vitest check now fails if they drift (it caught a deliberate one-character edit). Every SVG is valid XML with no styles or scripts. The faces, courts, aces, four-colour inks and the three backs were inspected at 150 px and at 34 × 48 px. The built client under `serve --client_dir` played to showdown at 375 × 812 with no broken images, no overflow, folded seats still face down and revealed hands shown. pytest 138, Vitest 32 and Playwright 36 of 36 (three browsers, two sizes) passed, as did check, lint and build.
  - Remaining: Card-back selection, animation speed, sound and mute, keyboard shortcuts, pre-actions, and bet and pot animations (P6.0 added only entrance animations for cards, bets and the action panel). P6.0a sets the current face artwork and sizing.
- [ ] **P6.6 · Accessibility** · Depends on: P3.6
  - [ ] Playwright runs axe checks on every page. The game, including the voice controls, is fully playable by keyboard, actions and turns are announced to screen readers, focus is managed and reduced motion is respected. The target is WCAG 2.2 AA.
- [ ] **P6.7 · Content pages** · Depends on: P1.6, P6.0b
  - [ ] Pre-rendered pages cover how to play, hand rankings, about the bots (honest claims linked to evaluations), privacy (including table voice, from P4C.8’s text), and terms with the D-1 play-money statement and the voice age statement (Q-10). Each page has SEO metadata and social cards.
  - [ ] The public play and learning pages have descriptive titles, permanent URLs and crawlable links back to the lobby. The beginner guide explains the button, blinds, basic actions and hand rankings with a worked hand. From the guide, verify that a phone visitor can get to the lobby and begin practice. Check the built HTML and sitemap for public pages and apply `noindex` to personal hand history pages. [Google Search Essentials](https://developers.google.com/search/docs/essentials) · [Indexing controls](https://developers.google.com/search/docs/crawling-indexing/block-indexing)

- [ ] **P6.7a · Play with a friend from an invite** · Depends on: P4.3, P4.5, P6.0b
  - [ ] The lobby gives guests a clear way to create a private table and copy its invite. A friend opening it on a fresh browser sees the stakes and can join under the existing guest rules. Bots can start the table and give up seats between hands. A closed or expired invite offers a direct return to the lobby or solo practice.
  - [ ] Verify that a phone guest and a desktop guest can play a complete hand together from a copied link and talk over table voice. Cover full tables, insufficient play chips and expired invites. A copied private invite has a generic preview and serves `noindex`. Its code stays out of the sitemap, page metadata and analytics.

- [ ] **P6.8 · Installable app** · Depends on: P1.6
  - [ ] A web app manifest and icons make the site installable. An offline page explains that play needs a connection.

---

## Phase 7 · Hardening and 1.0 release

**Starts after the Phase 6 exit criteria.** Verify the site’s operations, recovery and performance, then ship 1.0.

**Exit criteria**
- [ ] Every item in the [1.0 release checklist](#10-release-checklist) is ticked.

- [ ] **P7.1 · Observability** · Depends on: P3.7
  - [ ] Structured JSON logs and `/healthz` and `/readyz` endpoints are in place. Metrics cover tables, players, hands per minute, decision latency and errors, and for voice only aggregate counts: rooms, people in voice, connection failures, concealment and the uplink used, never who spoke or for how long. Uptime is monitored with the owner’s existing status service if suitable. Per Q-6, there is no third-party analytics.

- [ ] **P7.1a · First-time playtest and usage baseline** · Depends on: P7.1, P6.1, P6.7, P6.7a
  - [ ] Run an unassisted playtest with at least five first-time players across phone and desktop. Ask them to play a first hand, review it, join a friend from a link and talk to them over table voice. Record where they stop or ask for help, fix reproducible blockers to those tasks, and repeat the affected checks.
  - [ ] Produce a server-side aggregate report per Q-6. Count the share of new guests who complete a first hand after taking an action, guests who open a replay after finishing a hand, and guests who are dealt in after opening a valid invite. Report how many guests who finish a first hand return to play on the same browser within days 1–7. Write down the numerator, denominator, sample dates and build for each measure.
  - [ ] Use the existing guest identity for deduplication within the measurement window and retain only aggregate usage results after it closes. Verify the counts with known test sessions before collecting a live baseline. The first report identifies one improvement to test after launch and specifies a comparable window for measuring it.

- [ ] **P7.1b · Table voice on real phones and a second network** · Depends on: P4C.9 · Needs the owner: an iPhone, an Android phone and a mobile network (D-16)
  - [ ] On the live site, a real iPhone in Safari, an Android phone in Chrome and a desktop browser share one table's voice across at least two networks (home Wi-Fi and cellular): each is heard by the others on its own microphone, the voice code matches, and every control works by touch. Record connection success and any network that could not connect; a network that allows only TCP 443 decides whether a TURN server on 443 is needed ([docs/voice.md](docs/voice.md)). This is also the first check of the media port from outside the home network (Q-9).
  - [ ] Mouth-to-ear delay between the two networks has a 95th percentile under 250 ms, and Safari's own delay is recorded (Playwright's WebKit cannot give it). Record concealment and the uplink used.
  - [ ] On each phone: the worker's cost a frame (the transform's tallies hold it) and RNNoise's CPU, against [this Mac's](docs/voice.md#frame-encryption-as-built-p4c2); a page hidden and shown again; and whether Chrome cancels echo without the loopback (`rivermind.voice.direct` in `localStorage`), which would take 53 ms off Chromium's delay.
  - [x] The warning for someone in the group who is not seated is seen on a screen, with the microphone held (P4C.3's check; it needs a client made to stay in a group after its seat is gone, or a network that loses the commit that removes it).
  - Evidence: `b6db750`. On the live site (`713f093`), `e2e/stranger.tool.ts` kept a guest who had left the table in its voice group behind six members paused in Chromium's debugger, and a Firefox observer who then joined voice saw the warning in its panel with its microphone held, from 1.4 to 1.8 s after its click until 7.6 to 8.2 s, when it removed the guest on its own turn and sent (three runs, load 16 to 23; [docs/voice.md](docs/voice.md#real-phones-a-second-network-and-the-stranger-warning-p71b)). The runs found the panel closed over the warning, so the screen showed only a crossed-out microphone; the panel now opens by itself for it. `voice.e2e.ts` checks that with four members paused, against its own voice service, and fails without the change; it passed on this Mac and in Playwright 1.65.1's Linux Chromium in Docker. Full suites before the commit: pytest 477 passed; `pnpm check`, `pnpm lint`; Vitest 1,278 passed with the database tests; `pnpm e2e` 205 passed, 17 skipped, with the PostgreSQL journey. The change is not deployed: the live site keeps the closed panel until the next deploy.
  - Evidence (the panel opens by itself, live, 2026-11-24): after `2a3de6d` was deployed (release `20261124T222431Z-2a3de6d91330`), `pnpm exec playwright test --config playwright.voice-stranger.config.ts` against https://rivermindpoker.com reported `panelOpenedByItself: true`: the observer's panel opened with the warning and its microphone held 1.0 s after its click on “Join voice”, until 7.1 s, when the guest was gone and it went live. The run before it, at a load average near 4 on this Mac, failed before anything of voice: the lobby's “No bots” choice did not read as checked within 5 s of its click (`sitDown` in `e2e/fixtures.ts`); the rerun alone passed.
  - Remaining: the first three criteria need an iPhone, an Android phone and a mobile network. The owner chose on 2026-11-24 to test them on their own rather than in a guided session; [docs/voice.md](docs/voice.md#real-phones-a-second-network-and-the-stranger-warning-p71b) says how for each, with console snippets that read a phone's connection statistics and the transform's tallies without a change to the site, and a way to time delay between two devices from one recording. A network that allows only TCP 443 is still to be found.
- [ ] **P7.2 · Backups and recovery** · Depends on: P3.1
  - [ ] PostgreSQL and the bot artifacts are backed up nightly, integrated with the owner’s existing ubuntu-vm backup setup. A restore onto a scratch database is performed and documented.
- [ ] **P7.3 · Load test** · Depends on: P4.4, P5.7, P4C.7
  - [ ] A scripted load test (at least 300 simulated players across 50 tables with bots) on ubuntu-vm keeps 95th-percentile action round-trips under 250 ms and memory within limits, while voice runs at the P4C.7 cap on the same host. The results are recorded.
- [ ] **P7.4 · Fast, seamless deploys** · Depends on: P3.7, P4B.7
  - [ ] The service restarts in under 5 seconds, so a deploy shows only a brief reconnect. Options include memory-mapped or lazily loaded bot tables, or a separate bot process.
  - [ ] A deploy during live play is verified in a browser.
- [ ] **P7.5 · Security review** · Depends on: P4.5
  - [ ] Dependencies are audited (pip-audit and pnpm audit), and headers, CSP and cookie flags are reviewed. The voice service, mediasoup, ts-mls and the SFrame code are reviewed from P4C.8’s findings.
  - [ ] Authorization tests show that no one can see another seat’s cards, act for another player or alter balances. Rate limits are checked. Findings are fixed or documented with owner approval.
- [ ] **P7.6 · Retire the prototype** · Depends on: P3.7, P5.5 · Per Q-7
  - [ ] The legacy short-deck code is removed from the serving path, and `poker_ai` is handled as Q-7 decides. Docs and tests are updated, and nothing on the site imports legacy modules.
- [ ] **P7.7 · Documentation and release** · Depends on: P7.1a, P7.2, P7.3, P7.4, P7.5, P7.6 · **Owner gate** for tagging, pushing, publishing and deployment
  - [ ] README, CONTRIBUTING and the operations notes are current. CHANGELOG.md is written. The version is set to 1.0.0 in `pyproject.toml` and `web/package.json`.
  - [ ] Resolve Q-8 by recording the card sprites’ source, author and license in `licenses/` and the README credits. Replace any sprites whose terms do not permit their use, and verify the replacement deck.
  - [ ] Verify the pre-release checklist items and a passing CI run. With the owner’s approval for each release action, tag `v1.0.0`, push it to both remotes, publish the release notes and verify the deployment live. Then tick the final release item.

---

## 1.0 release checklist

- [ ] No-limit hold’em at 2 to 9 seats, matching `docs/rules.md`, on the live site.
- [ ] Anonymous players can play each other and bots, with persistent play-chip balances and a ledger that balances.
- [ ] P5.9 has live evidence that a guest can start one-click practice at any balance, play the evaluated heads-up opponent, replay the settled hand from the table and return to play.
- [ ] Guests can join friends by link. First-time playtest findings and an aggregate usage baseline are recorded (P7.1a).
- [ ] Champion bots for heads-up, 6-max and 9-max, with published evaluations, plus difficulty levels. Bots are always labelled.
- [ ] People at a table talk over live table voice that is end-to-end encrypted, with one-click mute, per-player mute and volume, and mute all, verified live at phone and desktop sizes in all three browser engines (P4C.9) and on real phones across two networks (P7.1b).
- [ ] Hand histories, a replayer, stats, leaderboards and sit-and-go tournaments.
- [ ] Works on current Chromium, Firefox and Safari (WebKit), from phone to desktop. Accessibility checks pass and the game is fully keyboard playable.
- [ ] Live state and histories persist in PostgreSQL and survive restarts. Backups are verified by a restore.
- [ ] Monitoring, load-test results and the security review are on record.
- [ ] Play-money terms (D-1) are on the site. There is no third-party tracking.
- [ ] CI passes. The `v1.0.0` tag and release notes were published with the owner’s approval.

## Phase 8 · After 1.0 (not gating)

These are possible directions after the release:

- multi-table tournaments;
- other games such as pot-limit Omaha, with short-deck back as a variant;
- real-time search for every format;
- a Rust engine core if training needs it;
- richer spectator features and table chat with moderation (basic spectating shipped in P4.3);
- video at the table and spectator listening, on the Phase 4C voice service and its encryption;
- optional sign-in, such as passkeys that claim a guest identity so chips and history follow a player across devices (D-12);
- native app wrappers;
- public research write-ups on the bots.
- a shareable weekly practice hand that asks the player to solve a worked example from the rules, such as awarding a side pot. After the answer, show the reasoning and a link to play against a bot.

---

## Handoff log

Newest first. Keep three entries and move older ones to [docs/build-history.md](docs/build-history.md), at its marker line. Each entry gives the date, the step IDs, what changed, the checks actually run and the next concrete action.

**2026-11-27 · Phase 5C closed: clean by default and live, with clean icons; a Linux-font overflow found by CI and fixed; BUILD.md cut down to the work that is left.** The owner asked for as much of the build as could be done, approved two pushes and two deploys, and then asked for a build history like their other repositories', so that BUILD.md is debloated. **Built:** `4f741a3` (P5C.7: `DEFAULT_LOOK` is `clean`; the favicon, its PNG, the home-screen icon and `theme-color` are the clean mark, drawn by `scripts/clean-art/icons.js` with its own rasteriser, which finishes P5C.4; CI runs Playwright in both looks; `pnpm visual` captures both; the docs and the README); `3ebecad` (the trained bots' practice button wraps where it must: in DejaVu Sans, the system font on GitHub's runner, it was 8px too wide for a 375px phone, and CI's clean run failed on every phone); `63fe166` (`look.live.ts` checks the looks on the deployed site, and the switch test waits for the look). **Found:** two test races, each fixed in the test: the stranger-warning sampler read the page in several round trips, and the switch test read `<html>` before the app started. **Checked:** Playwright in each look in all six projects locally and in CI run 46069180920; `pnpm visual:compare` (the pixel look identical to `b02d303`); the deploys of `2e7c9fd` and `18f478b`, `pnpm e2e:live` 23 passed in each look on the second. Phase 5C's exit criteria are ticked. **The split**, after vincentsawyer.org's: everything finished (Phases 0 to 5C, P6.0, P6.0a and P6.0c, the old **Now** cells and all but three handoffs) moved word for word to [docs/build-history.md](docs/build-history.md), which now opens with a "do not read" note and a marker to paste at; BUILD.md went from 302 KB to 49 KB, and **How to keep this file** and AGENTS.md say to move finished steps out once their record is complete. Open leftovers of finished steps stay as lines under Phase 6. **Not pushed:** `63fe166` and the split. **Next:** P6.0d, the table on a phone held sideways.

**2026-11-27 · P5C.6 complete: the clean table, and the look switch in the table bar's menu.** The owner asked for as much of the build as could be done. **Found:** the stall in Chromium's clean phone capture was the clean look's smooth bob on the seat to act, which never stood still, so Playwright could never click that seat's name; it now glows in place, and AGENTS.md says why nothing may loop by moving. **Built** (`72fd6a6`): the clean clock as one bar, single-edged phone board slots, opaque bet pills and soft tags, lamps and meter; a ••• menu at the end of a phone's table bar that opens over the table with the look switch, and a phone's bar kept to one line in voice by 4px gaps and no blinds chip. **Checked:** the whole Playwright suite in both looks in all six projects with the journey (223 passed each), switching mid-hand and mid-call, every clean scene now captured (570), the pixel look identical outside a phone's table bar, the clean table reviewed at every size P6.0c and `pnpm visual` name; pytest 477, Vitest 1,298 with the database. One four-browser voice run in twelve failed a step after the switch (see P5C.6's evidence). Moved the oldest entry to [docs/build-history.md](docs/build-history.md). **Pushed** to both remotes at `2013f1b` with the owner's approval; CI run 46056137335 passed both jobs. Not deployed. **Next:** P5C.7: clean by default with P5C.4's icons, both looks in CI and `pnpm visual`, the docs, then the owner's push and deploy.

**2026-11-27 · P5C.5 complete: the look switch in every header, and the clean pages finished.** The owner asked for as much of the build as could be done. **Built** (`2465531`): `LookSwitch.svelte` at the far end of the site header, Clean and Pixel, at once and kept, at fixed sizes so switching moves nothing beside it; “Poker” leaves a phone's header below 460px to keep the player's name; `/style`'s own switch is gone. The clean pages lost their last pixel touches (square lamp and seat markers, underlined link buttons, crossed slot edges on the replay's board), through new `clean:` and `pixel:` variants where a utility sets the property. **Found:** a group named by `aria-labelledby` in the header crashed Firefox's page at a nine-seat table under Playwright, every time; `aria-label` does not. **Checked:** `look.e2e.ts` in all six projects; the pixel look's captures against a copy of `828a4a4` differ only in the header band, and on `/style`; the clean pages reviewed at full resolution at the four sizes; pytest 477, Vitest 1,298 with the database, Playwright 217 passed and 17 skipped in six projects with the journey, and Chromium in the clean look. **Not pushed** (owner gate). **Next:** P5C.6, the clean table, starting with why Chromium's clean phone capture stalls at the heads-up table (recorded on P5C.5).
