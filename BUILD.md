# RiverMind Poker build tracker

This file tracks the live no-limit game and the work remaining for 1.0. Start with **Now**. The [phase overview](#phase-overview) gives the order, and each step records its acceptance criteria and evidence.

## Now

| | |
| --- | --- |
| **Current phase** | [Phase 4B · TypeScript stack migration](#phase-4b--typescript-stack-migration) (D-14) |
| **Next step** | **P4B.1 deploy** (owner gate): push and run `deploy/update.sh`, which starts `rivermind-poker-web` on 127.0.0.1:4320 and points Caddy’s pages at it, then run `pnpm e2e:live`. Without that approval, take **P4B.2** (Tailwind CSS 4), **P4B.3** (Drizzle) or **P4B.4** (the TypeScript engine), which only need P4B.1’s code. After Phase 4B, resume Phase 5A at **P5.5**: `hu-m1-s0` at 128 million iterations already passes the gate in its [P5.4 report](docs/evaluations/hu-m1-s0-128m.md). |
| **In progress** | _None._ P4B.1 is built and verified locally; only its deploy is left. The first `hu-m1` blueprint run, `artifacts/blueprints/hu-m1-s0` (seed 0, default settings, 1.28 billion iterations, checkpoints every 128 million, kept to 10, from `d2dd215`), has trained on this Mac at low priority since 08:30 on 2026-11-20 and reached its 128-million checkpoint at 10:06. Continue it with `uv run --locked rivermind-poker blueprint train artifacts/blueprints/hu-m1-s0 --iterations 1280000000 --checkpoint_every 128000000 --keep 10 --resume`; stop it with SIGTERM, which checkpoints first. |
| **Required order** | The TypeScript stack migration (Phase 4B, D-14) → one evaluated heads-up opponent → replay from the table → verify all three player priorities together (P5.9). One-click practice is already live. Six- and nine-seat bot training, the remaining site features and release hardening follow P5.9. |
| **Blockers** | None for P4B.1. The hu-m1 card tables are already on ubuntu-vm in `/srv/rivermind-poker/models/tables/hu-m1` (root-owned, world-readable, every file checked against its manifest). The card sprites’ source and license are due at P7.7 (Q-8). |
| **Live site** | https://rivermindpoker.com runs no-limit hold’em at 2 to 9 seats against the Phase 2 bots (random, calling station and RiverMind Easy), on `serve-nl` with tables and hand histories in PostgreSQL (`rivermind_poker`), so tables survive restarts. Caddy serves the client from `/srv/rivermindpoker.com/current` and proxies `/api/*` and `/ws` to the app on 127.0.0.1:4316. Players are anonymous with signed session cookies (P4.1) and play from play-chip wallets (P4.2), find each other in the lobby (P4.3: table list, quick seat, bots giving up seats, held seats, waitlists, private tables with invite links), with safety controls (P4.5: app rate limits, reactions, mute, block, report, collusion signals) and fair-dealing pages (P4.6: your hands, the fairness page), and a guest at any balance practises heads-up against RiverMind Easy in one click (P6.0b). The site wears the P6.0 pixel-art design with the owner’s card deck (P6.0a). Deployed at `bed85b3` (migration `0006`, no new migrations; the trained bots are not served yet); Caddy rate-limits table creation (including `/api/practice`) and the seating endpoints, and has the `safety` zone. The short-deck game left the site (D-11). |
| **`main`** | Phases 0 to 4, the P6.0 pixel-art redesign and the owner’s card deck (P6.0a) are on `main`, pushed and deployed. One-click practice (P6.0b) and the bot design (P5.1) are on `main`, pushed and deployed (`15099c7`). The card tables (P5.2), the heads-up trainer (P5.3, `rivermind/bots/blueprint`) and the evaluation harness (P5.4) are on `main`, pushed and deployed at `bed85b3`; none of them changes the live game. The table set is in `artifacts/tables/hu-m1` and the blueprint run in `artifacts/blueprints/hu-m1-s0` on this Mac. The engine is in `rivermind/engine`, the bots in `rivermind/bots`, the durable table server (`serve-nl`, protocol v2) in `rivermind/server` and the client in `web/`. The short-deck code (`poker_ai/`, `serve`, the old client components) stays for reference until P7.6. `main` pushes to GitHub and Codeberg, and GitHub Actions runs the Python and web suites on every push. The stack change to SvelteKit on Node with Tailwind CSS 4 and Drizzle (D-14) is Phase 4B. P4B.1 (the client on `adapter-node`, its own Node server and the deploy for it) is on `main`, not yet deployed: the live site still serves the last static build. |
| **Last updated** | 2026-11-20 |

## The 1.0 product

RiverMind Poker 1.0 is a free, self-hosted, full-featured poker website at rivermindpoker.com. It uses **play money only, forever**. People play no-limit Texas hold’em at tables of 2 to 9 seats. They can play anonymous strangers, strong AI bots, or both. The site keeps their play-chip balance, hand histories and stats, and offers single-table tournaments. It works well on desktop and phone. The bots are the best this project can train and measure, and they are always labelled as bots.

The first release after Phase 4 lets a guest practice at any balance, choose a heads-up opponent with a published evaluation, then revisit a decision from the table and play another hand. Later work gives people ways to find the game through a rules page or a friend’s link (P6.7, P6.7a). A small playtest and aggregate usage counts (P7.1a) will show where players get stuck and which paths bring them back.

The [release checklist](#10-release-checklist) at the end defines "done" precisely.

## How to work this file

1. **Orient.** Read **Now**, then [AGENTS.md](AGENTS.md). Run `git status --short --branch` and `git log -5 --oneline`. Preserve unrelated work in the tree.
2. **Choose.** The owner’s current request comes first. Otherwise take **Next step**. If it is blocked, work on a ready prerequisite within the current phase or record what is needed to proceed. Phase entry conditions apply to every step under that heading, in addition to its listed dependencies. Follow the order in the file even where steps retain an older phase number.
3. **Claim.** Put the step ID, a one-line goal and today’s date under **In progress** in **Now**. Claim one step at a time. If parallel sessions share the repo, each claims a different step and stays out of the others’ files.
4. **Build and verify.** Every step lists **Done when** criteria. Verify each one through the real entry point, such as the CLI, the browser, the server or the deployed site, as well as through tests. Run the full test suites (Python and, from P1.1 on, web) before committing.
5. **Record.** Tick each criterion as it is verified, then tick the step. Add an `Evidence:` line under the step with the commit hash and the checks you ran. Keep it to one or two sentences; longer write-ups go in a doc and are linked. If you only partly finish, leave the step unchecked, tick what is verified and add a `Remaining:` line saying exactly what is left and why.
6. **Advance.** Update **Now**: next step, in progress, blockers, live site and the date. When a phase’s exit criteria are all ticked, tick the phase in the [phase overview](#phase-overview) and move **Current phase** forward.
7. **Hand off.** Prepend a short entry to the [handoff log](#handoff-log). Keep the newest eight there and move older ones to [docs/build-history.md](docs/build-history.md).

**Changing the plan.** You may split a step (P3.2 becomes P3.2a and P3.2b), add a step you discover is needed, or reword criteria that turned out to be wrong. Say why in the handoff entry. Do not delete unfinished steps, lower acceptance criteria, reorder phases or change a settled decision without the owner. Raise those as an open question instead.

**Owner gates.** Obtain the owner’s explicit approval in the current conversation for each separate action of publishing, pushing to a remote, deploying to the live site or tagging a release. Decisions marked **Owner gate** and anything touching money or real identity also need approval. Server setup is already authorized under D-10. Use the stated defaults for ordinary open questions.

**IDs.** Phase 0 used task IDs `RM-00` to `RM-10`, which still appear in the code docs and history. From Phase 1 on, steps are `P<phase>.<step>`. Settled decisions are `D-n` and open questions are `Q-n`.

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
| D-13 | **Player priorities** (owner, 2026-11-19). Complete one-click practice, one evaluated heads-up opponent and replay from the table, in that order, before expanding to more bot formats, other site features or release hardening. P5.9 verifies the complete player experience. D-14 puts the stack migration ahead of the remaining two. |
| D-14 | **Stack** (owner, 2026-11-20): SvelteKit 3 · Svelte 5 · TypeScript · Tailwind CSS 4 · PostgreSQL 18 with Drizzle ORM · Node (`adapter-node`) · Caddy. This replaces FastAPI, Uvicorn, SQLAlchemy, psycopg and Alembic on the serving path, and `adapter-static` for the client. The live site, table server, WebSockets, engine and bot serving move to TypeScript. Python stays only for offline training and evaluation. It exports versioned serving bundles that Node reads, and differential tests keep the TypeScript engine and bots in step with the Python reference. The migration is Phase 4B and comes before P5.5. D-2, D-3, D-4, D-6, D-8 and D-9 were rewritten to match. |

## Open questions

Use each default until the owner decides otherwise. **Needed by** names the step that relies on the answer. A missing prerequisite such as proof of the card license stays open until verified.

| ID | Question | Default until decided | Needed by |
| --- | --- | --- | --- |
| Q-1 | Accounts: guest-only, or optional sign-in to keep chips across devices? | **Decided** (D-12): guest-only until after 1.0. | — |
| Q-2 | When does the short-deck prototype leave the live site? | **Decided** (D-11): it is replaced at the Phase 3 cutover (P3.7). | — |
| Q-3 | Tournaments in 1.0? | Single-table sit-and-go in 1.0 (P6.4). Multi-table tournaments after 1.0. | P6.4 |
| Q-4 | Chat? | No free-text chat in 1.0. Preset reactions only (P4.5). | P4.5 |
| Q-5 | Compute for bot training: this Mac only, or rented or extra machines? | Train on this Mac. Reserve ubuntu-vm for serving. Record the measured shortfall if a format needs more compute. | P5.2–P5.3, P5.6 |
| Q-6 | Analytics? | None from third parties. Server-side aggregate counts only (P7.1). | P7.1 |
| Q-7 | Retire the `poker_ai` namespace and its pickled formats at 1.0? | Keep the namespace as a thin legacy package and drop it from the site. | P7.6 |
| Q-8 | Where do the card sprites added in P6.0a come from, and what are their license terms (`8BitDeck_opt*.png`, `Deck Backs*.png`)? | Keep using them; record the source, author and terms in `licenses/` and the README credits, and replace any card whose terms do not allow a GPL site. | P7.7 |

## Phase overview

- [x] **Phase 0 · Prototype and foundation.** Training repairs, a bot baseline, a server-owned table, the browser client, self-hosting and restart-safe tables.
- [x] **Phase 1 · SvelteKit client.** Replace the vanilla client with SvelteKit on the existing protocol, with browser tests and CI.
- [x] **Phase 2 · No-limit hold’em engine.** A correct, tested 52-card no-limit engine for 2 to 9 seats, with hand histories.
- [x] **Phase 3 · Table server v2.** Multi-seat tables on the new engine with PostgreSQL persistence, action clocks and the live cutover.
- [x] **Phase 4 · Multiplayer and identity.** Anonymous players, a play-chip wallet, a lobby, safe multi-human tables and fair dealing.
- [ ] **Phase 4B · TypeScript stack migration.** Move the site and table server to SvelteKit on Node with Tailwind CSS 4 and Drizzle (D-14), with no change in what players see. Python keeps only training and evaluation.
- [ ] **Phase 5A · Practice, heads-up opponent and replay.** Build the three player priorities in order. Verify them together through the live browser at P5.9.
- [ ] **Phase 5B · Multi-seat bots and difficulty levels.** After P5.9, extend the evaluated heads-up pipeline to 6-max, then 9-max.
- [ ] **Phase 6 · Full-featured site.** After Phase 5B, finish replay sharing, friend invites, stats, leaderboards, sit-and-go tournaments, settings, accessibility, content pages and installability.
- [ ] **Phase 7 · Hardening and 1.0.** Monitoring, backups, load tests, fast restarts, a security review, cleanup and the release.
- Phase 8 · After 1.0. Ideas that do not gate the release.

---

## Phase 0 · Prototype and foundation (complete)

**Outcome at the time.** The three-seat, 20-card, fixed-limit prototype ran in the terminal and browser against random bots or a trained checkpoint. The terminal still supports it. P3.7 replaced the browser game with no-limit hold’em. The full evidence for each item is in [docs/build-history.md](docs/build-history.md).

- [x] **RM-00 to RM-04 · Trustworthy training.** Covers the tracker and agent guide, corrected river hand-strength labels and resume in both modes, reproducing an uninterrupted run exactly. It also covers discounting at the intended iterations, consistent asynchronous checkpoints written atomically, and Pluribus-style training defaults.
- [x] **RM-05 · Shared policies.** A `SeatView` exposes only the acting seat’s information. `RandomPolicy` and `CheckpointPolicy` work through it in every client. [Policies](poker_ai/policies.py)
- [x] **RM-06 · Reproducible baseline.** `rivermind-poker evaluate` runs duplicate, seat-rotated matches. The checkpoint `baseline_2026_11_18_20_45_30_074222` won **+134.9 ± 11.3 chips per hand** (95% interval) against two random bots over 6,000 hands, and runs under different hash seeds produced identical reports. [Benchmark](poker_ai/benchmark.py)
- [x] **RM-07 · Server-owned table.** It validates turns, rejects stale or duplicate actions by `seq`, gives each seat a private view and reveals cards only at showdown. [Table](poker_ai/table.py)
- [x] **RM-08 · Browser client.** FastAPI with one WebSocket and a vanilla JavaScript client, tested on desktop and mobile widths. [Web app](poker_ai/web/)
- [x] **RM-09 · Self-hosted.** The site runs on ubuntu-vm behind Caddy with Let’s Encrypt, as a sandboxed systemd service, updated by [`deploy/update.sh`](deploy/update.sh).
- [x] **RM-10 · Restart-safe tables.** Each change is saved to SQLite before players see it, and tables are restored at startup. A live restart mid-hand was verified in a browser. [Store](poker_ai/web/store.py)

**Operations facts that later phases rely on**

- **Updating the live site:** after the owner approves, push `main`, then run `ssh root@ubuntu-vm 'bash /home/sawyer/github/rivermind-poker/deploy/update.sh'`. The script runs the full test suite on the server and stops if anything fails.
- **Service details.** The [production unit](deploy/rivermind-poker.service) runs `serve-nl` on `127.0.0.1:4316` as the `rivermind-poker` user with a 3 GB memory cap. Tables and hand histories live in PostgreSQL. The SQLite file and the 23-second startup measurement belong to the retired short-deck service (P3.7).
- **Prototype bot artifacts.** RM-06 paired `card_info_lut.joblib` and `agent.joblib` under the ignored `artifacts/rm06/`. The [archived evaluation](docs/build-history.md) records their hashes and the short-deck settings. Phase 5A produces a separate pair for 52-card heads-up no-limit play.
- **Database:** PostgreSQL 18 on ubuntu-vm, set up by [`deploy/setup-database.sh`](deploy/setup-database.sh), which is safe to rerun. The site database `rivermind_poker` is owned by the NOLOGIN `rivermind_poker_owner`, and its tables live in the `app` schema. `rivermind_poker_migration` runs Alembic and switches to the owner through `RIVERMIND_MIGRATION_ROLE`. `rivermind_poker_web` is the service’s role and can only read and write rows. `rivermind_poker_test` owns the separate `rivermind_poker_test` database for the deploy’s test run. Each role logs in over 127.0.0.1 with scram-sha-256. Credentials are in root-only `/etc/rivermind-poker/{web,migration,test}.env`. `update.sh` runs the tests with `test.env` and `alembic upgrade head` with `migration.env` before restarting, and the unit reads `web.env`.
- **Tooling on this Mac:** Python through uv, Node through mise (Node 26 at the time of writing) and pnpm through corepack. ubuntu-vm has uv, pnpm, Docker, Caddy and PostgreSQL.

---

## Phase 1 · SvelteKit client

**Goal.** Replace the vanilla JavaScript client with a SvelteKit app that speaks today’s protocol, so later phases build on the chosen frontend stack. Gameplay does not change.

**Exit criteria**
- [x] The live site serves the SvelteKit client, and every behaviour on the P1.3 parity list works there. (P1.6 evidence)
- [x] Browser tests pass in Chromium, Firefox and WebKit, at desktop and phone sizes. (P1.4 evidence)
- [x] CI runs the Python and web suites and passes on GitHub. (P1.5 evidence)

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

- [x] **P1.5 · CI for the web app** · Depends on: P1.4
  - [x] [`.github/workflows/test.yml`](.github/workflows/test.yml) gains a web job: frozen pnpm install, check, lint, Vitest, build and Playwright against the Python server.
  - [x] Evidence names a passing GitHub Actions run (`gh run list`).
  - Evidence: `81856bd`. `gh run list` shows run [44461612198](https://github.com/dunamismax/rivermind-poker/actions/runs/44461612198) for `81856bd` succeeded: the `test` job (pytest) and the new `web` job (frozen install, check, lint, Vitest 28 passed, build, Playwright 36 passed in Chromium, Firefox and WebKit).

- [x] **P1.6 · Deploy the SvelteKit client** · Depends on: P1.5 · **Owner gate:** deploy
  - [x] Caddy serves `web/build` as static files and keeps the SPA fallback. Hashed assets under `/_app/immutable/*` are cached as immutable, while HTML revalidates. `/api/*` and `/ws` are proxied to the app.
  - [x] [`deploy/update.sh`](deploy/update.sh) builds the web app on the server with a frozen lockfile before restarting, and stops if the build fails.
  - [x] The legacy `poker_ai/web/static/` client and its serving code are removed. FastAPI serves only `/api` and `/ws`, plus the built client when run locally without Caddy.
  - [x] A Playwright smoke test against https://rivermindpoker.com completes a hand against each opponent type. A live mid-hand service restart is checked again in the new client.
  - Evidence: `a172a17`, deployed with the owner’s approval. Caddy serves releases from `/srv/rivermindpoker.com/current` (an atomic symlink to `20261119T061029Z-a172a17d12e9`) and proxies only `/api/*` and `/ws`. Before deploying, the site file (minus the rate-limit plugin) ran under a local Caddy in front of `serve`: HTML `no-cache`, hashed assets immutable, routes fall back to `200.html`, missing `/_app/` files 404. `pnpm e2e:live` against the live site passed 8 of 8 (Chromium desktop and WebKit phone): headers and fallback, a hand against random and RiverMind bots, and a mid-hand `systemctl restart` over ssh that resumed the same table. pytest 138, Vitest 32 and Playwright 36 of 36 passed, as did check, lint and build.

---

## Phase 2 · No-limit hold’em engine

**Goal.** A new, pure engine in `rivermind/engine` for 52-card no-limit Texas hold’em with 2 to 9 seats. It must be correct to the rules, fully tested and fast enough to train bots on. It shares no mutable global state and takes randomness only from its caller.

**Exit criteria**
- [x] Every rule in `docs/rules.md` has a passing fixture test, and the property tests and fuzzing find no failures. (P2.2 to P2.4 evidence; rules 2.3 and 13.2 are table behaviour, covered by folding here and built in P3.2 and P3.3)
- [x] Hand histories round-trip through versioned JSON and replay to identical states. (P2.5 evidence)
- [x] Measured speed is recorded and meets the P2.6 target. (P2.6 evidence)

- [x] **P2.1 · Write the rules specification** · Depends on: none (may start during Phase 1)
  - [x] `docs/rules.md` covers the game rules:
    - deck and dealing;
    - seat counts (2 to 9);
    - blinds and an optional ante;
    - heads-up order (the button posts the small blind and acts first before the flop);
    - button movement when seats empty and fill, and when new players are dealt in;
    - minimum and maximum raises (no-limit, with the last full raise setting the minimum);
    - incomplete all-in raises not reopening the betting;
    - uncalled bets being returned.
  - [x] It also covers the pot and showdown rules:
    - side pots and split pots;
    - odd chips going to the first winner left of the button;
    - showdown order and mucking;
    - what happens on a timeout (check if possible, otherwise fold).
  - [x] Each rule has at least one worked example. Choices that vary between card rooms are listed with the option chosen, and the list is noted in the handoff for the owner.
  - Evidence: `8878047`. [docs/rules.md](docs/rules.md) covers every listed rule with 25 worked examples and a Choices table. The side-pot, uncalled-bet and odd-chip examples were recomputed with a throwaway script (which caught and fixed one wrong pot total), the hand-ranking example was checked with the Deuces evaluator (A♥3♦ beats Q♣J♣ on K♠K♥7♦7♣2♠; A♣4♣ ties), and the internal links resolve. pytest 138 passed.

- [x] **P2.2 · State machine and legal actions** · Depends on: P2.1
  - [x] Immutable state objects provide `legal_actions(state)` (fold, check, call, and bet or raise with exact minimum and maximum amounts) and `apply(state, action)`. Dealing uses a deck order or random generator supplied by the caller.
  - [x] Tests cover action order on every street for 2, 3, 6 and 9 seats, heads-up blinds, and every street transition, including all-ins that skip later betting.
  - Evidence: `0e8e63e`. [rivermind/engine](rivermind/engine/) holds frozen `HandState` objects, `start_hand`, `legal_actions`, `apply`, `timeout_action` and the button helpers in `seating.py`. [test_rules.py](test/engine/test_rules.py) (37 tests) checks the examples in rules sections 1 to 8 and 13, action order on every street for 2, 3, 6 and 9 seats with different buttons and empty seats, and all-ins that skip later betting. Two rules were added to the specification: 7.8 (no raise when everyone else still in is all-in) and the river case in 12.1. pytest 217 passed at that commit.

- [x] **P2.3 · Pots, showdown and payouts** · Depends on: P2.2
  - [x] Side pots, split pots, odd chips and returned uncalled bets are implemented. Hands are ranked with the existing Deuces evaluator, which handles seven cards; keep its MIT notice.
  - [x] Table-driven tests run at least 30 fixed hands taken from the specification’s examples, each checking every payout.
  - Evidence: `0e8e63e`. `pots.py` handles uncalled bets, side pots and odd chips, and `state.py` applies the showing and mucking order of rule 12. [evaluator.py](rivermind/engine/evaluator.py) ports Deuces with its notice and a memoized seven-card path (about 0.5 µs per hand). It gave the same rank as the legacy Deuces copy on 60,000 random five-, six- and seven-card hands. [fixtures.py](test/engine/fixtures.py) has 33 hands, from fold-outs to nine all-ins with eight side pots. Their expected final stacks, pots, returned bets and shown or mucked seats were worked out by hand from the rules, and every one passes.

- [x] **P2.4 · Properties and fuzzing** · Depends on: P2.3
  - [x] Hypothesis property tests check that:
    - chips are conserved and no stack goes negative;
    - every action from `legal_actions` applies cleanly and anything else is rejected;
    - every hand ends;
    - pots always equal what was put in.
  - [x] A self-play fuzz run plays random legal actions with random stacks at every seat count from 2 to 9. A short version runs in CI, and the long version (at least 100,000 hands per seat count) runs on demand, with its results recorded.
  - Evidence: `9a704d9` and `fbde4ea`. [test_properties.py](test/engine/test_properties.py) runs 300 Hypothesis examples of legal play from random stakes, antes, stacks and seat counts, and 200 of arbitrary actions. The same file runs the short fuzz (300 hands per seat count) in the normal suite. `uv run python -m rivermind.engine.fuzz --hands 100000 --seats 2-9 --seed 0` played 800,000 hands and 10,436,878 actions in 200 s with 0 failures. Each action also checked that nearby illegal actions were rejected. Showdowns at 2 to 9 seats included 375,878 played in order and 336,497 tabled, with 277,125 hands including a muck and 453,165 with side pots. A first long run with uniform action choice also passed, but it tabled almost every showdown, so the action mix was reweighted.

- [x] **P2.5 · Hand histories and serialization** · Depends on: P2.3
  - [x] States and hand histories serialize to versioned JSON (with a `"format"` version field). Replaying a history reproduces the identical final state. There is also a readable plain-text history format.
  - [x] Round-trip and replay tests cover every fixture hand and a sample of fuzzed hands.
  - Evidence: `369c0d6`. [history.py](rivermind/engine/history.py) writes `hand_state` and `hand_history` documents with `"format": 1`. A hand record carries the stakes, stacks, button, deck and actions, plus final stacks and board that the replay checks. [test_history.py](test/engine/test_history.py) round-trips every intermediate state of all 33 fixture hands and 400 fuzzed hands, and replays them to equal states. It also rejects unknown formats, wrong kinds and tampered records. `format_text` was read for side-pot and all-in hands: tabled hands appear before the runout, and a mucked hand appears only in its owner’s and the server’s text.

- [x] **P2.6 · Performance** · Depends on: P2.4
  - [x] A benchmark script measures random self-play speed for 2, 6 and 9 seats on this Mac, and the results are recorded in the step evidence. Target: at least 2,000 complete six-seat hands per second on one core.
  - [x] If the target is missed after profiling, record the measured gap and add an open question proposing a faster core (for example Rust through PyO3) for the owner. (Not needed: the target is met.)
  - Evidence: `fbde4ea`. `uv run python -m rivermind.engine.bench` on an Apple M5 with Python 3.12.15 played 100 big blind stacks at 50/100 with weighted random actions, median of 5 runs of 20,000 hands. Two seats: 23,381 hands/s (6.1 actions a hand, 55% showdowns). Six seats: **9,518 hands/s** (19.0 actions, 95% showdowns). Nine seats: 7,516 hands/s (24.4 actions, 99% showdowns). With a `SeatView` and `RandomPolicy` call for every decision (`--mode view`), six seats ran at 10,628 hands/s, faster because that bot ends hands sooner. Pure Python meets the target 4.8 times over, so no faster core is proposed.

- [x] **P2.7 · Policy interface v2 and simple bots** · Depends on: P2.2
  - [x] `SeatView` v2 holds the acting seat’s cards, the board, all stacks and bets, the pot, the amount to call, the minimum and maximum raise, positions and the action history. It never includes another seat’s private cards, and a test proves this.
  - [x] Bots implemented:
    - `RandomPolicy`;
    - `CallingStationPolicy`;
    - a rule-based `HeuristicPolicy` that plays tight-aggressive by hand strength. It becomes the "easy" bot and an evaluation opponent.
  - [x] Each bot plays 1,000 fuzzed hands with only legal actions.
  - Evidence: `2626830`. [view.py](rivermind/engine/view.py) builds the view, and [test_view.py](test/engine/test_view.py) proves privacy over 60 seeded hands at 2 to 9 seats. It reshuffles every card the viewer cannot see, including other hole cards, burns and undealt cards, and checks the view is identical after every action. After a showdown only the shown hands are added. [rivermind/bots](rivermind/bots/) has the three bots; the heuristic uses Chen scores before the flop and enumerated hand strength after it. [test_bots.py](test/engine/test_bots.py) plays 1,000 fuzzed hands per bot at 2 to 9 seats and 300 at mixed tables, all legal; the random and heuristic bots used every action kind. A quick six-seat check over 3,000 hands (not a published evaluation) had the heuristic win about 2 big blinds a hand against five random bots and about 9 against five calling stations.

---

## Phase 3 · Table server v2

**Goal.** Run real no-limit tables of 2 to 9 seats on the new engine. The server must be durable in PostgreSQL, have per-action clocks and a typed v2 protocol, and serve a SvelteKit table that handles every seat count. The phase ends with the live cutover.

**Exit criteria**
- [x] On the live site, one player can play no-limit at 2, 6 and 9 seats against bots, with timers, sitting out and rebuys. (P3.7 evidence)
- [x] Tables and hand histories live in PostgreSQL and survive a live restart mid-hand. (P3.5 and P3.7 evidence)

- [x] **P3.1 · PostgreSQL foundation** · Depends on: none (may start during Phase 2)
  - [x] SQLAlchemy 2 and psycopg 3 are connected through `DATABASE_URL`, with Alembic migrations and an initial schema for tables, seats, hands and hand histories.
  - [x] Tests run against an isolated test database (`RIVERMIND_TEST_DATABASE_URL`). CI provides a PostgreSQL service container. Database tests are skipped only when the variable is unset locally, and the pre-commit full run must include them.
  - [x] `alembic upgrade head` works on an empty database, and a downgrade-then-upgrade test passes.
  - [x] CONTRIBUTING.md documents local PostgreSQL setup. On ubuntu-vm, the database and role for the site are created (no longer an owner gate under D-10).
  - Evidence: `499e356`. [rivermind/db](rivermind/db/) runs SQLAlchemy 2.1.9, psycopg 3.3.9 and Alembic 1.20.1. Migration `0001` creates `poker_tables` (with `jsonb` state), `seats`, `hands` and `hand_histories` (`jsonb` hand records), with check constraints. Against local PostgreSQL 17.11, [test/db](test/db/test_schema.py) passed 16 tests, and the full run with `RIVERMIND_TEST_DATABASE_URL` passed 357. They cover upgrade on an empty schema, downgrade then upgrade, `alembic upgrade`, `current` and `downgrade` run as commands, autogenerate finding no difference from the models, a stored fuzzed hand replaying exactly, and 10 bad rows rejected. Without the variable the database tests skip; with `CI=1` they fail; and they refuse a database named `rivermind`. `DATABASE_URL=… uv run alembic upgrade head` reported `0001 (head)` and created the four tables. The test workflow gains a `postgres:17` service, and CONTRIBUTING has a PostgreSQL section.
  - CI: with the owner’s approval `main` was pushed at `d70623e`. Run [44474555251](https://github.com/dunamismax/rivermind-poker/actions/runs/44474555251) passed: the `test` job ran 357 tests against the `postgres:17` service with none skipped, and the `web` job also passed.
  - Server: ubuntu-vm runs PostgreSQL 18.6, so CI and the docs moved to 18; the local tests also passed on Homebrew PostgreSQL 18.6 (port 5433). [`deploy/setup-database.sh`](deploy/setup-database.sh) created the roles, the two databases, the `app` schema with default privileges, three pg_hba rules before the host’s reject rules and the root-only env files. A second run changed no file. From a scratch copy of this tree on the server, the full suite passed 357 with the database tests on `rivermind_poker_test`, and `alembic upgrade head` with `migration.env` put revision `0001` in `app`, every object owned by `rivermind_poker_owner`. As `rivermind_poker_web` (search_path `app`), rows could be inserted but `CREATE TABLE` was refused, and the `rivermind-poker` service user connected over TCP. `update.sh` and the unit now use these files; they take effect at the next deploy, which was not run.

- [x] **P3.2 · Table manager** · Depends on: P2.5, P2.7
  - [x] Each table is configured with its seat count (2 to 9), blinds and optional ante, and minimum and maximum buy-in (default 40 to 100 big blinds). Hands start automatically with at least two seated players.
  - [x] Players can take a seat, leave, sit out and return, and rebuy in play chips. Button and blind posting follow `docs/rules.md`.
  - [x] Each table runs as an asyncio task. Engine calls stay off the event loop where they could block it.
  - Evidence: `ed07e2a`. [rivermind/server](rivermind/server/) has the synchronous `Table` (seats, buy-ins kept within the range, sitting out and leaving between hands, a leaving player folding or checking at each turn, rebuys added when the hand ends, numbered public events with no unshown cards) and `TableRunner`/`TableManager` (one asyncio task per table, bots deciding through `asyncio.to_thread`, stale decisions dropped, failing bots timed out, busted bots rebuying). [test_table.py](test/server/test_table.py) plays every rules section 5 example and rules 2.2 and 2.3 through the table, and a 4,000-step random fuzz of seating, rebuys and play at 2, 3, 6 and 9 seats conserves chips; [test_runner.py](test/server/test_runner.py) covers automatic hands at 2, 6 and 9 seats, a person playing with bots, a bot blocked in its thread while another table plays 20 hands, and injected sleeps. `uv run python -m rivermind.server.simulate --seats 2,6,9 --hands 500 --seed 0` played 4,903, 678 and 501 hands on three concurrent tables in 2.2 s with chips conserved; a 5 ms heartbeat saw event-loop lag of 0.18 ms median, 0.88 ms p99 and 2.8 ms at most. pytest 391 passed with the database tests.

- [x] **P3.3 · Action clock and disconnects** · Depends on: P3.2
  - [x] Each action has a configurable clock (default 20 seconds) plus a time bank. On timeout the seat checks if it can, otherwise folds. A player disconnected for a full orbit is sat out.
  - [x] Clock and timeout tests use an injected clock, not real sleeps.
  - Evidence: `fd61fc1`. `TableConfig` gains `action_seconds` (20), `time_bank_seconds` (30) and `bank_refill_seconds` (2 per hand dealt in); `Table.check_clock` times out the player to act, and runners wait on `RunnerOptions.clock` ([clock.py](rivermind/server/clock.py)), a `SystemClock` live and a `ManualClock` in tests. Disconnected players get no bank, and anyone away (disconnected or timed out without acting) for an orbit is sat out; rules 13.1 and 13.2 and the Choices table now say so. [test_clock.py](test/server/test_clock.py) (11 tests, no sleeping) covers deadlines, bank spending and refill, the section 13 example played through the table, disconnecting and reconnecting mid-turn, sitting out after an orbit, resetting the count, idle connected players, bots, and runners timing out a person and a stuck bot. A real-time run (0.5 s clock and bank) showed a 1.0 s first turn, 0.6 s turns after the bank emptied and the idle player sat out after three hands. pytest 402 passed with the database tests.

- [x] **P3.4 · Protocol v2** · Depends on: P3.2, P1.2
  - [x] Typed messages cover joining and leaving tables, seat views, ordered events with `seq`, timers, errors and several tables per connection. TypeScript is generated as in P1.2.
  - [x] Server tests cover stale or duplicate actions, actions from the wrong seat, hidden cards and reconnecting at every seat count.
  - Evidence: `e86da16`. [protocol.py](rivermind/server/protocol.py), [app.py](rivermind/server/app.py) and `rivermind-poker serve-nl`; `protocol-schema --version 2` writes `web/src/lib/protocol-v2.ts`. [test_protocol_v2.py](test/server/test_protocol_v2.py) (18 tests, 1.3 s, 8 repeated runs green) runs on a `ManualClock`; the earlier hang was the test discarding the join snapshot, which was already the player's turn. Against a real `serve-nl` on port 8790, one socket followed heuristic-bot tables at 2, 6 and 9 seats for 11, 7 and 6 hands: an old-`seq` fold was refused as `stale`, 12 shown cards and no hidden ones reached the player, and rejoining mid-hand returned the same hand, cards and turn with a `connected` event; after a restart the same token was welcomed (tables are not yet durable). pytest 420 passed with the database tests; web check, lint, Vitest 32, build and Playwright 36 of 36 passed.

- [x] **P3.5 · Durable tables and histories** · Depends on: P3.1, P3.2
  - [x] Table state is stored as versioned JSON in PostgreSQL and saved before any change is broadcast. Finished hands are stored as histories. Tables are restored at startup, matching the RM-10 behaviour.
  - [x] A test kills the server process mid-hand, and a new process restores the table identically.
  - Evidence: `4fe2606`. [snapshot.py](rivermind/server/snapshot.py) writes `table` documents with `"format": 1`; [store.py](rivermind/server/store.py) saves them to `poker_tables.state` from a `before_publish` hook in a worker thread, mirrors `seats`, and writes `hands` and `hand_histories`; `serve-nl` reads `DATABASE_URL` and restores open tables with their people marked disconnected. No migration was needed: `0001` already had the columns. [test_snapshot.py](test/server/test_snapshot.py) plays 3,000 random steps (seating, leaving, rebuys, connections, clock timeouts) at 2, 3, 6 and 9 seats twice, once reloading the table through JSON after every step, and the event streams and final snapshots match. [test_durable_tables.py](test/db/test_durable_tables.py) checks the store, that every published change was already saved, that each stored history replays, and a real `serve-nl` killed with SIGKILL mid-hand whose restart saves the identical snapshot apart from the player's disconnection and then plays on. By hand against a scratch database, three tables at 2, 6 and 9 seats were frozen mid-hand, the process was killed with `kill -9`, and the restarted server returned the same hand, hole cards, board, pot and legal actions at each before two more hands were played and stored. pytest 435 passed with the database tests (none skipped), five repeat runs of the server and durability tests passed, and `python -m rivermind.server.simulate` still conserves chips.

- [x] **P3.6 · SvelteKit table for 2 to 9 seats** · Depends on: P3.4, P1.6
  - [x] An oval layout places 2 to 9 seats, adapting from phone to desktop. A bet control offers a slider and presets: minimum, ½ pot, ¾ pot, pot and all-in, clamped to the legal range.
  - [x] The table shows timer rings, sit out and back, leave and rebuy. Playwright tests play hands at 2, 6 and 9 seats in all three browsers.
  - Evidence: `b722800`. The `/nl` route ([web/src/lib/nl/](web/src/lib/nl/)) plays protocol v2: lobby (seats, bots, blinds, buy-in), oval table with the viewer at the bottom, hand-placed seat positions generated into CSS classes (the CSP blocks inline styles), SVG timer rings for the action time and time bank, the bet panel, sit out and back, rebuy and leave. Vitest 49 passed (17 new: pot-size presets and clamping, wording, seat spacing on the phone felt, the stale-CSS check, and the connection store against a mock socket). `e2e/nl.e2e.ts` starts `serve-nl` per worker and plays hands at 2, 6 and 9 seats, uses the presets and a clamped typed amount, sits out (no hand is dealt while the only person is out), comes back, rebuys and leaves, and reloads into the same hand and cards: `pnpm e2e` 72 of 72 in Chromium, Firefox and WebKit at both sizes, and 72 of 72 again with the new tests repeated twice, with no CSP violations. By hand in the browser pane against `serve-nl --client_dir web/build`: a 9-seat table at 1440×900 and 375×812 with no overlapping seats or horizontal scroll, a pot-sized raise to 2,600 applied, and a reload rejoining the table. pytest 435 passed; check, lint and build passed.

- [x] **P3.7 · Live cutover** · Depends on: P3.3, P3.5, P3.6 · **Owner gate:** deploy (Q-2 decided as D-11)
  - [x] The live site serves no-limit tables against the Phase 2 bots, with the short-deck prototype handled as Q-2 decides. Open prototype tables are closed with a clear message.
  - [x] The deployment unit and Caddy site are updated, and the service connects to PostgreSQL. A live restart mid-hand and a smoke test at 2, 6 and 9 seats are verified in a browser.
  - Evidence: `b571dc8` and `a62ec52`, deployed with the owner’s approval by `deploy/update.sh` (the server’s run passed 435 tests with the database tests; the service came up in about 2 s). The no-limit table is the client’s `/` page. The unit runs `serve-nl` with `web.env` and `/var/lib/rivermind-poker/secret` (created mode 600). A short-deck page left open gets `unknown_table` with a closed-tables message, and a browser holding a short-deck seat sees the notice in the lobby; the browser pane, which still held one, showed it on the live site. Caddy now rate-limits `POST /api/players` too. Before deploying, `pnpm e2e:live` against a local `serve-nl` with PostgreSQL and live timings found an edge seat’s turn ring widening the phone page by 3 px, fixed in `b571dc8`. After deploying, `LIVE_RESTART_COMMAND="ssh root@ubuntu-vm systemctl restart rivermind-poker" pnpm e2e:live` passed 10 of 10 (Chromium desktop and WebKit phone): headers, a hand at 2, 6 and 9 seats against RiverMind Easy bots, and a `systemctl restart` mid-hand that returned the same hand, hole cards and turn. A new live check of a turn clock, sitting out, coming back and rebuying passed on both. PostgreSQL then held 15 hand histories, the journal showed `Restored 2 table(s)` after each restart and no errors, and every test table closed once left. CI runs 44546547360 and 44546916133 passed. The old `tables.sqlite3` stays in the state directory, unused.

---

## Phase 4 · Multiplayer and identity

**Goal.** Anonymous people can find each other in a lobby and play at the same tables safely and fairly, each with a persistent play-chip balance.

**Exit criteria**
- [x] Two players in different browsers play together on the live site, with bots filling the empty seats. (P4.3 deploy: the live smoke test “two people play together from the lobby”.)
- [x] The chip ledger always balances, and the authorization tests show no one can act for, or see the cards of, another player. (P4.2 and P4.4 evidence; the card checks are in [test_lobby.py](test/server/test_lobby.py) and [test_protocol_v2.py](test/server/test_protocol_v2.py).)

- [x] **P4.1 · Anonymous player identity** · Depends on: P3.7
  - [x] A first visit creates a player with a random display handle. The session cookie is signed, `HttpOnly`, `Secure` and `SameSite=Lax`.
  - [x] WebSocket and HTTP requests authenticate by the cookie, and requests from other origins are rejected. Tests cover a missing, forged or expired session.
  - Evidence: `60e5258`. `POST /api/session` makes a player with a handle such as `Sly Seal 7` (360,000 combinations, unique by constraint, retried on a clash) in the new `players` table (migration `0002`) or in memory, and sets `rm_session`: player id and issue time under HMAC-SHA256, `HttpOnly`, `SameSite=Lax`, `Path=/`, 180 days, renewed after a day, `Secure` except over plain HTTP to a loopback host (Playwright’s WebKit drops `Secure` cookies there). It replaces the bearer token on `POST /api/tables` and `/ws`; unsafe requests and handshakes from another host’s `Origin` get 403 (loopback-to-loopback, for the Vite proxy, and `--allowed_origin` are allowed). A Phase 3 token sent once as `legacy_token` keeps its player and guest handle; a Phase 3 page saying hello with a token is told to reload. [test_identity.py](test/server/test_identity.py) (22 tests) covers the cookie flags, renewal, ten kinds of bad session over HTTP and the socket (missing, forged, another player’s id, moved issue time, another secret, expired, future, a Phase 3 token, unknown player, garbage), other origins and the legacy move; [test_players.py](test/db/test_players.py) covers stored handles (it caught `rowcount` misreporting an `ON CONFLICT DO NOTHING`, fixed with `RETURNING`) and a session outliving a restart. Against a real `serve-nl` with a scratch PostgreSQL database, curl showed the cookie flags, `Secure` with `X-Forwarded-Proto: https` and a public `Host`, 401 without a cookie and 403 with `Origin: https://evil.example`; a socket from that origin got 403, a same-origin one `welcome`. In the browser pane a fresh visit was “Gilded Stoat 81”, sat down, and after `kill -9` and a restart the reload rejoined the same hand as the same player. pytest 462 passed with the database tests; web check, lint, Vitest 59 and build passed, and `pnpm e2e` 42 of 42 in Chromium, Firefox and WebKit at both sizes, with a new test of the cookie flags, no token in `localStorage` and a second browser being someone else. Not deployed.

- [x] **P4.2 · Play-chip wallet and ledger** · Depends on: P4.1, P3.1
  - [x] New players get a starting grant, and balances below a threshold are topped up daily. Buy-ins and cash-outs are ledger entries, and balances can never go negative. D-1 copy appears wherever chips are shown.
  - [x] A test checks that ledger totals equal balances after randomized play.
  - Evidence: `1bee972`. Migration `0003` adds `players.balance` (checked `>= 0`), `granted_at` and `ledger_entries` (kind, signed amount whose sign must match the kind, `balance_after >= 0`). [wallet.py](rivermind/server/wallet.py): a 20,000 grant on the first visit, a top-up to 10,000 at most once a day, debits in one conditional `UPDATE … RETURNING`; buy-ins and rebuys are paid before reaching the table and refunded if refused; cash-outs, returned rebuys and idle-table closes are paid in the table save’s transaction. The table now returns a waiting rebuy to a player who leaves (it used to vanish) and records dropped or trimmed rebuys as departures. The lobby shows the balance beside the D-1 statement and offers only affordable buy-ins; the table carries a play-chips line. [test_wallet.py](test/server/test_wallet.py) plays four people over 600 random steps (three seeds) through the app’s `Server`, checking after every step that each ledger sums to its balance and nothing is negative, and at the end that the wallets hold exactly grants plus top-ups plus what bots brought minus what bots kept; dropping refunds made two of three seeds fail. [The database version](test/db/test_wallet.py) runs the same play on PostgreSQL, checks every `balance_after` chain and all six entry kinds, 16 concurrent 3,000-chip debits on 20,000 (six paid, ten refused), concurrent first visits paying one grant, and seven bad ledger rows refused. Against a real `serve-nl` with a scratch database, in the browser pane: 20,000 shown; sat down for 10,000 and left mid-hand, cashed out 9,950; at 100/200 the lobby picked the largest affordable buy-in (14,000); with the grant aged two days a reload topped 5,950 up to 10,000; after `kill -9` and a restart, leaving paid one cash-out of 13,800 and the lobby showed 23,800, equal to the ledger sum. pytest 478 passed with the database tests; check, lint, Vitest 54 and build passed; `pnpm e2e` 48 of 48, with a new wallet test. Not deployed.

- [x] **P4.3 · Lobby and seating** · Depends on: P4.1
  - [x] A live table list shows stakes, seats and players, with filters. Players can quick-seat, create a private table with an invite link, join a waitlist and reserve a seat.
  - Evidence: `dedc77c`. `GET /api/tables` lists public tables (and private ones the viewer is at) with `seats`, `big_blind` and `open` filters, most people first; the lobby polls it every 3 s. `POST /api/quick-seat` takes the busiest matching public table or starts one with bots. Bots keep seats warm: `POST /api/tables/{id}/seat` takes a bot's seat at once between hands, or holds it until the bot's hand ends; a held seat waits 60 s for its player (rule 2.4, in the table core and snapshot format 2, which still reads format 1), `hold_only` reserves without buying in, and the page sits automatically when the hold is ready. A full table has a first-come waitlist that gets the next free seat; a seat nobody takes goes back to a bot. Private tables are unlisted, need their 16-character invite (`/?invite=…`, `GET /api/invites/{code}`) and refuse sockets from non-members. Lobby settings are saved with each table and restored. New tests: [test_seating.py](test/server/test_seating.py) (8, the table rules), [test_lobby.py](test/server/test_lobby.py) (6 over HTTP and the socket, including two people playing three hands with no card leaking, a waitlist and a hold running out on the clock), a restart test in [test_durable_tables.py](test/db/test_durable_tables.py), and lobby actions in the wallet's random play (ledgers still balance); [lobby.e2e.ts](web/e2e/lobby.e2e.ts) runs two and three browser contexts. In the browser pane against `serve-nl` with a scratch database and curl players: the list and filters; joined a waitlist, then a bot's seat mid-hand, sat automatically when the hand ended; when a player left the full table the lobby offered the held seat; a private table's invite worked for a curl player and gave 404 without it; at 375×812 the lobby, a spectator's “Sit here”, the 60 s hold and buy-in; no console or server errors. The hand log mislabelled a seat that changed hands; it now keeps each event's name. Caddy rate-limits the seating endpoints (`caddy adapt` passed on ubuntu-vm). pytest 493 passed with the database tests; check, lint, Vitest 62 and build passed; `pnpm e2e` 66 of 66.
  - Deployed: with the owner's approval, pushed `main` and deployed `5544a20` (with P4.4) using `deploy/update.sh`: the server's 500 tests passed, no migrations were pending, Caddy took the seating rate limit, and the service restored its open table from a format 1 snapshot. `pnpm e2e:live` passed 12 of 12 against https://rivermindpoker.com, with `LIVE_RESTART_COMMAND` for the restart mid-hand, plus a new live test in which two browser contexts meet in the lobby, one takes a RiverMind Easy bot's seat, and both play on (Chromium desktop and WebKit phone).

- [x] **P4.4 · Multi-human correctness** · Depends on: P4.2, P4.3
  - [x] A player holds at most one seat per table, enforced on the server. Concurrent action race tests are added.
  - [x] A Playwright test with two browser contexts covers two humans and one bot playing several hands, including disconnecting and reconnecting.
  - Evidence: `188d532`. The table core refuses a second seat or hold (`already_seated`) under the runner's lock. [test_races.py](test/server/test_races.py) sends requests at once through the app's `Server`, with wallet payments in worker threads so they interleave: one player's three tabs asking for five seats at once get one, paid once; two players racing for the last seat get one winner and one full refund; two tabs acting on one turn count once (the others `stale` or `not_your_turn`); three people with two tabs each send 150 rounds of random concurrent requests (three seeds), checking after each round that nobody holds two seats or holds while seated and every ledger balances; and neither another player, a watcher nor anyone in a bot's seat can act. Removing the one-seat check makes two of them fail. [multiplayer.e2e.ts](web/e2e/multiplayer.e2e.ts) seats two people (separate browser contexts) and a bot, plays two hands, drops one person's socket (their seat shows Away), brings them back to the same seat and plays two more. Running the suites under load (eight busy CPU loops or the browser suite alongside) showed random-play coverage counts, not ledgers, failing when timing kept a rebuy, hold or sit from going through; those checks now accept an attempt, and the race test's host stays seated so its tables stay open. A forced click on the hidden seat-count radio could land elsewhere while the table list above it changed height on phones; the helper clicks in place (Playwright's `dispatchEvent` crashed Firefox pages, `element.click()` does not). pytest 500 passed with the database tests; check, lint, Vitest 62 and build passed; `pnpm e2e --repeat-each 3` 216 of 216. Deployed with P4.3 (see its evidence).

- [x] **P4.5 · Safety and abuse controls** · Depends on: P4.3
  - [x] Rate limits apply in Caddy and the app. Handles are filtered and can be reported, and a player can mute or block another. Q-4’s default applies: preset reactions only, no free text.
  - [x] Basic collusion signals are logged, such as the same network address at one table, for later review.
  - Evidence: `5c273cc`. [safety.py](rivermind/server/safety.py) and migration `0004` (`player_reports`, `player_relations`, `safety_signals`). The app's token buckets limit unsafe HTTP requests per player or address (429 with `Retry-After`), new players per address and socket messages (a `rate_limited` error, then the socket closes after 50 refusals in a row); Caddy gains a `safety` zone, and `caddy adapt` passed on ubuntu-vm. Behind Caddy the address comes from `X-Forwarded-For`, trusted only from a loopback peer. Eight preset reactions (`react` in, `reaction` out) reach every follower who has not muted or blocked the sender; seats carry a public `ref` (a hash of the id). `POST /api/reports` (once a day per reporter, person and reason, locked against concurrent repeats), `GET`/`PUT`/`DELETE /api/relations`; quick seat skips tables with a blocked player and the lobby tags them. A person sitting with someone from the same address stores one `same_address` signal per table and pair, with an HMAC of the address. `rivermind-poker moderation reports|signals|rename`. Every generated handle passes a word filter that reads each word on its own and spaced-out letters together (all 3,600 word pairs checked). New tests: [test_safety.py](test/server/test_safety.py) (30) and [the database version](test/db/test_safety.py) (3, including eight concurrent identical reports counting once and the CLI); [safety.e2e.ts](web/e2e/safety.e2e.ts) has two browser contexts react, mute, report twice, block and unblock. Against a real `serve-nl` with a scratch database, in the browser pane: the seat menu, reactions on the seat, the Blocked tag in the lobby, and a 375×812 table with no horizontal scroll; curl got 60 requests then 429 with `Retry-After: 1`; `moderation signals` listed the same-address signal from the browser and curl players. pytest 539 passed with the database tests; check, lint, Vitest 64 and build passed; `pnpm e2e` 78 of 78.

- [x] **P4.6 · Fair dealing and transparency** · Depends on: P3.2
  - [x] Live shuffles use `secrets.SystemRandom` (D-8). Players can view histories of hands they played, with every revealed card. A rules and fairness page explains how dealing works.
  - Evidence: `498be82`. A test runs `serve-nl` through its CLI and finds its tables dealing from `secrets.SystemRandom`. Each finished hand records who played each seat (`table.Finished`), stored in `hand_players` with each seat's net (migration `0005`; no foreign key, since pre-P4.1 players may lack a row) or kept in memory ([hands.py](rivermind/server/hands.py)). `GET /api/hands` (newest first, `limit` up to 50, `before` for paging) and `GET /api/hands/{id}` (404 to anyone not dealt in) return the player's cards, the board, posts, actions, pots, the hands shown at showdown and a named text history from `format_text(viewer=seat)`. The client's `/hands` page lists and opens them (`?hand=ID` opens one) and `/fairness` explains the shuffle, private dealing, bots' views, histories and the table rules; the lobby links both. [test_hands.py](test/server/test_hands.py) plays six heads-up hands between two people and checks, against the stored deck, that each sees their own cards and the shown hands but no folded or mucked card in the body or text, that nets cancel, that a third player gets 404, paging and the memory archive's limits; [the database version](test/db/test_hands.py) checks the rows and that a new process lists and opens the same hands; [hands.e2e.ts](web/e2e/hands.e2e.ts) plays three hands, opens one, follows the links and checks phone width (which caught the board overflowing at 375 px). In the browser pane against `serve-nl` with a scratch database: the list, a showdown hand with both hands shown and nets, and the fairness page. A parallel session was redrawing the card art in the shared tree, which broke the build there, so the final checks ran in a scratch copy of `main` plus these changes: pytest 548 passed with the database tests; check, lint, Vitest 64 and build passed; `pnpm e2e` 90 of 90.

- [x] **P4.7 · Optional sign-in** · Depends on: P4.2 · **Owner gate:** Q-1 · **Declined for 1.0** (D-12)
  - [x] If the owner approves Q-1: passkey (WebAuthn) sign-in that claims the current guest identity, so chips and history follow the player across devices. Otherwise record the decision and tick this step as declined.
  - Evidence: the owner answered Q-1 on 2026-11-19: no logins or user accounts until after 1.0. Recorded as D-12; optional sign-in is listed in Phase 8.

---

## Phase 4B · TypeScript stack migration

**Goal.** Run the live site on the D-14 stack: SvelteKit 3, Svelte 5, TypeScript, Tailwind CSS 4, PostgreSQL 18 with Drizzle ORM, and Node through `adapter-node`, behind Caddy. Players see no change except a short reconnect at the cutover. Python keeps only the offline work: the reference engine, card tables, training and evaluation.

**Starts now** (owner, 2026-11-20). It comes before P5.5. Blueprint training (the `hu-m1-s0` run) keeps going on this Mac and is not affected. Until P4B.7 the live site stays on `serve-nl`, and fixes to it stay in Python.

**Ground rules**
- Wire compatibility. Protocol v2, the HTTP API, session cookies (HMAC-SHA256 over the same fields and secret), table snapshots and hand histories keep their formats, so the existing client, open tables, stored hands and guests’ cookies survive the cutover unchanged. Any format change gets a version bump and a reader for the old version.
- The Python engine is the reference. The TypeScript engine must produce byte-identical hand histories for the same deals and actions, and CI checks this on every push.
- Port tests along with code. A Python test that guards a behaviour gets a Vitest or Playwright counterpart before the Python code is removed. The Playwright suite is the end-to-end parity check.

**Exit criteria**
- [ ] The live site runs on the Node service. Caddy proxies to it, and nothing in the serving path imports Python. (P4B.7 evidence)
- [ ] The engine and bot parity checks pass in CI, and the web suite (check, lint, Vitest, build, Playwright in three browsers) passes against the Node server with a real PostgreSQL. (P4B.4, P4B.6 and P4B.7 evidence)
- [ ] `rivermind/server`, `rivermind/db`, Alembic and the FastAPI, Uvicorn, SQLAlchemy and psycopg dependencies are gone, and the docs describe the new stack. (P4B.8 evidence)

- [ ] **P4B.1 · Node server on `adapter-node`** · Depends on: none · **Owner gate:** deploy
  - [x] `web/` builds with `@sveltejs/adapter-node`. A custom server (for example `web/server/index.ts`, compiled into the build) mounts the adapter’s `handler.js` and a `ws` WebSocket server on `/ws` on one `http` server. It honours `PORT` and `HOST` itself, answers `/healthz`, and on SIGTERM stops taking sockets, lets in-flight changes finish and then exits.
  - [x] Until P4B.7, setting `RIVERMIND_LEGACY_API` (for example `http://127.0.0.1:4316`) forwards `/api/*` and `/ws` to `serve-nl`, so the app runs against the Python server in development, in Playwright and in CI.
  - [x] The table and lobby stay client-rendered (`ssr = false` on their routes). `kit.csp` in hash mode, or SvelteKit’s nonces, keeps the no-inline-code CSP true for server-rendered pages, and `pnpm build` still fails on inline script or style.
  - [x] Node is pinned to one LTS major in `web/.node-version` and `engines`. `pnpm check && pnpm lint && pnpm test && pnpm build && pnpm e2e` pass in Chromium, Firefox and WebKit against the Node server forwarding to `serve-nl`. CONTRIBUTING.md documents the new commands.
  - [ ] Added in this step, because the static deploy cannot serve a Node build. `deploy/update.sh` publishes each build as a release that `rivermind-poker-web.service` runs on 127.0.0.1:4320. Caddy sends pages and assets there and `/api/*` and `/ws` straight to `serve-nl`, and keeps the pages’ own CSP. The pieces are written and checked; deploying them is the owner gate, after which `pnpm e2e:live` must pass.
  - Evidence: P4B.1 commit (see the handoff log). `web/server/` (`app.ts`, `legacy.ts`, `index.ts`) is bundled with `ws` into `build/start.js` by `vite.server.config.ts`. Vitest has 13 tests for the server and CSP helper (forwarding with Host, Origin, cookies and X-Forwarded-For, 503 while `serve-nl` is down, the spliced socket, 1013 without a legacy server, draining on close). `pnpm build` runs `scripts/check-inline-code.js`, which fetched `/`, `/fairness`, `/hands` and `/style` from the built handler and failed as intended on a test inline `<script>` and a test style attribute. Check, lint, Vitest (77), build and Playwright passed: 102 tests in six projects, plus the new `site.e2e.ts` (headers, hashed CSP, immutable caching, 404s, `/healthz`) in all six. The Caddy site validated against the host’s Caddyfile on ubuntu-vm in a temporary copy. Run locally with Caddy, Node and `serve-nl`, pages kept Node’s hashed CSP, the API got Caddy’s, `/ws` reached `serve-nl`, a stopped Node gave the 503 text, and a hand was played in the browser pane with no console errors.
  - Remaining: deploy with the owner’s approval, then run `pnpm e2e:live` and tick the last criterion and the step.

- [ ] **P4B.2 · Tailwind CSS 4** · Depends on: P4B.1
  - [ ] Tailwind 4 runs through `@tailwindcss/vite` with `@import "tailwindcss"` in the app stylesheet. `pnpm art` writes the palette, the RiverMind Pixel font and the whole-number spacing and 10px text steps as an `@theme` block (generated, never edited by hand, replacing `palette.css`), so the utilities offer only palette colours and the kit’s sizes. The Vitest art checks cover the new file.
  - [ ] Components and pages move from scoped CSS to utilities. Scoped CSS stays only where utilities cannot express a rule: nine-slice frames, the card `--k`/`--dpr` snapping and keyframes. [docs/design.md](docs/design.md) and the `/style` page describe the Tailwind tokens.
  - [ ] No visual change. Screenshots of the lobby, a 2-seat and a 9-seat table, the action dock, the result and `/style`, at 375×812, 768×1024 and 1440×900 and at DPR 1, 2 and 3, match the pre-Tailwind build pixel for pixel, or each difference is listed and approved by the owner. The built CSS is no larger than today’s plus 10%.

- [ ] **P4B.3 · Drizzle schema and migrations** · Depends on: P4B.1
  - [ ] `web/src/lib/server/db/schema.ts` declares every table, index, constraint and default of Alembic head `0006` in the `app` schema with `pgSchema('app')`, starting from `drizzle-kit pull` and then cleaned up by hand. Drizzle connects through node-postgres and a pool sized for the 2 GB unit.
  - [ ] A baseline Drizzle migration creates exactly Alembic’s schema. Verify by applying each to an empty PostgreSQL 18 database and comparing `pg_dump --schema-only` (ignoring `alembic_version` and Drizzle’s own journal table): no differences.
  - [ ] A migration script runs pending migrations as `rivermind_poker_migration` and switches to the owner with `SET ROLE` from `RIVERMIND_MIGRATION_ROLE`, as Alembic does now. Against a copy of the live database it marks the baseline as applied without changing a row or a table. `deploy/setup-database.sh` grants what the script needs.
  - [ ] Vitest database tests use `RIVERMIND_TEST_DATABASE_URL`, refuse a database whose name lacks `test`, and run in CI against the `postgres:18` service.

- [ ] **P4B.4 · TypeScript engine** · Depends on: P4B.1
  - [ ] `web/src/lib/server/engine/` ports `rivermind/engine` (cards, evaluator, state, pots, seating, view, history) to TypeScript with the same immutable state and caller-supplied randomness. Code that is safe for browsers, such as the evaluator for naming replay hands, lives in `web/src/lib/engine/`.
  - [ ] Every rule hand in `test/engine/fixtures.py` is exported to JSON and passes in Vitest with its hand-worked stacks. The evaluator agrees with the Python one on all 133,784,560 seven-card hands, or on a seeded sample of at least 10 million plus every category boundary.
  - [ ] Differential fuzz. A Python command writes seeded action sequences for 100,000 hands at 2 to 9 seats. The TypeScript engine replays them, and the hand-history JSON is byte-identical. CI runs a 5,000-hand slice on every push. A TypeScript benchmark that matches `python -m rivermind.engine.bench` is recorded in the evidence beside the Python result.

- [ ] **P4B.5a · Players, wallets, lobby and safety in TypeScript** · Depends on: P4B.3, P4B.4
  - [ ] Server routes (`+server.ts`) and server modules port the HTTP API of `rivermind/server/app.py`: sessions and identity (cookies signed as now, so existing guests stay signed in), wallets and the ledger, top-ups, the lobby, quick seat, held seats, waitlists, private tables and invites, practice, reactions, mutes, blocks, reports, collusion signals, “Your hands” and the fairness page, all on Drizzle. Requests, responses and error codes match protocol v2.
  - [ ] App rate limits (P4.5) are on by default and can be switched off in tests. Protocol v2 types are TypeScript source with runtime validation of every incoming body and message. `protocol-v2.ts` is no longer generated from Python, and a contract test replays recorded v2 transcripts from `test/server/test_protocol_v2.py` against the new server.
  - [ ] The behaviours in `test_identity.py`, `test_wallet.py`, `test_lobby.py`, `test_seating.py`, `test_practice.py`, `test_safety.py` and `test_hands.py` have Vitest counterparts that pass against PostgreSQL. Each wallet test checks that the ledger balances.

- [ ] **P4B.5b · Tables, clocks and sockets in TypeScript** · Depends on: P4B.5a
  - [ ] The table runner, table, clock, snapshot and players modules move to TypeScript. Every change is applied, saved and published in one task that a closed socket or an aborted request cannot cancel, as `TableRunner._change` guarantees today. Live shuffles use `crypto.randomInt` (D-8), and a test checks a CLI-started server deals from it.
  - [ ] Snapshots and hand histories written by `serve-nl` load and play on in the Node server. A test restores Python-written fixtures mid-hand, finishes the hand and checks stacks, pots and the ledger.
  - [ ] The behaviours in `test_runner.py`, `test_table.py`, `test_clock.py`, `test_snapshot.py`, `test_races.py` and `test_protocol_v2.py` have Vitest counterparts with a manual clock. The whole Playwright suite passes against the Node server with no legacy forwarding, including both restart tests.

- [ ] **P4B.6 · Bot serving in TypeScript** · Depends on: P4B.4
  - [ ] The random, calling-station and RiverMind Easy bots are ported. On the fuzz deals, each picks the same actions as its Python counterpart for the same seeds.
  - [ ] `rivermind-poker blueprint export <checkpoint>` writes a versioned serving bundle: the `uint8` average strategy, the tree layout and the card-table arrays in flat little-endian files, with a manifest naming the checkpoint, the table set and every file’s SHA-256. The Node server memory-maps or reads it once and refuses a bundle whose hashes or table set do not match.
  - [ ] A TypeScript `BlueprintPolicy` (the action mapping, re-entry and nearest-bucket fallback from [docs/bots.md](docs/bots.md#mapping-real-actions-onto-the-tree)) gives the same action probabilities as the Python one, to within 1e-9, on at least 100,000 recorded decisions from `hu-m1-s0`. Card-bucket lookups agree on every hole-card pair for a seeded sample of boards on each street. Decision time p95 under 200 ms is measured on this Mac and recorded; P5.7a measures it on ubuntu-vm.

- [ ] **P4B.7 · Cutover** · Depends on: P4B.2, P4B.5b, P4B.6 · **Owner gate:** deploy
  - [ ] `rivermind-poker-web.service` (from P4B.1, on 127.0.0.1:4320) takes over the tables, with the 2 GB high and 3 GB maximum memory limits and `web.env`, and `rivermind-poker.service` stops. `deploy/update.sh` installs with `pnpm install --frozen-lockfile`, runs the web suite (and the Python suite for the offline tools) against the test database, runs the Drizzle migrations with `migration.env`, builds, switches the release and restarts the service.
  - [ ] [The Caddy site](deploy/rivermindpoker.com.caddy) sends `/api/*` and `/ws` to Node as well, keeping the `new_tables`, `seating` and `safety` rate-limit zones, the security headers, the 16 KB body limit, the five-minute stream close delay for `/ws` and year-long caching of `/_app/immutable/`. The CSP stays as strict as it is now.
  - [ ] With the owner’s approval, deploy during light traffic. Afterwards, open tables are restored, an existing guest keeps their cookie, balance and hands, and `pnpm e2e:live` passes on phone and desktop sizes. Record the revision, the release, the restored tables and a rollback to `serve-nl` that was rehearsed beforehand on a copy of the database.

- [ ] **P4B.8 · Retire the Python server** · Depends on: P4B.7 and a week of live play without a rollback
  - [ ] Remove `rivermind/server`, `rivermind/db`, the Alembic configuration and its migrations (keeping them in Git history and recording the last revision in [docs/build-history.md](docs/build-history.md)), the `serve-nl` command and the FastAPI, Uvicorn, SQLAlchemy, psycopg and Pydantic-schema dependencies that only the server used. The legacy `serve` stays until P7.6 only if it still runs without them; otherwise it goes too, as Q-7’s default allows.
  - [ ] What remains in Python is `rivermind/engine`, `rivermind/bots`, `poker_ai` and their CLIs, and their suite passes. CI has a Python job for them, a web job, and the engine and bot parity jobs.
  - [ ] README, CONTRIBUTING, AGENTS, [docs/roadmap.md](docs/roadmap.md), [docs/design.md](docs/design.md) and the Phase 0 operations facts describe the new stack. P5.7a, P5.9, P7.3 and P7.4 name the Node server.

---

## Phase 5A · Practice, heads-up opponent and replay

**Starts after Phase 4.** P6.0b shipped before the stack change; P5.5 onward starts after Phase 4B (D-14). The player milestones below are in execution order. The bot work between practice and replay is limited to what it takes to qualify and serve one heads-up opponent. Multi-seat training, additional difficulty levels and shareable replays have their own later steps.

### 1. Start a practice hand in one click

- [x] **P6.0b · One-click practice at any balance** · Depends on: P3.7, P4.2, P4.5, P4.6
  - [x] A prominent “Practice vs bots” action starts a heads-up hand against the labelled RiverMind Easy bot from the lobby. Seats, blinds and a practice stack have defaults, so the first hand takes one click for a new guest or a guest at zero chips before their next top-up is due.
  - [x] Each guest can resume one active practice table after reload. Only that guest can access it. Concurrent start requests return the same table, and abandoned tables expire under the server’s existing capacity and rate limits.
  - [x] A player who busts can start another hand with a fresh practice stack. Practice chips stay at the table. Practice hands appear in “Your hands” with a practice label. On phone and desktop, verify the first hand, reload and playing again after a bust. Server tests check that practice leaves the wallet and ledger unchanged, marks stored hands for exclusion from competitive stats and refuses access to a second guest.
  - Evidence: `99c08ea`. `POST /api/practice` seats the guest at a private two-seat table (50/100) against RiverMind Easy with `--practice_stack` chips (10,000 by default), or returns their table; per-guest locks make concurrent starts return one table. Practice tables pay nothing to or from wallets, are kept out of the lobby, quick seat and seat or waitlist requests, refill a busted guest with `rebuy`, close after an hour unwatched when the server needs room, and mark `poker_tables.practice` (migration `0006`), so hands carry `practice`. Checks: [test_practice.py](test/server/test_practice.py) (8 tests) and the restart test in [test/db/test_hands.py](test/db/test_hands.py); [practice.e2e.ts](web/e2e/practice.e2e.ts) in all six browser projects (new guest: first hand, reload to the same table, bust, “Play again”, labelled hands, wallet unchanged; zero-balance guest); full pytest 557 of 558 with the database (the random-play coverage check missed a `hold` attempt at load average 27, then passed 3 of 3 alone), Vitest 64, `pnpm e2e` 102 of 102. In the browser pane at phone width: one click, reload, bust, “Play again” and the hands page, wallet 20,000 with only the grant.

### 2. Play one evaluated heads-up opponent

- [x] **P5.1 · Abstraction design** · Depends on: P6.0b, P2.7
  - [x] `docs/bots.md` defines the bot design:
    - the action abstraction for each street (for example fold, check or call, ½ pot, pot, 2× pot and all-in);
    - how off-tree bets map to the abstraction;
    - the card abstraction: 169 lossless pre-flop classes, and post-flop buckets clustered on hand-strength distributions;
    - the info-set key format;
    - memory and training-time estimates for heads-up on this Mac (Q-5). Add estimates for 6-max and 9-max at P5.6.
  - Evidence: `919ba16`. [docs/bots.md](docs/bots.md) fixes `hu-m1`: heads-up without an ante at 50 and 100 big blind depth classes, three or fewer sizes a node plus all-in, pseudo-harmonic mapping with re-entry, 169 lossless classes and 1,000 equity-distribution buckets a street, and text and slot keys. Throwaway scripts outside the repo (described in the doc) built three candidate trees through the engine (3,772, 11,708 and 52,084 decision nodes at 100 bb) and timed external-sampling MCCFR on the compiled medium tree: 21,107 iterations/s on one core and 113,567 on ten. They also counted the suit classes by Burnside’s lemma (169, 1,286,792, 13,960,050 and 123,156,254) and timed river equity at 0.51 ms a board, giving 352 MB of training tables and about 9 hours of heads-up training, with card tables under 2 hours. The worked examples (the key’s history, 250 open, 375 bet, 1,900 pot raise, *p* = 0.533) were replayed on the engine. pytest 558 passed with the database tests.

- [x] **P5.2 · 52-card clustering pipeline** · Depends on: P5.1
  - [x] The clustering is generalized to the full deck. Simulations and K-means are seeded so table generation is reproducible. Each table set has a manifest with its settings, version and SHA-256.
  - [x] Generation time and peak memory are measured and recorded.
  - Evidence: `401b49e`. [rivermind/bots/cards](rivermind/bots/cards/) and `rivermind-poker tables build`, `verify` and `bucket` implement the [docs/bots.md](docs/bots.md#card-abstraction) card abstraction with exact enumeration (no simulation) and their own seeded k-means; scikit-learn's parallel k-means changed centroids between runs. Three full builds (10 and 6 workers before the commit, 10 from it) gave byte-identical files, 421 MB in 16 files. The canonical set `artifacts/tables/hu-m1` was built from `401b49e` in 193 s with a peak of 3.2 GB summed over processes; the six-worker build took 200 s and 2.3 GB. Its manifest, hashes and timings are in [the table sets](docs/bots.md#table-sets). All 1,000 buckets are used on each street, and bucket order tracks mean equity (rank correlation 0.988 on the flop and 0.994 on the turn, over 400 random hands). Lookups give the same bucket under every suit relabelling and take about 5 µs. [test_card_tables.py](test/engine/test_card_tables.py) checks the class counts against Burnside, river equity against brute-force enumeration, the histograms against direct recomputation, seeded clustering, and a limited build through the CLI (reproducible, verified, tamper and stray-file detection, refusal to overwrite). pytest 570 passed with the database tests.

- [x] **P5.3 · Heads-up training** · Depends on: P5.2, P2.6
  - [x] Monte Carlo CFR runs on the new engine with linear discounting and pruning, using several cores. It keeps the RM-02 and RM-04 guarantees: exact resume, consistent checkpoints and atomic writes.
  - [x] Checkpoints carry a manifest: engine version, abstraction and table hashes, settings and iteration count.
  - Evidence: `b6fa49f`, `d2dd215`. [rivermind/bots/blueprint](rivermind/bots/blueprint/) and `rivermind-poker blueprint` (`tree`, `train`, `info`, `strategy`) are described in [docs/bots.md](docs/bots.md#training-p53). The trees compiled from the engine match P5.1 exactly (11,708 and 5,472 decision nodes, 43,937,574 slots). On Kuhn poker the trainer reaches an exploitability of 0.011 with seat 0's value within 0.005 of −1/18. Through the CLI on the hu-m1 tables, 768,000 iterations with discounting and pruning gave byte-identical `regrets.npy` and `strategy.npy` from 10 workers straight through and from 6 workers stopped by Ctrl-C at 448,000 and resumed on 3. A probe on a 25.7-million-iteration run set the pruning threshold at −10,000,000, since Pluribus's −300,000,000 would prune nothing in a run this size. Ten workers reached 66,000 to 71,000 iterations/s from uniform strategies and 30,000 to 40,000 once trained play visited 86 decision nodes an iteration, not 46, using about 6 GB. [test_blueprint.py](test/engine/test_blueprint.py) covers trees, sizes, legality, Kuhn convergence with and without pruning, worker-count independence, exact resume, discounting, atomic and hashed checkpoints, refused mismatches, the run lock and the CLI on the real tables. pytest 587 passed with the database tests.

- [x] **P5.4 · Evaluation v2** · Depends on: P5.3
  - [x] A duplicate, seat-rotated match harness evaluates the same deals from both seats against random, calling-station, heuristic (RiverMind Easy) and, once available, current-champion opponents. Report big blinds per 100 hands and a 95% interval for each matchup. Compute uncertainty over independent deals, keeping both seat rotations together. Further variance reduction (for example AIVAT) is optional.
  - [x] Save reports under `docs/evaluations/`. Record rules, seats, stacks, blinds, opponent versions, seed, deal and hand counts, commands, settings and artifact hashes. Rerunning those inputs reproduces the reported results exactly.
  - [x] For each candidate, also report results at 40, 100 and 150 big blinds effective, against a probe that min-bets every street, and the share of decisions that found trained data ([docs/bots.md](docs/bots.md#mapping-real-actions-onto-the-tree)).
  - Evidence: `0c31c60`, `565daef`, `f362a5e`. [`BlueprintPolicy`](rivermind/bots/blueprint/policy.py) plays a checkpoint through a `SeatView` with the [mapping](docs/bots.md#mapping-real-actions-onto-the-tree), and [rivermind/bots/match.py](rivermind/bots/match.py) with `rivermind-poker blueprint evaluate` plays duplicate matches and writes [docs/evaluations](docs/evaluations/) ([method](docs/bots.md#evaluation-p54)). The first candidate, `hu-m1-s0` at 128,000,000 iterations, has its report in [hu-m1-s0-128m](docs/evaluations/hu-m1-s0-128m.md). Over 20,000 deals per matchup it won +61.1 bb/100 (+50.9 to +71.4) against RiverMind Easy and +308.3 (+289.4 to +327.3) against the calling station at 100 big blinds. Against Easy it won +43.5 at 40 big blinds and +74.3 at 150, and against the min-bet probe +392.4. Its own info set had trained data in 99.9% or more of its decisions. Rerunning it on 4 workers instead of 10 gave the same JSON apart from `--out`, and on the exploratory checkpoint 3 and 8 workers gave byte-identical reports. [test_match.py](test/engine/test_match.py) covers the mapping (the design's *p* = 0.533, an off-tree open drawn 58% to the lower size, below-smallest bets, all-ins, re-entry, untrained nodes, real-pot sizing at other stakes and depths), the probe, exact zero for two calling stations, reproducibility across workers and the gate. pytest 597 passed with the database tests.

- [ ] **P5.5 · Promotion gate and model registry** · Depends on: P5.4
  - [ ] Promote the first champion for a format when the lower bound of its 95% interval is above zero against **each** of RiverMind Easy and the calling station. Replacements must also clear that threshold against the incumbent. Record failed or inconclusive runs and leave promotion open. The RM-06 short-deck result applies only to the prototype.
  - [ ] `docs/models.md` lists each promoted champion by format with checkpoint and table hashes, settings and evaluation links.
  - [ ] Artifacts stay out of Git. Their storage and backup location on ubuntu-vm is documented.

- [ ] **P5.7a · Serve the evaluated heads-up opponent** · Depends on: P5.5, P4B.6, P4B.7
  - [ ] A guest can choose RiverMind Easy or the promoted bot for a two-seat table, including in practice. Keep the one-click Easy default and let a guest switch opponents between practice hands. Play a complete hand against each and verify the Node server loaded the serving bundle exported from the champion’s registered checkpoint, with matching tables (P4B.6).
  - [ ] Label the bot and link its selection to the evaluation with the game settings, opponents, number of hands, win rate in big blinds per 100 hands and 95% intervals. Record p95 decision time under 200 ms and peak service memory within the unit limit on ubuntu-vm. Measure decision time separately from the short presentation delay. Document how to deploy a champion under D-9.

### 3. Review the hand and return to the table

- [ ] **P6.1 · Replay from the table** · Depends on: P5.7a, P3.5, P4.6
  - [ ] “Review hand” on the settled result opens that exact hand. The player can also browse and open older hands from “Your hands”. Step forward and back through the recorded actions with the board, cards, acting seat, amounts bet or called, and pot sizes as of each action.
  - [ ] Explain why each pot was awarded. For a showdown, name the winning hand when its cards were shown (for example, “king-high straight”). For a fold-out, identify the last player standing. Verify a showdown, a fold-out and a side pot against the stored results. The response contains only cards the viewer is entitled to see, and the replay reveals them at the recorded street or showdown.
  - [ ] On phone and desktop, review a settled practice hand, return to the same table and act in the next hand. If the next deal begins during review, the live clock and action controls remain reachable. Verify this also works at a wallet-backed table.

### Phase 5A exit criteria

- [ ] **P5.9 · Verify the three priorities together** · Depends on: P6.0b, P5.7a, P6.1 · **Owner gate** for publishing, pushing and deploying under D-9
  - [ ] In Playwright against the real Node server and a disposable PostgreSQL database, cover a fresh guest and a zero-balance guest before top-up. Start practice in one click, choose the evaluated heads-up opponent, complete a hand, open that hand from the result, return and play again. Verify wallet and ledger totals before and after.
  - [ ] After the owner approves the relevant release actions, run the player journey on the live site on phone and desktop. Record the deployed revision, champion and evaluation link, and browser results here. Phase 5B opens when both checks pass. If deployment awaits approval, record the verified local work and the outstanding live check in **Now**.

---

## Phase 5B · Multi-seat bots and difficulty levels

**Starts after P5.9.** Extend the training and evaluation pipeline one format at a time.

**Exit criteria**

- [ ] Heads-up, 6-max and 9-max each have a promoted champion, a published evaluation meeting P5.5, and the difficulty levels in P5.7.
- [ ] Each format meets the serving latency and memory budgets on ubuntu-vm.

- [ ] **P5.6 · 6-max and 9-max** · Depends on: P5.9 · Compute per Q-5
  - [ ] Extend the design estimates and seat-rotated harness to 6-max, then 9-max. For each, train, evaluate and promote a champion under P5.5. Record compute used and the results. If a format falls short, record what was tried, the measured gap and what it needs, and leave that format open.

- [ ] **P5.7 · Serving and difficulty levels** · Depends on: P5.6, P5.7a
  - [ ] Serve Easy (heuristic), Medium (champion mixed with heuristic) and Hard (champion) for each supported format. Label bots under D-7 and link their evaluations. Deploying each new champion is an **Owner gate**.
  - [ ] Verify p95 decision time under 200 ms and peak service memory within the unit limit for every format. Keep the short thinking delay separate from the measured decision time.

- [ ] **P5.8 · Real-time search (stretch, does not gate 1.0)** · Depends on: P5.9
  - [ ] Depth-limited subgame solving for heads-up runs within the serving budget, and its evaluation shows a significant gain over the blueprint alone. If it is not reached by 1.0, move it to Phase 8.

---

## Phase 6 · Full-featured site

**Starts after the Phase 5B exit criteria.** P6.0 and P6.0a below record completed artwork. Phase 5A owns P6.0b and P6.1. The remaining work adds sharing, multiplayer features and polish.

**Exit criteria**
- [ ] Every step below is shipped on the live site and covered by Playwright tests.
- [ ] Automated accessibility checks report no serious or critical issues.

- [x] **P6.0 · Pixel-art design system** · Depends on: P3.6 · Brought forward by the owner (2026-11-19)
  - [x] Every piece of the site’s art is original pixel art drawn as text in `web/art/` (a named palette, sprite grids and a font) and rendered by `pnpm art` into content-hashed files; a Vitest check fails if a file drifts from its source, a pixel leaves the palette, a card is not 33 × 45 or a back is not 180° symmetric.
  - [x] Cards: 52 faces in standard and four-colour inks with bold corner indices, court portraits and aces, three backs and an empty-slot sprite. Also chips, a pot pile, the dealer button, person and bot avatars, the emblem, the favicon, nine-slice frames and buttons, the table rail and the wallpaper. The site font, RiverMind Pixel, is hand-drawn (111 glyphs, suits included) and compiled to WOFF.
  - [x] The lobby and table are rebuilt on the kit for phone, tablet and desktop: a felt table with bets in front of each seat, a segmented turn clock, the action dock beside the table on landscape screens and pinned to the bottom on phones, compact pods that keep a 9-seat phone table clear of the board, and seat tools that never move when the action panel opens. The `/style` page shows the whole kit, and [docs/design.md](docs/design.md) gives the rules.
  - Evidence: `4937f18`. Reviewed full-resolution screenshots of the lobby, a turn, the flop or turn and a showdown against a real `serve-nl` at 1440×900, 1280×800, 1024×768, 768×1024 and 375×812 (2, 6 and 9 seats; DPR 1 to 3), with no console errors and no horizontal overflow, and the `/style` page. pytest 478 passed with the database tests; Vitest 60, check, lint and build passed; Playwright 48 of 48 (Chromium, Firefox and WebKit at desktop and phone sizes, failing on any CSP violation). The art’s drift check regenerates 129 files.
  - Deployed: with the owner’s approval, `fcae7d5` (which also gives the 10 a bold index with a clear margin, after the owner’s review) was pushed and deployed with `deploy/update.sh`, which ran the server’s test suite and migrations `0002` and `0003` (P4.1 and P4.2 went live with it). `pnpm e2e:live` passed 12 of 12 against https://rivermindpoker.com (Chromium desktop and WebKit phone: headers, a hand at 2, 6 and 9 seats, sitting out and rebuying, and a hand continued across a `systemctl restart`).
  - Remaining (for later steps): a landscape tablet at 1024×768 fits a 9-seat table, but the top seats’ turn clocks can touch the pot label; 15px text is soft on 1x screens, so it is kept to secondary text. P6.0a superseded the face choices. Card-back selection remains in P6.5.
- [x] **P6.0a · The owner’s card deck** · Depends on: P6.0 · Requested by the owner (2026-11-19)
  - [x] The owner’s sprites (52 fronts, 18 backs) live in `web/art/cards/` as `fronts/<rank>-<suit>.png` and `backs/<name>.png`, and are the only card art on the site: the P6.0 faces, the four-colour set, the three backs and `cards.pxl` are deleted, and `pnpm art` removes any card file it did not make.
  - [x] `pnpm art` reads each sprite, checks it is an exact whole-number enlargement of 73 × 97 with hard-edged transparency, shrinks it to 1x and crops the clear ring to 71 × 95; the slot is redrawn on the cards’ outline and the phone pods’ card-back badge on the red back. Vitest fails on stale or stray card files, soft alpha or a wrong size.
  - [x] Cards snap to whole device pixels per art pixel (`--dpr` from `resolution` media queries, CSS `round()`), and the cards a phone pod shows keep at least 2 device pixels per art pixel in a compact fanned window, so every index reads at DPR 1 to 3. `/style` shows the deck, the 18 backs and the sizes, and [docs/design.md](docs/design.md) gives the rules.
  - Evidence: `b4492df`. `pnpm art` regenerates 118 files from the sprites (each verified as an exact 12x or 13x enlargement; the parchment back's few alpha-2 and alpha-4 strays count as clear). Reviewed contact sheets at 1x, 2x and 4x, and full-resolution screenshots of the lobby, a 9-seat table to showdown with calling bots and `/hands` against a local `serve-nl` at 1440×900 (DPR 2), 1280×800 (DPR 1), 768×1024 (DPR 2), 412×915 (DPR 2.625) and 375×812 (DPR 2 and 3, also in WebKit), with no horizontal overflow. pytest 548 passed with the database tests; Vitest 63, check, lint and build passed; Playwright 90 of 90 (Chromium, Firefox and WebKit at desktop and phone sizes). Not pushed or deployed.
  - Deployed: with the owner’s approval, pushed `main` and deployed `7be243a` (with P4.5 and P4.6) using `deploy/update.sh`. The first run stopped before the live site changed when `test_tables_are_saved_before_publishing_and_restored_at_startup` failed (547 passed); its file passed six times in a row on the server, and the second run passed all 548, ran migrations `0004` and `0005`, installed the Caddy `safety` zone and restored the open table. `pnpm e2e:live` passed 12 of 12 against https://rivermindpoker.com and 2 of 2 for the restart test with `LIVE_RESTART_COMMAND` (Chromium desktop and WebKit phone), and a live 6-seat table to showdown shows the new deck.

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
  - [ ] Settings: card backs (18 since P6.0a, whose deck is always four-colour), animation speed, sound with mute, and keyboard shortcuts.
  - [ ] Pre-action checkboxes: check/fold and call any. Bets and pot changes are animated.
  - Evidence: `e826f94`. Reviewed after the artwork session: the generator reproduces all 81 committed SVGs byte for byte, and a Vitest check now fails if they drift (it caught a deliberate one-character edit). Every SVG is valid XML with no styles or scripts. The faces, courts, aces, four-colour inks and the three backs were inspected at 150 px and at 34 × 48 px. The built client under `serve --client_dir` played to showdown at 375 × 812 with no broken images, no overflow, folded seats still face down and revealed hands shown. pytest 138, Vitest 32 and Playwright 36 of 36 (three browsers, two sizes) passed, as did check, lint and build.
  - Remaining: Card-back selection, animation speed, sound and mute, keyboard shortcuts, pre-actions, and bet and pot animations (P6.0 added only entrance animations for cards, bets and the action panel). P6.0a sets the current face artwork and sizing.
- [ ] **P6.6 · Accessibility** · Depends on: P3.6
  - [ ] Playwright runs axe checks on every page. The game is fully playable by keyboard, actions and turns are announced to screen readers, focus is managed and reduced motion is respected. The target is WCAG 2.2 AA.
- [ ] **P6.7 · Content pages** · Depends on: P1.6, P6.0b
  - [ ] Pre-rendered pages cover how to play, hand rankings, about the bots (honest claims linked to evaluations), privacy, and terms with the D-1 play-money statement. Each page has SEO metadata and social cards.
  - [ ] The public play and learning pages have descriptive titles, permanent URLs and crawlable links back to the lobby. The beginner guide explains the button, blinds, basic actions and hand rankings with a worked hand. From the guide, verify that a phone visitor can get to the lobby and begin practice. Check the built HTML and sitemap for public pages and apply `noindex` to personal hand history pages. [Google Search Essentials](https://developers.google.com/search/docs/essentials) · [Indexing controls](https://developers.google.com/search/docs/crawling-indexing/block-indexing)

- [ ] **P6.7a · Play with a friend from an invite** · Depends on: P4.3, P4.5, P6.0b
  - [ ] The lobby gives guests a clear way to create a private table and copy its invite. A friend opening it on a fresh browser sees the stakes and can join under the existing guest rules. Bots can start the table and give up seats between hands. A closed or expired invite offers a direct return to the lobby or solo practice.
  - [ ] Verify that a phone guest and a desktop guest can play a complete hand together from a copied link. Cover full tables, insufficient play chips and expired invites. A copied private invite has a generic preview and serves `noindex`. Its code stays out of the sitemap, page metadata and analytics.

- [ ] **P6.8 · Installable app** · Depends on: P1.6
  - [ ] A web app manifest and icons make the site installable. An offline page explains that play needs a connection.

---

## Phase 7 · Hardening and 1.0 release

**Starts after the Phase 6 exit criteria.** Verify the site’s operations, recovery and performance, then ship 1.0.

**Exit criteria**
- [ ] Every item in the [1.0 release checklist](#10-release-checklist) is ticked.

- [ ] **P7.1 · Observability** · Depends on: P3.7
  - [ ] Structured JSON logs and `/healthz` and `/readyz` endpoints are in place. Metrics cover tables, players, hands per minute, decision latency and errors. Uptime is monitored with the owner’s existing status service if suitable. Per Q-6, there is no third-party analytics.

- [ ] **P7.1a · First-time playtest and usage baseline** · Depends on: P7.1, P6.1, P6.7, P6.7a
  - [ ] Run an unassisted playtest with at least five first-time players across phone and desktop. Ask them to play a first hand, review it and join a friend from a link. Record where they stop or ask for help, fix reproducible blockers to those tasks, and repeat the affected checks.
  - [ ] Produce a server-side aggregate report per Q-6. Count the share of new guests who complete a first hand after taking an action, guests who open a replay after finishing a hand, and guests who are dealt in after opening a valid invite. Report how many guests who finish a first hand return to play on the same browser within days 1–7. Write down the numerator, denominator, sample dates and build for each measure.
  - [ ] Use the existing guest identity for deduplication within the measurement window and retain only aggregate usage results after it closes. Verify the counts with known test sessions before collecting a live baseline. The first report identifies one improvement to test after launch and specifies a comparable window for measuring it.

- [ ] **P7.2 · Backups and recovery** · Depends on: P3.1
  - [ ] PostgreSQL and the bot artifacts are backed up nightly, integrated with the owner’s existing ubuntu-vm backup setup. A restore onto a scratch database is performed and documented.
- [ ] **P7.3 · Load test** · Depends on: P4.4, P5.7
  - [ ] A scripted load test (at least 300 simulated players across 50 tables with bots) on ubuntu-vm keeps 95th-percentile action round-trips under 250 ms and memory within limits. The results are recorded.
- [ ] **P7.4 · Fast, seamless deploys** · Depends on: P3.7, P4B.7
  - [ ] The service restarts in under 5 seconds, so a deploy shows only a brief reconnect. Options include memory-mapped or lazily loaded bot tables, or a separate bot process.
  - [ ] A deploy during live play is verified in a browser.
- [ ] **P7.5 · Security review** · Depends on: P4.5
  - [ ] Dependencies are audited (pip-audit and pnpm audit), and headers, CSP and cookie flags are reviewed.
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
- optional sign-in, such as passkeys that claim a guest identity so chips and history follow a player across devices (D-12);
- native app wrappers;
- public research write-ups on the bots.
- a shareable weekly practice hand that asks the player to solve a worked example from the rules, such as awarding a side pot. After the answer, show the reasoning and a link to play against a bot.

---

## Handoff log

Newest first. Keep eight entries and move older ones to [docs/build-history.md](docs/build-history.md). Each entry gives the date, the step IDs, what changed, the checks actually run and the next concrete action.

**2026-11-20 · P4B.1 built: the client on its own Node server.** The owner asked to start P4B.1. `web/` now builds with `adapter-node`, and `web/server/` puts SvelteKit’s handler and a `ws` socket on one HTTP server. It answers `/healthz`, drains on SIGTERM and, with `RIVERMIND_LEGACY_API`, forwards `/api/*` and `/ws` to `serve-nl`. `pnpm build` bundles it as `build/start.js`, so a release needs no `node_modules`, as on the host’s other Node sites. Pages carry SvelteKit’s hashed CSP plus their socket origin, and `scripts/check-inline-code.js` replaces the old bootstrap externalizer. Playwright now runs against the Node server in front of `serve-nl`. Added a criterion: the static deploy cannot serve a Node build, so `update.sh` now publishes a release for the new `rivermind-poker-web.service` (port 4320, dynamic user, system Node 26). Caddy sends pages there and `/api` and `/ws` straight to `serve-nl`, and keeps the pages’ CSP with `?Content-Security-Policy`. P4B.7 now names that unit and port. Pitfalls: adapter-node assumes https unless `ORIGIN` or `PROTOCOL_HEADER` is set; unknown paths are now 404 rather than the SPA fallback (invites use `/?invite=`); the immutable assets’ Cache-Control has no spaces (`public,max-age=31536000,immutable`); and rebuilding `web/build` while Playwright runs breaks the run. Checks are in the P4B.1 evidence; pytest passed with the database tests. Not pushed or deployed. Next action: with the owner’s approval, push and deploy, then run `pnpm e2e:live`; otherwise P4B.2, P4B.3 or P4B.4.

**2026-11-20 · D-14: the TypeScript stack, planned as Phase 4B.** The owner asked to change the stack to SvelteKit 3 · Svelte 5 · TypeScript · Tailwind CSS 4 · PostgreSQL 18 + Drizzle ORM · Node (adapter-node) · Caddy. They chose to move the live site, table server, engine and bot serving to TypeScript, keep Python only for offline training and evaluation, and migrate before P5.5. Recorded D-14 and rewrote D-2, D-3, D-4, D-6, D-8 and D-9. Added Phase 4B (P4B.1 to P4B.8) with wire compatibility, Python as the reference engine and differential parity tests as its ground rules. Pointed P5.7a, P5.9 and P7.4 at the Node server and updated the roadmap, AGENTS and CONTRIBUTING. Checked the plan against the adapter-node custom-server, Drizzle and Tailwind 4 documentation. Docs only, no code changed; pytest 598 passed with the database tests. Next action: P4B.1, the `adapter-node` server with forwarding to `serve-nl`.

**2026-11-20 · P5.4 complete: blueprint play and evaluation.** Continuing the same request. Added `BlueprintPolicy` (the mapping, re-entry and nearest-bucket fallback from [docs/bots.md](docs/bots.md#mapping-real-actions-onto-the-tree)), the min-bet probe, duplicate seat-rotated matches with `rivermind-poker blueprint evaluate` and `gate` (`0c31c60`, `565daef`, `f362a5e`), and evaluated the run's 128-million checkpoint (`6de6ee0`): +61.1 bb/100 (+50.9 to +71.4) against RiverMind Easy and +308.3 against the calling station, so it passes the P5.5 gate. Copied the hu-m1 card tables to ubuntu-vm (`/srv/rivermind-poker/models/tables/hu-m1`, verified) under D-10. Pitfalls: the first draws of `Random(0)` to `Random(1999)` fall below 0.583 62% of the time, so a sampling test needs one generator stream, not a seed per trial. A policy's per-hand memory must not outlive a block of deals, or a match would depend on how deals were shared among workers, so blocks get fresh policies and the harness calls `new_hand()`. Checks are in the P5.4 evidence. The owner then asked to finish without starting P5.5, and to publish and deploy: pushed `bed85b3` to both remotes and ran `deploy/update.sh` (596 server tests passed, 2 skipped without the card tables; no migrations; 3 open tables restored; release `20261120T151711Z-bed85b3c277e`), and `pnpm e2e:live` passed 14 of 14 with the 2 restart tests skipped. Next action: P5.5, promoting `hu-m1-s0` at 128 million iterations; check the training run and resume it if it stopped.

**2026-11-20 · P5.3 complete: the heads-up trainer.** The owner asked for as much of the build as possible. Added `rivermind/bots/blueprint` and `rivermind-poker blueprint` (`b6fa49f`, `d2dd215`): trees compiled from the engine, batched MCCFR with linear discounting, pruning and a regret floor, deterministic across worker counts, with exact resume and atomic, hashed checkpoints. Then started the first blueprint run, `artifacts/blueprints/hu-m1-s0`, at low priority. Pitfalls: every chunk of a batch starts from the same regrets, so the number of batches limits progress (on Kuhn poker 25 batches of 64,000 left an exploitability of 0.078, against 0.011 for 750 of 400), and tests train Kuhn in small batches. Trained play visits nearly twice the nodes of uniform play, so a run takes about twice the P5.1 estimate. Pluribus's pruning threshold is too deep for a run this size. Summed RSS double-counts memory-mapped tables. Other sessions loaded this Mac heavily during the measurements (load averages from 100 to over 600), which slowed training by half or more at times. Checks are in the P5.3 evidence. Not pushed. Next action: P5.4, the evaluation harness, tested on the run's checkpoints; check `artifacts/blueprints/hu-m1-s0/train.log` and resume the run if it stopped.

**2026-11-20 · P5.2 complete: the hu-m1 card tables.** The owner asked this session to start P5.2. Added `rivermind/bots/cards` and `rivermind-poker tables` (`401b49e`), built the canonical set in `artifacts/tables/hu-m1` from that commit, and recorded its hashes and measurements in [docs/bots.md](docs/bots.md#table-sets). Pitfalls: scikit-learn's k-means is not bitwise repeatable (its parallel centre sums vary), so the build has its own; building the river board index in each worker would have needed about 2 GB per process, so workers memory-map the saved index; and the build took a tenth of the time P5.1 estimated, because the turn and flop histograms read the river rows instead of evaluating hands again. The table set is not on ubuntu-vm; P5.7a copies it there with the champion. Checks are in the P5.2 evidence. Not pushed. Next action: P5.3, heads-up training.

**2026-11-20 · P6.0b and P5.1 deployed.** The owner asked to push and deploy every change on `main`. Pushed `15099c7` (P6.0b `99c08ea`, `c95e693`; P5.1 `919ba16`, `15099c7`) to both remotes and ran `deploy/update.sh`: 558 server tests passed, Alembic migrated `0005` to `0006`, Caddy reloaded with `/api/practice` in the `new_tables` zone, and two open tables were restored. Added a live test of one-click practice (Practice tag, RiverMind Easy, a dealt hand, the same table after a reload, the wallet unchanged after leaving). `pnpm e2e:live` passed 13 of 14, with 2 restart tests skipped; the new test passed in Chromium and WebKit phone. The failure was “plays a hand at 9 seats” in Chromium, which passed on rerun: its player called bets of 2,550 and 6,250 chips that `playUntil` should fold (it folds calls over 1,000), busted on hand 1 and so never reached hand 2. Cause: after an action the panel stays up, disabled, until the table answers; `playUntil` decided on that stale Check button, and its click waited for the button to be enabled, by which time it read “Call 2550” for the bot’s bet (live bots wait 0.6 s, so the race shows there). `playUntil` now decides only on an enabled button and clicks that exact label. Then `pnpm e2e` passed 102 of 102 and the live seat tests 18 of 18 (2, 6 and 9 seats, both projects, three runs each). Next action: P5.2 per **Now**.

**2026-11-19 · P5.1 complete: the heads-up bot design.** The owner asked for as much of the build as possible and then chose P5.1 in this session while a parallel session finished P6.0b in the same checkout (it committed `99c08ea` and `c95e693`; this session kept to `docs/bots.md` until then). Wrote [docs/bots.md](docs/bots.md) (`919ba16`) and added P5.4’s depth, min-bet and coverage reporting, which the design relies on. Measurements came from throwaway scripts outside the repo; P5.2 and P5.3 replace them with real ones. Pitfalls: walking the engine is about seven times slower than a tree compiled from it, so P5.3 should train on the compiled tree; and suit-class counts depend on whether the board is an ordered sequence or a set (this design uses sets). Checks are in the P5.1 evidence. Not pushed. Next action: P5.2, the card tables.

**2026-11-19 · P6.0b complete: one-click practice.** The owner asked for as much of the build as possible. Built practice tables in `rivermind/server` (`Server.start_practice`, `TableRunner.practice` and `refill`, no wallet credits in `TableSaver`, `_cash_out` or `_seated_chips`), migration `0006` (`poker_tables.practice`), `practice` on table views and hand summaries, `practice_stack` on `/api/config` and `serve-nl --practice_stack`, and in the client the lobby’s “Practice vs bots”, the table’s Practice tag and “Play again” after a bust, and practice labels in “Your hands”. Caddy’s `new_tables` zone now covers `/api/practice`. Pitfalls: RiverMind Easy folds to nearly every raise, so a browser test that shoves or folds never busts (a desktop run reached 43,800 chips by hand 287); a 40-seed simulation showed a guest who checks or calls every turn with 300 chips busts within 94 hands, so the e2e server uses `--practice_stack 300` (recorded in AGENTS.md). A parallel session briefly edited this tree, refcounting the per-guest practice locks and naming the seated bot in repeat responses; those edits were kept. It now holds P5.1. Checks are in the P6.0b evidence. Committed `99c08ea`; not pushed or deployed. Next action: with the owner’s approval, push and deploy (migration `0006`, the Caddy zone) and run `pnpm e2e:live`; P5.1 continues in the parallel session.
