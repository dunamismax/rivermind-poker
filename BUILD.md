# RiverMind Poker build tracker

This file is the single source of truth for project status, from today’s working prototype to the 1.0 release. It is written for AI agents and human contributors who pick the work up in sequence. Read **Now**, follow **How to work this file**, do the next unchecked step, and leave this file accurate for whoever comes next.

## Now

| | |
| --- | --- |
| **Current phase** | Phase 1 · SvelteKit client |
| **Next step** | **P1.5** CI for the web app |
| **In progress** | **P1.5** Add a web job to GitHub Actions (claimed 2026-11-19) |
| **Blockers** | _None_ |
| **Live site** | https://rivermindpoker.com runs the Phase 0 prototype: a three-seat, fixed-limit, 20-card game against random bots or the RM-06 checkpoint. It uses FastAPI, WebSockets and a vanilla JavaScript client. Tables survive restarts. |
| **`main`** | Phase 0, the P1.1 scaffold, the P1.2 typed protocol the P1.3 SvelteKit table UI and the P1.4 tests are on `main`, which pushes to GitHub and Codeberg. GitHub Actions runs the Python suite on every push. |
| **Last updated** | 2026-11-19 |

## The 1.0 product

RiverMind Poker 1.0 is a free, self-hosted, full-featured poker website at rivermindpoker.com. It uses **play money only, forever**. People play no-limit Texas hold’em at tables of 2 to 9 seats. They can play anonymous strangers, strong AI bots, or both. The site keeps their play-chip balance, hand histories and stats, and offers single-table tournaments. It works well on desktop and phone. The bots are the best this project can train and measure, and they are always labelled as bots.

The [release checklist](#10-release-checklist) at the end defines "done" precisely.

## How to work this file

1. **Orient.** Read **Now**, then [AGENTS.md](AGENTS.md). Run `git status --short --branch` and `git log -5 --oneline`. Preserve unrelated work in the tree.
2. **Choose.** The owner’s current request comes first. Otherwise take **Next step**. If it is blocked, take the first unchecked step in the current phase whose `Depends on` steps are all checked. Do not start a later phase until the current phase’s exit criteria are met, unless a step says it can run early.
3. **Claim.** Put the step ID, a one-line goal and today’s date under **In progress** in **Now**. Claim one step at a time. If parallel sessions share the repo, each claims a different step and stays out of the others’ files.
4. **Build and verify.** Every step lists **Done when** criteria. Verify each one through the real entry point, such as the CLI, the browser, the server or the deployed site, as well as through tests. Run the full test suites (Python and, from P1.1 on, web) before committing.
5. **Record.** Tick each criterion as it is verified, then tick the step. Add an `Evidence:` line under the step with the commit hash and the checks you ran. Keep it to one or two sentences; longer write-ups go in a doc and are linked. If you only partly finish, leave the step unchecked, tick what is verified and add a `Remaining:` line saying exactly what is left and why.
6. **Advance.** Update **Now**: next step, in progress, blockers, live site and the date. When a phase’s exit criteria are all ticked, tick the phase in the [phase overview](#phase-overview) and move **Current phase** forward.
7. **Hand off.** Prepend a short entry to the [handoff log](#handoff-log). Keep the newest eight there and move older ones to [docs/build-history.md](docs/build-history.md).

**Changing the plan.** You may split a step (P3.2 becomes P3.2a and P3.2b), add a step you discover is needed, or reword criteria that turned out to be wrong. Say why in the handoff entry. Do not delete unfinished steps, lower acceptance criteria, reorder phases or change a settled decision without the owner. Raise those as an open question instead.

**Owner gates.** Steps marked **Owner gate** need the owner’s explicit approval in the current conversation before you act. These include pushing to a remote, deploying, tagging a release, choosing among options listed under open questions and anything touching money or real identity. Approval does not carry over between sessions.

**IDs.** Phase 0 used task IDs `RM-00` to `RM-10`, which still appear in the code docs and history. From Phase 1 on, steps are `P<phase>.<step>`. Settled decisions are `D-n` and open questions are `Q-n`.

## Settled decisions

These were decided with the owner. Build on them; change one only with the owner’s approval, and record the change here.

| ID | Decision |
| --- | --- |
| D-1 | **Play money only, forever.** Chips can never be bought, sold, cashed out or transferred for value, and the site says so. |
| D-2 | **Backend:** Python 3.12, FastAPI and WebSockets, run by Uvicorn and managed with uv. The server is authoritative: it owns the deck, turn order, validation and payouts. Clients see only their own seat’s private information. |
| D-3 | **Frontend:** SvelteKit with Svelte 5 and TypeScript (strict), built as a single-page app with `adapter-static` and served as static files by Caddy. Use pnpm with a committed lockfile, Vitest for unit tests and Playwright for browser tests. Astro is not used for this project; SvelteKit pre-renders the content pages itself. |
| D-4 | **Database:** PostgreSQL, accessed through SQLAlchemy 2 and psycopg 3, with Alembic migrations. PostgreSQL already runs on ubuntu-vm. From Phase 3 on, persisted state is versioned JSON, not pickle. |
| D-5 | **Main game:** no-limit Texas hold’em with a 52-card deck at 2 to 9 seats, played on a new engine. The Phase 0 short-deck limit game is the prototype; Q-2 decides when it leaves the site. |
| D-6 | **Code layout:** new code goes in a new `rivermind/` Python package (`engine`, `server`, `bots`, `db`) and a `web/` SvelteKit app. `poker_ai/` is legacy, fixed but not extended, until P7.6. The one exception is Phase 1, which still works on the current server in `poker_ai/web` because Phase 3 replaces it. The `rivermind-poker` and `poker_ai` commands keep working. |
| D-7 | **Bots are honest.** Bots are always labelled, never pose as humans, and their strength claims come from published evaluations. |
| D-8 | **Fair dealing:** live tables shuffle with the operating system’s cryptographic randomness (`secrets.SystemRandom`). Seeded generators are only for tests, evaluation and training. |
| D-9 | **Hosting:** self-hosted on the owner’s ubuntu-vm behind Caddy with automatic HTTPS, deployed with [`deploy/update.sh`](deploy/update.sh). Every push, deploy and release tag needs the owner’s approval (see [AGENTS.md](AGENTS.md)). |

## Open questions

Each question has a default. Agents build on the default until the owner decides, and only the step named under **Needed by** waits for the answer.

| ID | Question | Default until decided | Needed by |
| --- | --- | --- | --- |
| Q-1 | Accounts: guest-only, or optional sign-in to keep chips across devices? | Anonymous guest identity (P4.1). Optional passkey sign-in (P4.7) can be built later. | P4.7 |
| Q-2 | When does the short-deck prototype leave the live site? | It is replaced at the Phase 3 cutover (P3.7). Its code stays for reference until P7.6. | P3.7 |
| Q-3 | Tournaments in 1.0? | Single-table sit-and-go in 1.0 (P6.4). Multi-table tournaments after 1.0. | P6.4 |
| Q-4 | Chat? | No free-text chat in 1.0. Preset reactions only (P4.5). | P4.5 |
| Q-5 | Compute for bot training: this Mac only, or rented or extra machines? | This Mac. Don’t train on ubuntu-vm, which serves the site. | P5.6 |
| Q-6 | Analytics? | None from third parties. Server-side aggregate counts only (P7.1). | P7.1 |
| Q-7 | Retire the `poker_ai` namespace and its pickled formats at 1.0? | Keep the namespace as a thin legacy package and drop it from the site. | P7.6 |

## Phase overview

- [x] **Phase 0 · Prototype and foundation.** Training repairs, a bot baseline, a server-owned table, the browser client, self-hosting and restart-safe tables.
- [ ] **Phase 1 · SvelteKit client.** Replace the vanilla client with SvelteKit on the existing protocol, with browser tests and CI.
- [ ] **Phase 2 · No-limit hold’em engine.** A correct, tested 52-card no-limit engine for 2 to 9 seats, with hand histories.
- [ ] **Phase 3 · Table server v2.** Multi-seat tables on the new engine with PostgreSQL persistence, action clocks and the live cutover.
- [ ] **Phase 4 · Multiplayer and identity.** Anonymous players, a play-chip wallet, a lobby, safe multi-human tables and fair dealing.
- [ ] **Phase 5 · Strong bots.** No-limit abstractions, training, evaluation, a promotion gate and serving, for heads-up, 6-max and 9-max.
- [ ] **Phase 6 · Full-featured site.** Hand replays, stats, leaderboards, sit-and-go tournaments, settings, accessibility and content pages.
- [ ] **Phase 7 · Hardening and 1.0.** Monitoring, backups, load tests, fast restarts, a security review, cleanup and the release.
- Phase 8 · After 1.0. Ideas that do not gate the release.

---

## Phase 0 · Prototype and foundation (complete)

**Outcome.** A three-seat, 20-card, fixed-limit game is playable in the terminal, locally in the browser and at rivermindpoker.com, against random bots or a trained checkpoint. The full evidence for each item is in [docs/build-history.md](docs/build-history.md).

- [x] **RM-00 to RM-04 · Trustworthy training.** Covers the tracker and agent guide, corrected river hand-strength labels and resume in both modes, reproducing an uninterrupted run exactly. It also covers discounting at the intended iterations, consistent asynchronous checkpoints written atomically, and Pluribus-style training defaults.
- [x] **RM-05 · Shared policies.** A `SeatView` exposes only the acting seat’s information. `RandomPolicy` and `CheckpointPolicy` work through it in every client. [Policies](poker_ai/policies.py)
- [x] **RM-06 · Reproducible baseline.** `rivermind-poker evaluate` runs duplicate, seat-rotated matches. The checkpoint `baseline_2026_11_18_20_45_30_074222` won **+134.9 ± 11.3 chips per hand** (95% interval) against two random bots over 6,000 hands, and runs under different hash seeds produced identical reports. [Benchmark](poker_ai/benchmark.py)
- [x] **RM-07 · Server-owned table.** It validates turns, rejects stale or duplicate actions by `seq`, gives each seat a private view and reveals cards only at showdown. [Table](poker_ai/table.py)
- [x] **RM-08 · Browser client.** FastAPI with one WebSocket and a vanilla JavaScript client, tested on desktop and mobile widths. [Web app](poker_ai/web/)
- [x] **RM-09 · Self-hosted.** The site runs on ubuntu-vm behind Caddy with Let’s Encrypt, as a sandboxed systemd service, updated by [`deploy/update.sh`](deploy/update.sh).
- [x] **RM-10 · Restart-safe tables.** Each change is saved to SQLite before players see it, and tables are restored at startup. A live restart mid-hand was verified in a browser. [Store](poker_ai/web/store.py)

**Operations facts that later phases rely on**

- **Updating the live site:** after the owner approves, push `main`, then run `ssh root@ubuntu-vm 'bash /home/sawyer/github/rivermind-poker/deploy/update.sh'`. The script runs the full test suite on the server and stops if anything fails.
- **Service details:** `rivermind-poker.service` runs on `127.0.0.1:4316` as the `rivermind-poker` user, with a 3 GB memory cap. The table database is `/var/lib/rivermind-poker/tables.sqlite3`, and the Caddy site is `/etc/caddy/sites/rivermindpoker.com.caddy`. Startup takes about 23 seconds while the card table loads.
- **Served bot artifacts:** `artifacts/rm06/` on the server and this Mac, not tracked in Git. `card_info_lut.joblib` has SHA-256 `df3c314d…62f298b6` and `agent.joblib` has SHA-256 `ba63be69…b044121` (full hashes in the history).
- **Tooling on this Mac:** Python through uv, Node through mise (Node 26 at the time of writing) and pnpm through corepack. ubuntu-vm has uv, pnpm, Docker, Caddy and PostgreSQL.

---

## Phase 1 · SvelteKit client

**Goal.** Replace the vanilla JavaScript client with a SvelteKit app that speaks today’s protocol, so later phases build on the chosen frontend stack. Gameplay does not change.

**Exit criteria**
- [ ] The live site serves the SvelteKit client, and every behaviour on the P1.3 parity list works there.
- [x] Browser tests pass in Chromium, Firefox and WebKit, at desktop and phone sizes. (P1.4 evidence)
- [ ] CI runs the Python and web suites and passes on GitHub.

- [x] **P1.1 · Scaffold the SvelteKit app** · Depends on: none
  - [x] `web/` contains a SvelteKit app using Svelte 5 and strict TypeScript, with `adapter-static` and a `200.html` fallback, and `ssr = false` in the root layout.
  - [x] pnpm with a committed `pnpm-lock.yaml`, and the Node LTS major pinned in `web/.node-version` and `package.json` `engines`.
  - [x] Scripts: `dev`, `build`, `check` (svelte-check), `lint` (ESLint and Prettier), `test` (Vitest) and `e2e` (Playwright).
  - [x] The Vite dev server proxies `/api` and `/ws` to `rivermind-poker serve` on port 8000. With both running, a placeholder page shows the result of `/api/config`.
  - [x] `pnpm install --frozen-lockfile && pnpm check && pnpm lint && pnpm build` succeeds from a clean clone. CONTRIBUTING.md documents the commands.
  - Evidence: `be99381`. SvelteKit 3.3 and Svelte 5.57 with Node 26 and pnpm 12.18. In a fresh clone, `pnpm install --frozen-lockfile && pnpm check && pnpm lint && pnpm build` passed; `pnpm test` (3) and `pnpm e2e` (Chromium, placeholder page against a real `serve`) passed; with `serve` and `pnpm dev` running, the browser showed "Opponents available: random" and a Node WebSocket joined a table through the `/ws` proxy; `uv run --locked pytest` 123 passed.

- [x] **P1.2 · Typed protocol shared by server and client** · Depends on: P1.1
  - [x] Pydantic models describe every HTTP body and every WebSocket message in both directions, including the full seat view, in `poker_ai/web/protocol.py`. Phase 3 moves this module into `rivermind/server`.
  - [x] The server validates incoming messages with these models and keeps today’s error codes (`bad_request`, `stale`, `illegal_action`, `not_your_turn`, `hand_over`, `hand_in_progress`, `unknown_table`, `unknown_seat`).
  - [x] A command (`rivermind-poker protocol-schema`) exports JSON Schema, and a generator writes `web/src/lib/protocol.ts` from it.
  - [x] A test fails if the generated TypeScript is stale. The existing WebSocket tests still pass.
  - Evidence: `ab6789b`. `uv run --locked pytest` 136 passed, including the new `test_protocol.py` (stale-TypeScript check, schema export, every message from three played hands parsing as `ServerMessage`, strict `seq`, error-code coverage); against a live `serve`, a Node WebSocket client got `bad_request`, `illegal_action` and `stale` as expected and a bad body returned 400 with a string `detail`. Web check, lint, Vitest, build and Playwright passed.

- [x] **P1.3 · Port the table UI to components** · Depends on: P1.2
  - [x] Components: `Lobby`, `Table`, `Seat`, `PlayingCard`, `Board`, `ActionBar`, `HandLog`, `ResultBanner` and `ConnectionStatus`. A typed socket store handles join, `seq`, the reconnect backoff and the seat saved in `localStorage`.
  - [x] **Parity list.** Each item is verified in the browser:
    - opponent choice from `/api/config`;
    - button amounts ("Check", "Call 150", "Bet 100", "Raise 250");
    - action wording ("checks", "calls 100", "bets 100", "calls 100 and raises 100", with pre-flop raises worded correctly);
    - bot actions appearing in sequence;
    - last action per seat on the current street;
    - showdown reveal and no reveal on a fold-out;
    - the final pot, payouts and session balance;
    - Next hand and Leave table;
    - the closed-table message;
    - rejoining after a reload and after a server restart.
  - [x] Layout has no horizontal overflow at 375×812 and is comfortable at 1440×900. Reduced motion is respected and there is no inline script or style, so the current CSP holds.
  - Evidence: `8a4c757`. In the browser pane against `serve --client_dir web/build --state_path …` (and the RM-06 checkpoint for the opponent choice), checked every parity item: both opponent kinds with the checkpoint preselected; Check, Call, Bet and Raise labels; "checks", "bets 200", "calls 50 and raises 100" wording; log lines revealing in sequence (sampled 1/1, 3/5, 4/5, 5/5 over a second); last action per seat; showdown reveal and hidden cards on fold-outs; result, payouts and session balance; Next hand and Leave table; the closed-table message after a restart without state; rejoining after a reload and after killing and restarting the server. No CSP violations were logged, `scrollWidth` equalled the 375 px viewport at the table and the result, and 1440×900 shows the centred 760 px table. pytest 138 passed; web check, lint, Vitest, build and Playwright (Chromium desktop and phone) passed.

- [x] **P1.4 · Unit and browser tests** · Depends on: P1.3
  - [x] Vitest covers the wording and amount helpers and the socket store (against a mock socket: join, stale error, reconnect).
  - [x] Playwright runs against a real `serve --state_path` with random opponents and covers:
    - completing three consecutive hands;
    - rejoining after a mid-hand reload;
    - continuing after the server process is restarted;
    - the closed-table path;
    - no horizontal overflow at 375×812.
  - [x] Playwright projects for Chromium, Firefox and WebKit all pass. This closes the Phase 0 gap of Chromium-only testing.
  - Evidence: `66fb895`. `pnpm test` 28 passed (wording, results, hand log and the socket store against a mock socket). `pnpm e2e` 36 passed (six tests × Chromium, Firefox and WebKit at 1440×900 and 375×812) against a real `serve --client_dir web/build --state_path` per worker, with the restart test killing the process group; `--repeat-each 2` gave 72 of 72. Every test also fails on a CSP violation. pytest 138 passed; check, lint and build passed.

- [ ] **P1.5 · CI for the web app** · Depends on: P1.4
  - [ ] [`.github/workflows/test.yml`](.github/workflows/test.yml) gains a web job: frozen pnpm install, check, lint, Vitest, build and Playwright against the Python server.
  - [ ] Evidence names a passing GitHub Actions run (`gh run list`).

- [ ] **P1.6 · Deploy the SvelteKit client** · Depends on: P1.5 · **Owner gate:** deploy
  - [ ] Caddy serves `web/build` as static files and keeps the SPA fallback. Hashed assets under `/_app/immutable/*` are cached as immutable, while HTML revalidates. `/api/*` and `/ws` are proxied to the app.
  - [ ] [`deploy/update.sh`](deploy/update.sh) builds the web app on the server with a frozen lockfile before restarting, and stops if the build fails.
  - [ ] The legacy `poker_ai/web/static/` client and its serving code are removed. FastAPI serves only `/api` and `/ws`, plus the built client when run locally without Caddy.
  - [ ] A Playwright smoke test against https://rivermindpoker.com completes a hand against each opponent type. A live mid-hand service restart is checked again in the new client.

---

## Phase 2 · No-limit hold’em engine

**Goal.** A new, pure engine in `rivermind/engine` for 52-card no-limit Texas hold’em with 2 to 9 seats. It must be correct to the rules, fully tested and fast enough to train bots on. It shares no mutable global state and takes randomness only from its caller.

**Exit criteria**
- [ ] Every rule in `docs/rules.md` has a passing fixture test, and the property tests and fuzzing find no failures.
- [ ] Hand histories round-trip through versioned JSON and replay to identical states.
- [ ] Measured speed is recorded and meets the P2.6 target.

- [ ] **P2.1 · Write the rules specification** · Depends on: none (may start during Phase 1)
  - [ ] `docs/rules.md` covers the game rules:
    - deck and dealing;
    - seat counts (2 to 9);
    - blinds and an optional ante;
    - heads-up order (the button posts the small blind and acts first before the flop);
    - button movement when seats empty and fill, and when new players are dealt in;
    - minimum and maximum raises (no-limit, with the last full raise setting the minimum);
    - incomplete all-in raises not reopening the betting;
    - uncalled bets being returned.
  - [ ] It also covers the pot and showdown rules:
    - side pots and split pots;
    - odd chips going to the first winner left of the button;
    - showdown order and mucking;
    - what happens on a timeout (check if possible, otherwise fold).
  - [ ] Each rule has at least one worked example. Choices that vary between card rooms are listed with the option chosen, and the list is noted in the handoff for the owner.

- [ ] **P2.2 · State machine and legal actions** · Depends on: P2.1
  - [ ] Immutable state objects provide `legal_actions(state)` (fold, check, call, and bet or raise with exact minimum and maximum amounts) and `apply(state, action)`. Dealing uses a deck order or random generator supplied by the caller.
  - [ ] Tests cover action order on every street for 2, 3, 6 and 9 seats, heads-up blinds, and every street transition, including all-ins that skip later betting.

- [ ] **P2.3 · Pots, showdown and payouts** · Depends on: P2.2
  - [ ] Side pots, split pots, odd chips and returned uncalled bets are implemented. Hands are ranked with the existing Deuces evaluator, which handles seven cards; keep its MIT notice.
  - [ ] Table-driven tests run at least 30 fixed hands taken from the specification’s examples, each checking every payout.

- [ ] **P2.4 · Properties and fuzzing** · Depends on: P2.3
  - [ ] Hypothesis property tests check that:
    - chips are conserved and no stack goes negative;
    - every action from `legal_actions` applies cleanly and anything else is rejected;
    - every hand ends;
    - pots always equal what was put in.
  - [ ] A self-play fuzz run plays random legal actions with random stacks at every seat count from 2 to 9. A short version runs in CI, and the long version (at least 100,000 hands per seat count) runs on demand, with its results recorded.

- [ ] **P2.5 · Hand histories and serialization** · Depends on: P2.3
  - [ ] States and hand histories serialize to versioned JSON (with a `"format"` version field). Replaying a history reproduces the identical final state. There is also a readable plain-text history format.
  - [ ] Round-trip and replay tests cover every fixture hand and a sample of fuzzed hands.

- [ ] **P2.6 · Performance** · Depends on: P2.4
  - [ ] A benchmark script measures random self-play speed for 2, 6 and 9 seats on this Mac, and the results are recorded in the step evidence. Target: at least 2,000 complete six-seat hands per second on one core.
  - [ ] If the target is missed after profiling, record the measured gap and add an open question proposing a faster core (for example Rust through PyO3) for the owner.

- [ ] **P2.7 · Policy interface v2 and simple bots** · Depends on: P2.2
  - [ ] `SeatView` v2 holds the acting seat’s cards, the board, all stacks and bets, the pot, the amount to call, the minimum and maximum raise, positions and the action history. It never includes another seat’s private cards, and a test proves this.
  - [ ] Bots implemented:
    - `RandomPolicy`;
    - `CallingStationPolicy`;
    - a rule-based `HeuristicPolicy` that plays tight-aggressive by hand strength. It becomes the "easy" bot and an evaluation opponent.
  - [ ] Each bot plays 1,000 fuzzed hands with only legal actions.

---

## Phase 3 · Table server v2

**Goal.** Run real no-limit tables of 2 to 9 seats on the new engine. The server must be durable in PostgreSQL, have per-action clocks and a typed v2 protocol, and serve a SvelteKit table that handles every seat count. The phase ends with the live cutover.

**Exit criteria**
- [ ] On the live site, one player can play no-limit at 2, 6 and 9 seats against bots, with timers, sitting out and rebuys.
- [ ] Tables and hand histories live in PostgreSQL and survive a live restart mid-hand.

- [ ] **P3.1 · PostgreSQL foundation** · Depends on: none (may start during Phase 2)
  - [ ] SQLAlchemy 2 and psycopg 3 are connected through `DATABASE_URL`, with Alembic migrations and an initial schema for tables, seats, hands and hand histories.
  - [ ] Tests run against an isolated test database (`RIVERMIND_TEST_DATABASE_URL`). CI provides a PostgreSQL service container. Database tests are skipped only when the variable is unset locally, and the pre-commit full run must include them.
  - [ ] `alembic upgrade head` works on an empty database, and a downgrade-then-upgrade test passes.
  - [ ] CONTRIBUTING.md documents local PostgreSQL setup. On ubuntu-vm, the database and role for the site are created as an **Owner gate** step.

- [ ] **P3.2 · Table manager** · Depends on: P2.5, P2.7
  - [ ] Each table is configured with its seat count (2 to 9), blinds and optional ante, and minimum and maximum buy-in (default 40 to 100 big blinds). Hands start automatically with at least two seated players.
  - [ ] Players can take a seat, leave, sit out and return, and rebuy in play chips. Button and blind posting follow `docs/rules.md`.
  - [ ] Each table runs as an asyncio task. Engine calls stay off the event loop where they could block it.

- [ ] **P3.3 · Action clock and disconnects** · Depends on: P3.2
  - [ ] Each action has a configurable clock (default 20 seconds) plus a time bank. On timeout the seat checks if it can, otherwise folds. A player disconnected for a full orbit is sat out.
  - [ ] Clock and timeout tests use an injected clock, not real sleeps.

- [ ] **P3.4 · Protocol v2** · Depends on: P3.2, P1.2
  - [ ] Typed messages cover joining and leaving tables, seat views, ordered events with `seq`, timers, errors and several tables per connection. TypeScript is generated as in P1.2.
  - [ ] Server tests cover stale or duplicate actions, actions from the wrong seat, hidden cards and reconnecting at every seat count.

- [ ] **P3.5 · Durable tables and histories** · Depends on: P3.1, P3.2
  - [ ] Table state is stored as versioned JSON in PostgreSQL and saved before any change is broadcast. Finished hands are stored as histories. Tables are restored at startup, matching the RM-10 behaviour.
  - [ ] A test kills the server process mid-hand, and a new process restores the table identically.

- [ ] **P3.6 · SvelteKit table for 2 to 9 seats** · Depends on: P3.4, P1.6
  - [ ] An oval layout places 2 to 9 seats, adapting from phone to desktop. A bet control offers a slider and presets: minimum, ½ pot, ¾ pot, pot and all-in, clamped to the legal range.
  - [ ] The table shows timer rings, sit out and back, leave and rebuy. Playwright tests play hands at 2, 6 and 9 seats in all three browsers.

- [ ] **P3.7 · Live cutover** · Depends on: P3.3, P3.5, P3.6 · **Owner gate:** deploy and Q-2
  - [ ] The live site serves no-limit tables against the Phase 2 bots, with the short-deck prototype handled as Q-2 decides. Open prototype tables are closed with a clear message.
  - [ ] The deployment unit and Caddy site are updated, and the service connects to PostgreSQL. A live restart mid-hand and a smoke test at 2, 6 and 9 seats are verified in a browser.

---

## Phase 4 · Multiplayer and identity

**Goal.** Anonymous people can find each other in a lobby and play at the same tables safely and fairly, each with a persistent play-chip balance.

**Exit criteria**
- [ ] Two players in different browsers play together on the live site, with bots filling the empty seats.
- [ ] The chip ledger always balances, and the authorization tests show no one can act for, or see the cards of, another player.

- [ ] **P4.1 · Anonymous player identity** · Depends on: P3.7
  - [ ] A first visit creates a player with a random display handle. The session cookie is signed, `HttpOnly`, `Secure` and `SameSite=Lax`.
  - [ ] WebSocket and HTTP requests authenticate by the cookie, and requests from other origins are rejected. Tests cover a missing, forged or expired session.

- [ ] **P4.2 · Play-chip wallet and ledger** · Depends on: P4.1, P3.1
  - [ ] New players get a starting grant, and balances below a threshold are topped up daily. Buy-ins and cash-outs are ledger entries, and balances can never go negative. D-1 copy appears wherever chips are shown.
  - [ ] A test checks that ledger totals equal balances after randomized play.

- [ ] **P4.3 · Lobby and seating** · Depends on: P4.1
  - [ ] A live table list shows stakes, seats and players, with filters. Players can quick-seat, create a private table with an invite link, join a waitlist and reserve a seat.

- [ ] **P4.4 · Multi-human correctness** · Depends on: P4.2, P4.3
  - [ ] A player holds at most one seat per table, enforced on the server. Concurrent action race tests are added.
  - [ ] A Playwright test with two browser contexts covers two humans and one bot playing several hands, including disconnecting and reconnecting.

- [ ] **P4.5 · Safety and abuse controls** · Depends on: P4.3
  - [ ] Rate limits apply in Caddy and the app. Handles are filtered and can be reported, and a player can mute or block another. Q-4’s default applies: preset reactions only, no free text.
  - [ ] Basic collusion signals are logged, such as the same network address at one table, for later review.

- [ ] **P4.6 · Fair dealing and transparency** · Depends on: P3.2
  - [ ] Live shuffles use `secrets.SystemRandom` (D-8). Players can view histories of hands they played, with every revealed card. A rules and fairness page explains how dealing works.

- [ ] **P4.7 · Optional sign-in** · Depends on: P4.2 · **Owner gate:** Q-1
  - [ ] If the owner approves Q-1: passkey (WebAuthn) sign-in that claims the current guest identity, so chips and history follow the player across devices. Otherwise record the decision and tick this step as declined.

---

## Phase 5 · Strong bots

**Goal.** Train and serve the strongest no-limit bots the project can build, with every strength claim backed by reproducible, statistically sound evaluations. The order is heads-up first, then 6-max, then 9-max.

**Exit criteria**
- [ ] Each supported format (heads-up, 6-max and 9-max) has a promoted champion bot. Its published evaluation shows it beats the heuristic and calling-station bots, with the 95% interval above zero.
- [ ] Bots meet the serving latency and memory budgets on ubuntu-vm.

- [ ] **P5.1 · Abstraction design** · Depends on: P2.7
  - [ ] `docs/bots.md` defines the bot design:
    - the action abstraction for each street (for example fold, check or call, ½ pot, pot, 2× pot and all-in);
    - how off-tree bets map to the abstraction;
    - the card abstraction: 169 lossless pre-flop classes, and post-flop buckets clustered on hand-strength distributions;
    - the info-set key format;
    - memory and training-time estimates for each format.

- [ ] **P5.2 · 52-card clustering pipeline** · Depends on: P5.1
  - [ ] The clustering is generalized to the full deck. Simulations and K-means are seeded so table generation is reproducible. Each table set has a manifest with its settings, version and SHA-256.
  - [ ] Generation time and peak memory are measured and recorded.

- [ ] **P5.3 · Heads-up training** · Depends on: P5.2, P2.6
  - [ ] Monte Carlo CFR runs on the new engine with linear discounting and pruning, using several cores. It keeps the RM-02 and RM-04 guarantees: exact resume, consistent checkpoints and atomic writes.
  - [ ] Checkpoints carry a manifest: engine version, abstraction and table hashes, settings and iteration count.

- [ ] **P5.4 · Evaluation v2** · Depends on: P5.3
  - [ ] A duplicate, seat-rotated match harness plays against random, calling-station, heuristic and current-champion opponents. It reports big blinds per 100 hands with a 95% interval; variance reduction (for example AIVAT) is optional.
  - [ ] Reports are saved under `docs/evaluations/` and repeat exactly from their recorded inputs.

- [ ] **P5.5 · Promotion gate and model registry** · Depends on: P5.4
  - [ ] A challenger is promoted only if it beats the current champion with the 95% interval above zero and also beats the heuristic bot. `docs/models.md` lists each format’s champion with hashes, settings and evaluation links.
  - [ ] Artifacts stay out of Git. Their storage and backup location on ubuntu-vm is documented.

- [ ] **P5.6 · 6-max and 9-max** · Depends on: P5.5 · Compute per Q-5
  - [ ] Train, evaluate and promote champions for 6-max and 9-max, or record measured reasons why a format needs more compute and what was tried.

- [ ] **P5.7 · Serving and difficulty levels** · Depends on: P5.5, P3.2
  - [ ] Bots run within budget: 95th-percentile decision time under 200 ms and memory inside the service limits. A short "thinking" delay keeps play humane.
  - [ ] Difficulty levels are Easy (heuristic), Medium (champion mixed with heuristic) and Hard (champion). Bots are labelled per D-7. Deploying a new champion is documented and is an **Owner gate**.

- [ ] **P5.8 · Real-time search (stretch, does not gate 1.0)** · Depends on: P5.5
  - [ ] Depth-limited subgame solving for heads-up runs within the serving budget, and its evaluation shows a significant gain over the blueprint alone. If it is not reached by 1.0, move it to Phase 8.

---

## Phase 6 · Full-featured site

**Goal.** Turn the game into a complete poker website that people enjoy coming back to.

**Exit criteria**
- [ ] Every step below is shipped on the live site and covered by Playwright tests.
- [ ] Automated accessibility checks report no serious or critical issues.

- [ ] **P6.1 · Hand history viewer and replayer** · Depends on: P3.5, P4.6
  - [ ] Players can browse their hands and replay them step by step with cards and pot sizes, and share a link to a finished hand. Shared links never show cards that were mucked.
- [ ] **P6.2 · Player profile and stats** · Depends on: P4.2
  - [ ] Profiles show hands played and net chips over time, with a graph, plus VPIP, PFR and win rate in big blinds per 100 hands.
- [ ] **P6.3 · Leaderboards** · Depends on: P6.2
  - [ ] Daily, weekly and all-time boards rank play-chip results. Humans and bots are ranked separately, and boards resist simple abuse such as farming chips from fresh accounts.
- [ ] **P6.4 · Sit-and-go tournaments** · Depends on: P3.7, P4.2 · Scope per Q-3
  - [ ] Single-table tournaments with blind levels, eliminations and play-chip payouts. Bots fill empty seats on request, and tests cover the tournament rules from start to finish.
- [ ] **P6.5 · Settings and polish** · Depends on: P3.6
  - [ ] Settings: a four-colour deck, card backs, animation speed, sound with mute, and keyboard shortcuts.
  - [ ] Pre-action checkboxes: check/fold and call any. Bets and pot changes are animated.
- [ ] **P6.6 · Accessibility** · Depends on: P3.6
  - [ ] Playwright runs axe checks on every page. The game is fully playable by keyboard, actions and turns are announced to screen readers, focus is managed and reduced motion is respected. The target is WCAG 2.2 AA.
- [ ] **P6.7 · Content pages** · Depends on: P1.6
  - [ ] Pre-rendered pages cover how to play, hand rankings, about the bots (honest claims linked to evaluations), privacy, and terms with the D-1 play-money statement. Each page has SEO metadata and social cards.
- [ ] **P6.8 · Installable app** · Depends on: P1.6
  - [ ] A web app manifest and icons make the site installable. An offline page explains that play needs a connection.

---

## Phase 7 · Hardening and 1.0 release

**Goal.** Make the site dependable and secure, then ship 1.0.

**Exit criteria**
- [ ] Every item in the [1.0 release checklist](#10-release-checklist) is ticked.

- [ ] **P7.1 · Observability** · Depends on: P3.7
  - [ ] Structured JSON logs and `/healthz` and `/readyz` endpoints are in place. Metrics cover tables, players, hands per minute, decision latency and errors. Uptime is monitored with the owner’s existing status service if suitable. Per Q-6, there is no third-party analytics.
- [ ] **P7.2 · Backups and recovery** · Depends on: P3.1
  - [ ] PostgreSQL and the bot artifacts are backed up nightly, integrated with the owner’s existing ubuntu-vm backup setup. A restore onto a scratch database is performed and documented.
- [ ] **P7.3 · Load test** · Depends on: P4.4, P5.7
  - [ ] A scripted load test (at least 300 simulated players across 50 tables with bots) on ubuntu-vm keeps 95th-percentile action round-trips under 250 ms and memory within limits. The results are recorded.
- [ ] **P7.4 · Fast, seamless deploys** · Depends on: P3.7
  - [ ] The service restarts in under 5 seconds, so a deploy shows only a brief reconnect. Options include memory-mapped or lazily loaded bot tables, or a separate bot process.
  - [ ] A deploy during live play is verified in a browser.
- [ ] **P7.5 · Security review** · Depends on: P4.5
  - [ ] Dependencies are audited (pip-audit and pnpm audit), and headers, CSP and cookie flags are reviewed.
  - [ ] Authorization tests show that no one can see another seat’s cards, act for another player or alter balances. Rate limits are checked. Findings are fixed or documented with owner approval.
- [ ] **P7.6 · Retire the prototype** · Depends on: P3.7, P5.5 · Per Q-7
  - [ ] The legacy short-deck code is removed from the serving path, and `poker_ai` is handled as Q-7 decides. Docs and tests are updated, and nothing on the site imports legacy modules.
- [ ] **P7.7 · Documentation and release** · Depends on: everything above · **Owner gate:** tag and release
  - [ ] README, CONTRIBUTING and the operations notes are current. CHANGELOG.md is written. The version is set to 1.0.0 in `pyproject.toml` and `web/package.json`.
  - [ ] With the owner’s approval: the `v1.0.0` tag is pushed to both remotes, release notes are published and the deployment is verified live.

---

## 1.0 release checklist

- [ ] No-limit hold’em at 2 to 9 seats, matching `docs/rules.md`, on the live site.
- [ ] Anonymous players can play each other and bots, with persistent play-chip balances and a ledger that balances.
- [ ] Champion bots for heads-up, 6-max and 9-max, with published evaluations, plus difficulty levels. Bots are always labelled.
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
- spectating and table chat with moderation;
- native app wrappers;
- public research write-ups on the bots.

---

## Handoff log

Newest first. Keep eight entries and move older ones to [docs/build-history.md](docs/build-history.md). Each entry gives the date, the step IDs, what changed, the checks actually run and the next concrete action.

**2026-11-19 · P1.4.** Added Vitest specs for `wording.ts` and `TableConnection` (injectable socket, timers and storage), and six Playwright flows run in six projects. Each worker starts its own server on port 8700 and up in a detached process group, because killing `uv run` alone leaves the Python server running. 36 of 36 browser runs passed, and 72 of 72 with `--repeat-each 2`. Next action: P1.5.

**2026-11-19 · P1.3.** Ported the table to Svelte components with a `TableConnection` store and `wording.ts` helpers that match the vanilla client, plus a visible "Bot" label on bot seats (D-7). Found that SvelteKit's SPA fallback uses an inline bootstrap script and its route announcer an inline style, both blocked by the site CSP; the build now externalizes the script and fails on any inline code, and a Vite plugin drops the style. Added `serve --client_dir` so the built client runs locally with the production headers (P1.6 still removes the legacy client), and a Playwright harness that starts its own server per worker. Checks are in the P1.3 evidence. Next action: P1.4.

**2026-11-19 · P1.2.** Added Pydantic models for the whole protocol (`poker_ai/web/protocol.py`), used them for validation and for every outgoing message, and added `rivermind-poker protocol-schema` with a small JSON-Schema-to-TypeScript generator (`poker_ai/web/typescript.py`, no new dependency). Behaviour changes: malformed messages (a string `seq`, extra fields) are now `bad_request`, and HTTP body errors are 400 instead of 422. Ran pytest (136 passed), a live WebSocket check and the web suite. Next action: P1.3.

**2026-11-19 · P1.1.** Scaffolded `web/` with `sv create` (SvelteKit 3.3, which configures the kit in `vite.config.ts`; `#lib/…` subpath imports take the file extension). Added the 200.html fallback, `ssr = false`, the Node 26 pin, the scripts, the `/api` and `/ws` proxy and a placeholder page, and documented them in CONTRIBUTING. Ran the clean-clone install, check, lint and build, Vitest, Playwright in Chromium, a browser check against `serve`, and pytest (123 passed). Note for P1.3: the SPA fallback bootstraps with an inline `<script>`, which the current `script-src 'self'` CSP blocks. Next action: P1.2.

**2026-11-19 · Plan to 1.0.** At the owner’s request, rewrote this tracker into phases toward 1.0 with checkable steps. It now covers the expanded scope (multiplayer, 2 to 9 seats, no-limit, strong bots, a full site) and records the stack decisions as D-1 to D-9. Phase 0 evidence and earlier handoffs moved verbatim to [docs/build-history.md](docs/build-history.md), and [AGENTS.md](AGENTS.md) and the [roadmap](docs/roadmap.md) were aligned with the new format. GitHub Actions showed passing runs for the latest pushes. Next action: P1.1.

**2026-11-19 · RM-10.** Made tables survive restarts: `Table` snapshots, a SQLite store, `serve --state_path` and a state directory in the systemd unit. Ran `uv run --locked pytest` (123 passed) and a real SIGKILL restart check, and deployed. A live mid-hand service restart in a browser reconnected to the same hand and play continued.

**2026-11-19 · RM-09.** Added Codeberg as a second push URL. Deployed rivermindpoker.com on ubuntu-vm with `deploy/update.sh`, fixing two script bugs found on the first runs. Verified HTTPS, redirects, headers and browser play before and after a restart.

**2026-11-18 · RM-08.** Built the FastAPI and WebSocket server and the vanilla JavaScript client. Ran `uv run --locked pytest` (115 passed) and played in a browser at desktop and phone sizes against the RM-06 checkpoint and random bots.

**2026-11-18 · RM-02 to RM-07 and training defaults.** Fixed resume, discounting and asynchronous checkpoints. Added the shared policies, the evaluation command and the server-owned table, trained and evaluated the RM-06 baseline, and fixed set-ordered deck suits. Set the Pluribus-style training defaults. Full details are in the history.

**2026-11-18 · RM-01 and RM-00.** Established the tracker and corrected the river hand-strength labels. Full details are in the history.
