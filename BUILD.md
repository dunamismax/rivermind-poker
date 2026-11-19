# RiverMind Poker build tracker

This file is the single source of truth for project status, from today’s working prototype to the 1.0 release. It is written for AI agents and human contributors who pick the work up in sequence. Read **Now**, follow **How to work this file**, do the next unchecked step, and leave this file accurate for whoever comes next.

## Now

| | |
| --- | --- |
| **Current phase** | Phase 4 · Multiplayer and identity |
| **Next step** | **P4.1** Anonymous player identity |
| **In progress** | _None._ |
| **Blockers** | _None._ Phases 0 to 3 are complete. P4.7 waits on Q-1. |
| **Live site** | https://rivermindpoker.com runs no-limit hold’em at 2 to 9 seats against the Phase 2 bots (random, calling station and RiverMind Easy), on `serve-nl` with tables and hand histories in PostgreSQL (`rivermind_poker`), so tables survive restarts. Caddy serves the client from `/srv/rivermindpoker.com/current` and proxies `/api/*` and `/ws` to the app on 127.0.0.1:4316. Players are anonymous with signed bearer tokens until P4.1. Deployed at `a62ec52`. The short-deck game left the site (D-11). |
| **`main`** | Phases 0 to 3 and the P6.5 card artwork are on `main` and pushed to both remotes. The engine is in `rivermind/engine`, the bots in `rivermind/bots`, the durable table server (`serve-nl`, protocol v2) in `rivermind/server` and the client in `web/`. The short-deck code (`poker_ai/`, `serve`, the old client components) stays for reference until P7.6. `main` pushes to GitHub and Codeberg, and GitHub Actions runs the Python and web suites on every push. |
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

**Owner gates.** Steps marked **Owner gate** need the owner’s explicit approval in the current conversation before you act. These include pushing to a remote, deploying, tagging a release, choosing among options listed under open questions and anything touching money or real identity. Approval does not carry over between sessions. Setting up ubuntu-vm itself is not an owner gate (D-10).

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
| D-10 | **Server administration** (owner, 2026-11-19): agents may SSH into ubuntu-vm as root and install packages, create and change databases, roles, services, files and configuration, and do whatever setup the project needs there, without asking first. Keep other sites on the host working, follow its conventions and record what changed. Pushing, deploying to the live domain and release tags still follow D-9. |
| D-11 | **Short-deck prototype** (owner, 2026-11-19, answering Q-2): the no-limit game replaces the short-deck game on the live site at the P3.7 cutover. Open short-deck tables are closed with a clear message. Its code stays for reference until P7.6. |

## Open questions

Each question has a default. Agents build on the default until the owner decides, and only the step named under **Needed by** waits for the answer.

| ID | Question | Default until decided | Needed by |
| --- | --- | --- | --- |
| Q-1 | Accounts: guest-only, or optional sign-in to keep chips across devices? | Anonymous guest identity (P4.1). Optional passkey sign-in (P4.7) can be built later. | P4.7 |
| Q-2 | When does the short-deck prototype leave the live site? | **Decided** (D-11): it is replaced at the Phase 3 cutover (P3.7). | — |
| Q-3 | Tournaments in 1.0? | Single-table sit-and-go in 1.0 (P6.4). Multi-table tournaments after 1.0. | P6.4 |
| Q-4 | Chat? | No free-text chat in 1.0. Preset reactions only (P4.5). | P4.5 |
| Q-5 | Compute for bot training: this Mac only, or rented or extra machines? | This Mac. Don’t train on ubuntu-vm, which serves the site. | P5.6 |
| Q-6 | Analytics? | None from third parties. Server-side aggregate counts only (P7.1). | P7.1 |
| Q-7 | Retire the `poker_ai` namespace and its pickled formats at 1.0? | Keep the namespace as a thin legacy package and drop it from the site. | P7.6 |

## Phase overview

- [x] **Phase 0 · Prototype and foundation.** Training repairs, a bot baseline, a server-owned table, the browser client, self-hosting and restart-safe tables.
- [x] **Phase 1 · SvelteKit client.** Replace the vanilla client with SvelteKit on the existing protocol, with browser tests and CI.
- [x] **Phase 2 · No-limit hold’em engine.** A correct, tested 52-card no-limit engine for 2 to 9 seats, with hand histories.
- [x] **Phase 3 · Table server v2.** Multi-seat tables on the new engine with PostgreSQL persistence, action clocks and the live cutover.
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
  - [x] Original artwork for 52 cards in standard and four-colour treatments and three backs with 180° rotational symmetry. The owner brought the artwork forward during Phase 1, and the SvelteKit table defaults to standard faces and the RiverMind back.
  - [ ] Settings: a four-colour deck, card backs, animation speed, sound with mute, and keyboard shortcuts.
  - [ ] Pre-action checkboxes: check/fold and call any. Bets and pot changes are animated.
  - Evidence: `e826f94`. Reviewed after the artwork session: the generator reproduces all 81 committed SVGs byte for byte, and a Vitest check now fails if they drift (it caught a deliberate one-character edit). Every SVG is valid XML with no styles or scripts. The faces, courts, aces, four-colour inks and the three backs were inspected at 150 px and at 34 × 48 px. The built client under `serve --client_dir` played to showdown at 375 × 812 with no broken images, no overflow, folded seats still face down and revealed hands shown. pytest 138, Vitest 32 and Playwright 36 of 36 (three browsers, two sizes) passed, as did check, lint and build.
  - Remaining: Deck and back preference controls, animation speed, sound and mute, keyboard shortcuts, pre-actions, and bet and pot animations. Artwork follow-ups found in review: at the phone size of 34 × 48 px the corner rank is only about 7 px tall (the old text cards used about 14 px), so consider larger cards on phones or bigger indices; the card files under `/cards/` are not content-hashed, so they revalidate and load the first time each card appears; and the alt text says "J of hearts" rather than "Jack of hearts" (P6.6).
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

**2026-11-19 · P3.7, Phase 3 complete.** The owner decided Q-2 (recorded as D-11), approved pushing `main` and then approved the deploy. Made the no-limit table the site’s main page, switched the unit to `serve-nl` with PostgreSQL and a token secret, rate-limited new players in Caddy, told short-deck pages and saved seats that their tables closed, and rewrote the browser and live smoke tests for no-limit. The push of the D-11 record failed CI on a test race: the restore test read the database before the save after a disconnect had finished. It now waits for the save, and with saves slowed by 50 ms the old test fails and the new one passes. Rehearsing `pnpm e2e:live` locally before deploying caught a turn ring widening the phone page. Deployed `a62ec52`; checks are in the P3.7 evidence. Next action: P4.1, anonymous player identity with a signed session cookie in place of the bearer token.

**2026-11-19 · P3.4, P3.5 and P3.6 complete.** The owner asked for as much of the build as possible. Finished P3.4 (`e86da16`): the earlier hang was in the new test file, not the server. Its turn helper discarded the join snapshot, which was already the player’s turn, so it waited for the 50 s clock; it also always called, busted against random bots and waited for hands that `require_person` rightly never dealt. The tests now run on a `ManualClock`, check the latest message first and play cautiously (AGENTS.md notes the pitfall). Built P3.5 (`4fe2606`): table snapshots, the PostgreSQL store, save-before-publish, restore at startup and a real kill-mid-hand test. Runners also stopped keeping every finished hand in memory. Built P3.6 (`b722800`): the `/nl` client with an oval 2-to-9-seat table, bet presets and slider, timer rings, sitting out, rebuys and leaving, and Playwright tests against `serve-nl`; a pitfall there was an unbounded `click()` waiting for a button that never comes back, so the helpers click with a short timeout. The checks are in each step’s evidence. Nothing was pushed or deployed. The owner then decided Q-2 (D-11, replace the short-deck game at the cutover) and approved pushing `main`. Next action: P3.7, once the owner approves the deploy. The cutover makes `/nl` the main page, runs `serve-nl` in the unit with `DATABASE_URL` from `web.env` and a secret file under `/var/lib/rivermind-poker`, and closes the open short-deck tables with a message.

**2026-11-19 · P3.2 and P3.3 complete, P3.4 partly.** The owner asked for as much of the build as possible. Built `rivermind/server`: the table core, asyncio runners and manager (P3.2, `ed07e2a`), and action clocks, time banks and sitting out absent players (P3.3, `fd61fc1`; rules section 13 updated). The checks are in each step’s evidence. P3.4 (protocol v2 app, `serve-nl`) is in the working tree, not committed, because its new test file hung partway through; see the P3.4 Remaining line. Nothing was pushed or deployed. Next action: finish P3.4.

**2026-11-19 · P3.1 complete, server set up.** The owner lifted the owner gate on server setup (now D-10). Added [`deploy/setup-database.sh`](deploy/setup-database.sh) and ran it on ubuntu-vm, following the host’s pattern of owner, web and migration roles. It created `rivermind_poker` and `rivermind_poker_test` on PostgreSQL 18 and migrated the site database to `0001`. `update.sh` now runs the database tests and migrations, the unit reads `DATABASE_URL`, and CI uses `postgres:18`. Checks are in the P3.1 evidence. Two pitfalls while checking: copying a tree with macOS `tar` adds `._*` files that Alembic tries to load (use `COPYFILE_DISABLE=1` and `--no-mac-metadata`), and root’s `git` refuses the sawyer-owned checkout, so run git as sawyer. Not deployed. Next action: P3.2.

**2026-11-19 · P3.1 (partly).** Continuing the owner’s request, added `rivermind/db`: SQLAlchemy 2 models, Alembic migration `0001`, `alembic.ini`, database tests that skip locally and fail in CI without `RIVERMIND_TEST_DATABASE_URL`, and a PostgreSQL 17 service in the test workflow. Created the local `rivermind_test` database on this Mac’s PostgreSQL 17 (port 5432; PostgreSQL 18 also runs, on port 5433). Checks are in the P3.1 evidence. With the owner’s approval, pushed `main` to both remotes; CI run 44474555251 passed both jobs, with 357 Python tests including the database tests. Not done: the ubuntu-vm database (owner gate). Next action: P3.2, the table manager on the Phase 2 engine.

**2026-11-19 · P2.2 to P2.7, Phase 2 complete.** The owner asked for as much of the build as possible. Built the no-limit engine in `rivermind/engine`: an immutable state machine, pots and showdown, a faster port of Deuces, seating helpers, versioned JSON with replay, text histories, `SeatView` v2, a fuzzer (`python -m rivermind.engine.fuzz`) and a benchmark (`python -m rivermind.engine.bench`). The random, calling-station and heuristic bots are in `rivermind/bots`, and `hypothesis` is a new dev dependency. Rules changes for the owner to review: rule 7.8 (no bet or raise when everyone else still in is all-in) and rule 12.1 now also tables every hand when a river call puts a player all-in. The checks are in each step’s evidence; pytest 341 passed before the last commit. Nothing was pushed or deployed, and the web client was not changed, so its suite was not rerun. Next action: P3.1. PostgreSQL 17 runs locally on port 5432 for its tests, and creating the site’s database on ubuntu-vm needs the owner.

**2026-11-19 · P1.6, Phase 1 complete.** With the owner’s approval, deployed the SvelteKit client. Caddy now serves each build as a release under `/srv/rivermindpoker.com/` and proxies only `/api/*` and `/ws`. `update.sh` builds the client from the frozen lockfile before changing the live site, using Node 26.13 from mise and pnpm from corepack on ubuntu-vm. The legacy `poker_ai/web/static/` client is gone, and `pnpm e2e:live` smoke-tests a deployment. One fix came out of local testing behind Caddy: a missing `/_app/` asset had fallen through to the app page and now returns 404. The checks are in the P1.6 evidence. The owner asked to stop once Phase 1 was done, so Phase 2 has not started. Next action: P2.2.

**2026-11-19 · P6.5 artwork.** At the owner’s request a separate session created the original card deck (52 standard faces, four-colour clubs and diamonds, three backs) and wired it into the SvelteKit table, documented in [docs/card-art.md](docs/card-art.md). This session then reviewed it, moved the in-memory rendering into `web/scripts/card-art/render.js`, added `pnpm cards` and a stale-artwork test, fixed a docs link into the ignored `artifacts/` folder, and committed it as `e826f94`. Checks are in the P6.5 evidence; follow-ups are under Remaining. P1.6 is still the next phase step and awaits deployment approval.
