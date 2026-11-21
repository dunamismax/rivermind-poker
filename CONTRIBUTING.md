# Developing RiverMind Poker

The site runs on SvelteKit on Node (`adapter-node`) with Tailwind CSS 4 and Drizzle ORM on PostgreSQL 18, behind Caddy. Python stays for training and evaluation (D-14, Phase 4B in [BUILD.md](BUILD.md)). Since the P4B.7 cutover the live table server is the TypeScript one in the Node server. The Python table server (`serve-nl`), SQLAlchemy and Alembic were retired at P4B.8; Python keeps the reference engine, the bots, training and evaluation, and the table model that `pnpm table:parity` compares with. The host's web platform contract (`docs/web-platform.md` in ubuntu-vm-backup) sets the toolchain: exact versions everywhere, pnpm and Node 26, and fix-forward deploys.

Run commands from the repository root unless a step changes directory. Use uv to reproduce the locked development environment: it takes Python 3.12.15 from `.python-version` and every package from `uv.lock`. Pass `--locked` to every `uv sync` and `uv run`, so a stale lock fails instead of being rewritten.

```sh
uv sync --locked
uv run --locked pytest
uv run --locked rivermind-poker --help
```

For a quick edit-and-test cycle, run `uv run --locked pytest test/unit` or point pytest at the functional test for the component you changed. The suite includes action order, payouts, hand evaluation, card combinations and training checkpoint smoke tests. The smoke tests group all hands into one synthetic bucket per street so that training can run on a fresh checkout.

## No-limit engine

`rivermind/engine` is the engine for the main game: 52-card no-limit hold’em at 2 to 9 seats, implementing [the rules specification](docs/rules.md). It is pure. States are immutable, nothing global changes, and randomness comes only from the caller. `start_hand(config, stacks, button, deck=… or rng=…)` posts antes and blinds and deals. `legal_actions(state)` gives fold, check or call, and the bet or raise range as street totals. `apply(state, action)` returns the next state, or raises `IllegalActionError`. A finished state’s `result` holds the returned uncalled bet, the pots with their winners and shares, and who showed or mucked. `seating` moves the button between hands, and `history` writes versioned JSON (`"format": 1`) for states and replayable hand records, plus plain-text histories for one viewer. Bots decide from `view.seat_view(state, seat)`, which holds only that seat’s cards and public information, and the simple bots are in [`rivermind/bots`](rivermind/bots/). [Engine](rivermind/engine/) · [Tests](test/engine/)

```sh
uv run pytest test/engine
uv run python -m rivermind.engine.fuzz --hands 100000      # long self-play fuzz, all seat counts
uv run python -m rivermind.engine.bench                    # random self-play speed for 2, 6 and 9 seats
```

The engine tests check every rule’s example and more than 30 fixed hands with their payouts, and run Hypothesis property tests and a short fuzz. To add a rule test, write the hand in `test/engine/fixtures.py`: the stacks, button, cards and an action script such as `"S5:r300 S0:c S1:f"`, with final stacks worked out by hand from the rules.

### The TypeScript engine

`web/src/lib/server/engine` is a port of `rivermind/engine` to TypeScript (P4B.4, D-14) for the Node server: `startHand`, `legalActions`, `apply`, `seatView`, pots, seating and the `history` documents, with the same immutable states and caller-supplied randomness (`Random`; live tables use `cryptoRandom`, D-8). The browser-safe cards and evaluator are in `web/src/lib/engine`. The Python engine stays the reference: a rule change lands in both engines in the same commit. Documents from either are byte-identical, because `dumps` writes what Python's `json.dumps(..., separators=(",", ":"), sort_keys=True)` writes.

`rivermind.engine.differential` writes the reference outputs. `pnpm engine:parity` (from `web/`, also run in CI) replays 5,000 of its fuzzed hands, 625 at each of 2 to 9 seats, and checks the hand record, the final state and a digest of every intermediate state, legal-action set and text history byte for byte; it also compares evaluator digests on seeded samples. The Vitest suite runs every rule hand from `test/engine/fixtures.py`, through `web/src/lib/server/engine/rules.json`. After changing the fixtures, rewrite that file (pytest fails while it is stale):

```sh
uv run --locked python -m test.engine.export_fixtures
cd web && pnpm engine:parity -- --hands 100000 --evaluator-hands 10000000 --all-five   # the long run
cd web && pnpm engine:bench                                                            # matches rivermind.engine.bench
```

### The TypeScript bots

`web/src/lib/server/bots` ports `rivermind/bots` (P4B.6): the simple bots, the hu-m1 abstraction and `BlueprintPolicy`, reading a serving bundle exported by `rivermind-poker blueprint export`. Bots draw from `PythonRandom`, CPython's Mersenne Twister in TypeScript. As with the engine, Python is the reference and a change to a bot lands in both languages in the same commit. `pnpm bots:parity` (also in CI) plays the same deals with the same seeds in both and compares hand records, the blueprint's probabilities and statistics, and card buckets; [docs/bots.md](docs/bots.md#serving-p4b6) has the long run against a real bundle and `pnpm bots:bench`.

## PostgreSQL

Players, wallets, tables and hand histories live in PostgreSQL (D-4), through Drizzle ORM on node-postgres in the Node server. The site runs on the host's PostgreSQL 18 cluster and CI uses `postgres:18`; locally any PostgreSQL 16 or later works. With Homebrew, install and start a server, then create a development database and a separate test database.

```sh
brew install postgresql@18 && brew services start postgresql@18
createdb rivermind
createdb rivermind_test
(cd web && DATABASE_URL=postgresql://localhost/rivermind pnpm db:migrate)
```

SQLAlchemy and Alembic built the schema until P4B.8; Alembic's last revision was `0006`, which Drizzle's `0000_baseline` reproduces ([docs/build-history.md](docs/build-history.md)).

### Drizzle (P4B.3)

[`web/src/lib/server/db/schema.ts`](web/src/lib/server/db/schema.ts) declares every table, constraint and index, and [`web/drizzle/`](web/drizzle/) holds the SQL migrations, starting with `0000_baseline`, which builds exactly the schema of Alembic's last revision `0006`. Since P4B.8 they are the only source of the schema. Every migration must leave the release still serving working, because a deploy migrates before it switches and never goes back: add tables, nullable or defaulted columns and indexes, and remove or rename only in a later release. Tables are not schema-qualified: they follow `search_path`, which is `app` on ubuntu-vm and `public` locally.

`pnpm db:migrate` (from `web/`) applies pending migrations to `DATABASE_URL`, after `SET ROLE` to `DB_OWNER_ROLE` (or the older `RIVERMIND_MIGRATION_ROLE`) when that is set; `pnpm build` bundles the same program as `build/migrate.js`, which a release runs with plain Node. A database that Alembic has already migrated to `0006`, such as the live one, is adopted: the baseline is recorded as applied in `drizzle.__drizzle_migrations` and nothing else changes. To change the schema, edit `schema.ts`, generate a migration and review it. `drizzle-kit` writes `"public".` before referenced tables, so delete that qualifier; a Vitest test fails while it is there.

```sh
cd web
pnpm db:generate --name describe_the_change
DATABASE_URL=postgresql://localhost/rivermind pnpm db:migrate
```

The Vitest database tests (`*.db.spec.ts`) use `RIVERMIND_TEST_DATABASE_URL`, refuse a database whose name lacks `test`, and are skipped locally without it but fail in CI, where the `web` job has its own PostgreSQL 18 service. They drop the `public` and `drizzle` schemas. Set the variable for the full run before committing.

```sh
cd web && RIVERMIND_TEST_DATABASE_URL=postgresql://localhost/rivermind_test pnpm test
```

## Work with a learned bot

Clustering turns the two hole cards and the shared board into a bucket for each betting stage. Training uses those buckets and the betting history to learn an action distribution through self-play. Keep tables and checkpoints from the same experiment together. Load artifacts that you generated or trust because joblib uses Python pickle serialization.

To start a full experiment, use a local artifact directory. Clustering the default 20-card deck enumerates millions of hands and board combinations in memory. With default settings it took 77 minutes and peaked at 5.2 GB on a 10-core machine. A 3,000-iteration single-process training run on those tables took 42 minutes. For a quick playable baseline, use the random opponents in the README.

```sh
mkdir -p artifacts/tables
cd artifacts
uv run rivermind-poker cluster --save_dir tables
uv run rivermind-poker train start --single_process --lut_path tables --nickname baseline
```

Clustering writes `tables/card_info_lut.joblib` and `tables/centroids.joblib`. Training creates a timestamped `baseline_*` directory. Once it passes the update threshold and reaches a dump iteration, it writes `agent.joblib`. Pass that file and the same tables to `play --agent offline`. Use `cluster --help` and `train start --help` for experiment settings. The game engine deals ranks ten through ace, so tables generated with a smaller rank range cover only a subset of its hands.

### Checkpoints and resuming

Each dump replaces two files in the run directory. `agent.joblib` holds `strategy`, the regret-matched policy accumulated over every dump that offline play samples from. It also holds the live `regret`, the trainer’s update counts under `pre_flop_strategy`, the completed iteration as `timestep` and an embedded copy of the resume state. `server.gz` holds that resume state: the mode, every training setting, absolute `save_path` and `lut_path`, the next iteration and, for single-process runs, the random-generator state. Both files are written to a temporary name and renamed, agent first, so an interrupted write leaves the previous checkpoint usable. [Checkpoint writer](poker_ai/ai/ai.py)

```sh
uv run rivermind-poker train resume --server_config_path baseline_*/server.gz
```

Resuming keeps the saved mode and settings and continues at the saved next iteration. A resumed single-process run reproduces the uninterrupted run exactly. Multiprocess workers seed themselves randomly. Files written before RM-02 also resume. Their relative `lut_path` resolves against the current directory unless you pass `--lut_path`. Their single-process runs lack generator state, so the run continues with a fresh seed derived from the next iteration. If `agent.joblib` is newer than `server.gz`, resume uses the state embedded in the agent so no iteration is applied twice. To extend a run, raise `n_iterations` in `server.gz` before resuming. [Resume command](poker_ai/ai/runner.py)

Multiprocess checkpoints wait until every job for the dump iteration has finished, then copy the shared tables before sending the next iteration. With `--async_serialise`, the default, workers continue while a background thread writes the copy. Writes stay in iteration order. Discounting follows Algorithm 1 of the Pluribus supplement. It applies at multiples of `--discount_interval` strictly below `--lcfr_threshold`. The defaults scale Pluribus’s minute schedule to iterations: discounting every 10 iterations through iteration 390 (39 times), pruning from iteration 200 and strategy averaging from iteration 400. At about 0.85 seconds per three-seat single-process iteration on a 10-core MacBook Pro, the default 1,500-iteration run takes about 21 minutes. Multiprocess runs use one fewer worker than the CPU count. [Server](poker_ai/ai/multiprocess/server.py)

### Tables and checkpoints across the hand-strength fix

River clustering fits K-means to simulated `[win, loss, tie]` rates. Before RM-01, the first two rates were reversed. Turn and flop clustering use distributions over the following street’s clusters. For each postflop street, the builder saves the fitted cluster ID for each card combination. Preflop IDs come from a separate fixed mapping of ranks and suitedness. [Table builder](poker_ai/clustering/card_info_lut_builder.py) · [Preflop mapping](poker_ai/clustering/preflop.py)

Keep an existing checkpoint with the exact lookup table used to train it. Training and offline play look up the acting player’s bucket and combine it with the betting history to form the key for checkpoint regrets and strategy. They read the stored IDs directly, so using that pair requires no conversion. This follows from the lookup and checkpoint code. The fixed-card tests verify the corrected rates. To reuse a checkpoint with a regenerated table, first verify that the original and regenerated tables assign the same IDs to the same card combinations on every street. Equal cluster counts alone cannot establish compatibility. [Information-set key](poker_ai/games/short_deck/state.py) · [Checkpoint writer](poker_ai/ai/ai.py) · [Checkpoint policy](poker_ai/policies.py)

For a bot trained on corrected labels, run clustering in a new, empty directory under `artifacts/`. The builder loads existing lookup tables and centroids and skips streets already present, so reusing a legacy directory can preserve old results or mix generations. Start a fresh training run against the regenerated tables and keep the resulting checkpoint with them.

## Evaluate a bot

`evaluate` plays fixed-seed deals at the three-seat table. It pairs one candidate with two uniform-random bots. Each deal is played three times on identical cards so the candidate sits in the small blind, big blind and button once each. Cards come from a per-deal seed. Every bot samples from its own generator, seeded by deal, rotation and seat. The same inputs therefore reproduce the report exactly, apart from its `created` time.

```sh
uv run rivermind-poker evaluate --strategy_path RUN/agent.joblib \
  --lut_path TABLES --deals 2000 --seed 0 --output artifacts/eval.json
uv run rivermind-poker evaluate --agent random --deals 2000 --seed 0
```

The report records the rules, seed, deal and hand counts and the SHA-256 of the checkpoint and card table. It also records the checkpoint’s training settings and timestep. Results are given as net chips per hand overall and by seat, and as big blinds per 100 hands. The standard error and 95% interval are computed over per-deal means, because a deal’s three rotations share cards. `checkpoint_info_set_coverage` is the share of the candidate’s decisions found in the checkpoint; the rest fall back to uniform legal play. The `random` control should include zero. [Benchmark](poker_ai/benchmark.py)

## Bots and the table service

Clients ask a policy for a decision by passing `seat_view(state)`. It contains the acting seat’s cards, the board, history, stacks, pot and legal actions, never an opponent’s cards. `RandomPolicy` and `CheckpointPolicy` share that interface. The terminal, the benchmark and the table all use it. [Policies](poker_ai/policies.py)

`Table` is the server side of a networked game. It owns the deck, turn order, validation and play-chip payouts. A human seat holds a secret token and acts with `act(token, action, seq)`. `seq` must match the latest view, so duplicate or stale submissions fail with a `TableError` code and leave the hand unchanged. Bots act on the server until a human is to act. `view(token)` is also how a client reconnects. Opponents’ cards appear only for players who reach a showdown. The table also reports each action’s chips and the amount the seat faced, so clients can label checks, calls, bets and raises. [Table](poker_ai/table.py)

## Short-deck browser table (legacy)

The short-deck prototype left the live site at the Phase 3 cutover (D-11), and its browser page is gone; its server stays for reference until P7.6. `rivermind-poker serve` runs a FastAPI app under Uvicorn. It serves the table API (`/api/*`) and the game WebSocket (`/ws`) and wraps `Table`; its messages follow `poker_ai/web/protocol.py`. `POST /api/tables` with `{"opponents": "random"}` or `"checkpoint"` returns a table id and the human seat’s token. Play then runs over one WebSocket at `/ws`. The client first sends `{"type": "join", "table_id", "token"}`, so the token never appears in a URL or access log. After that it sends `act` with an action and `seq`, `next_hand` with `seq`, or `refresh`. Each change sends every connected socket its own seat’s view. A rejected message returns an error code with the current view. The browser stores the seat in `localStorage` and rejoins after reloads and dropped connections with backoff. With `--state_path`, the [store](poker_ai/web/store.py) saves each table to SQLite after every change, before anyone sees the new state. Tables are restored at startup, so a restart or crash mid-hand only shows players a brief reconnect. A saved table is about 6 KB, because the shared hand evaluator and card table are left out. Tables idle for a week are dropped. So are snapshots that a newer engine cannot restore, which is logged. Checkpoint tables are kept but not loaded when the server starts without a checkpoint. Snapshots are pickled and include seat tokens, so the file must stay private to the service. Without `--state_path`, tables live only in memory. Either way, idle tables are evicted when `--max_tables` is reached. The server binds to 127.0.0.1 by default. Put it behind an HTTPS reverse proxy before exposing it. [App](poker_ai/web/app.py) · [Tests](test/functional/test_web.py)

## No-limit table server

The Node server in [`web/`](web/) runs the site's tables: no-limit hold'em at 2 to 9 seats on the [TypeScript engine](#the-typescript-engine) and [bots](#the-typescript-bots). It took over from the Phase 3 Python server, `serve-nl`, at the P4B.7 cutover and keeps its protocol, cookie format, wallets, safety rules and hand histories, so guests, chips and open tables carried across; `serve-nl` itself was removed at P4B.8 and is in Git history before `1154b38`. The two subsections below say which module does what and how the port was checked. This section says what the server does.

**Protocol.** Protocol v2 is defined once, in [`web/src/lib/protocol-v2.ts`](web/src/lib/protocol-v2.ts), and every request body and socket message is checked against it at run time ([`protocol.ts`](web/src/lib/server/api/protocol.ts)). After every change, each follower of a table gets a `table` message with their own view and the new public events, numbered by `seq` without gaps. An `act` carries the `seq` of the view it answers, so an action meant for an earlier turn is refused as `stale`.

**Guests and sessions** (P4.1, [`auth.ts`](web/src/lib/server/api/auth.ts), [`players.ts`](web/src/lib/server/api/players.ts)). Players are anonymous. `POST /api/session` makes a player with a random handle, such as `Quiet Heron 42`, on a browser's first visit, or returns the player it already is, and sets the `rm_session` cookie: the player id and issue time signed with HMAC-SHA256, `HttpOnly`, `SameSite=Lax`, valid for 180 days and renewed on a visit after a day. It is `Secure` except over plain HTTP to a loopback host, where browsers would drop it. The cookie authenticates `POST /api/tables`, which creates a table with bots and seats the player, and the WebSocket at `/ws`, which opens with `hello` and can follow up to eight tables. Unsafe HTTP requests and WebSocket handshakes whose `Origin` is another host are refused with 403, except loopback pages calling a loopback server (the Vite proxy) and the origins in `RIVERMIND_ALLOWED_ORIGINS`. Players are stored in the `players` table with a database, or in memory without one. A Phase 3 bearer token sent once as `legacy_token` moves that player onto a cookie with their old guest handle. Sessions are signed with the secret in `RIVERMIND_SECRET` or the file named by `RIVERMIND_SECRET_FILE` (created with mode 600 if missing), so they survive restarts.

**Wallets** (P4.2, [`wallet.ts`](web/src/lib/server/api/wallet.ts); play money only, D-1). The first visit grants 20,000 play chips, and a visit with less than 10,000 tops the balance back up to 10,000 at most once a day. The balance changes only together with a row in `ledger_entries` (grant, top-up, buy-in, rebuy, cash-out or refund), in one statement that refuses to go below zero, so the entries always add up to the balance. Buy-ins and rebuys are paid when asked for and refunded if the table refuses them. Chips come back when the player leaves, when a waiting rebuy no longer fits the buy-in range, and when an idle table closes with them seated; with a database these credits are written in the same transaction as the table save, so a crash cannot pay them twice or lose them. A crash between a buy-in and the table's next save can still lose that buy-in. `GET /api/wallet` returns the balance, the play-money notice and the newest entries. Practice tables (P6.0b) never touch the wallet.

**Durable tables** ([`store.ts`](web/src/lib/server/table/store.ts), [`snapshot.ts`](web/src/lib/server/table/snapshot.ts)). With `DATABASE_URL` set to a migrated database, each table is saved as a versioned JSON snapshot in `poker_tables.state` after every change and before any socket hears of it, with its seats mirrored and each finished hand's replayable history in `hand_histories`. Open tables are restored at start-up with their people marked disconnected until they rejoin, so a crash, a restart or a deploy mid-hand only shows a reconnect. If a save fails the table plays on from memory and the next save catches up. Without a database, tables live only in memory.

**Safety and abuse controls** (P4.5, [`safety.ts`](web/src/lib/server/api/safety.ts)). The app rate-limits unsafe HTTP requests per player (or per address without a session, 429 with `Retry-After`), new players per address and messages per socket (a `rate_limited` error, then a closed socket); Caddy limits the same endpoints per address in front of it. Behind Caddy the client's address is read from `X-Forwarded-For`, trusted only from a loopback peer. Tests that send requests faster than people give the site `limits: UNLIMITED`. There is no free-text chat (Q-4): seated people send preset `react` messages, which every follower receives as a `reaction` unless they muted or blocked the sender. `POST /api/reports` reports the person in a seat (once a day per reporter, person and reason) and `PUT /api/relations` mutes or blocks them; people are named to each other by a public `ref` (a hash of the player id), never the id. Blocked players are kept apart by quick seat and their tables are tagged in the lobby. When two people sit at one table from the same address, a `same_address` signal is stored with a keyed hash of the address, never the address. Every handle the server makes passes a blocked-word filter. Reports and signals are rows in `player_reports` and `safety_signals`, and a moderator reads them with [`scripts/moderation.ts`](web/scripts/moderation.ts) (P4B.8a, [`moderation.ts`](web/src/lib/server/api/moderation.ts)), which replaced `rivermind-poker moderation`:

```sh
cd web
DATABASE_URL=postgresql://localhost/rivermind pnpm moderation reports             # newest first; --limit N
DATABASE_URL=postgresql://localhost/rivermind pnpm moderation signals --limit 20
DATABASE_URL=postgresql://localhost/rivermind pnpm moderation rename p_0123abcd   # a new random handle
```

A report line gives the time, the reason, the reported player's handle as it was then and their id, the reporter, and the table and hand when there were any. `rename` prints the old and the new handle; tables the player sits at show the new one after they sit down again. `pnpm build` bundles the script as `build/moderation.js`, so a release runs it with no `node_modules`. On ubuntu-vm, as root:

```sh
set -a; . /etc/web-apps/rivermind_poker/web.env; set +a
/opt/node-26/bin/node /srv/rivermindpoker.com/current/build/moderation.js reports
```

**Hand histories and replay** (P4.6 and P6.1, [`hands.ts`](web/src/lib/server/api/hands.ts), [`views.ts`](web/src/lib/server/api/views.ts)). When a hand ends the table records who was dealt into each seat; with a database the store writes them to `hand_players` (with each seat's net) beside the hand's history, and without one the server keeps the newest 5,000 hands in memory. `GET /api/hands` lists the hands the player was dealt into, newest first (`limit` up to 50, `before` a hand id for the next page), and `GET /api/hands/{hand_id}` returns one with the player's own cards, the board, the blinds, every action, the pots with who could win and who did, the hands shown at showdown and a readable history with names; folded and mucked hands are never included, and other players get 404. That answer is all a replay needs, so the replay is built in the browser: [`replay.ts`](web/src/lib/nl/replay.ts) turns it into steps (the blinds, each action, each street, hands turned over when the betting ended all-in, the showdown and the result) with the board, the pot, each seat's cards and bets as of each step and a sentence on why each pot went where it did, and [`HandReplay.svelte`](web/src/lib/nl/HandReplay.svelte) steps through them with First, Back, Next and Last or the arrow keys. It can show only the cards the answer holds, and shows another player's from the step at which they were turned over. `/hands` opens any of the player's hands in it. At the table, “Review hand” beside a settled result and “Review last hand” in the hand log open one without leaving the seat: the replay takes the hand log's place beside the table, or sits above the table on an upright screen, so the action panel and the clocks stay where they are and the next hand can be played with the review open. The table has no hand id in its view, so it finds the hand in `GET /api/hands` by table and hand number (`findHand`); the hand is stored before its result is published. `/fairness` explains dealing and the table rules, and names the generator live tables deal from: `crypto.randomInt` (D-8).

**The client** is the SvelteKit app's main page ([`web/src/lib/nl/`](web/src/lib/nl/)): a lobby to pick 2 to 9 seats, the bots, the blinds and a buy-in, and a pixel-art table that keeps your seat at the bottom, shows each turn's clock as a segmented bar (green for the action time, red for the time bank), and offers a bet slider with minimum, ½ pot, ¾ pot, pot and all-in presets clamped to the legal range, plus sitting out, rebuys and leaving. Seat and bet positions are CSS classes generated from `layout.ts` into `seat-places.css`, a wide map for landscape screens and a tall one for phones and upright tablets, because the CSP blocks inline styles; a Vitest check fails if the file is stale. A browser that still holds a short-deck seat from before the Phase 3 cutover is told in the lobby that its table closed.

### The TypeScript API (P4B.5a)

[`web/src/lib/server/api/`](web/src/lib/server/api/) ports the parts of `serve-nl` that need no running table to TypeScript (D-14): session cookies and legacy tokens (`auth.ts`, the same format, signed message and secret, so guests stay signed in across the cutover), players and handles (`players.ts`), wallets and the ledger (`wallet.ts`), rate limits, the handle filter, reports, mutes, blocks and signals (`safety.ts`), hand histories (`hands.ts`, `views.ts`), runtime checks of every request body and socket message with Pydantic's rules and wording (`protocol.ts` on `validate.ts`, each schema type-checked against the generated `protocol-v2.ts`), and the routes `GET /api/config`, `POST /api/session`, `GET /api/wallet`, `GET /api/hands`, `GET /api/hands/{id}`, `GET /api/relations` and `DELETE /api/relations/{ref}` (`api.ts`). Each store has a memory and a Drizzle version. The lobby, seating, practice, reports and new mutes and blocks act on a running table and are part of [the table server](#the-typescript-table-server-p4b5b).

With `RIVERMIND_API=1`, the Node server answers `/api/*` with it ahead of SvelteKit ([`web/server/api.ts`](web/server/api.ts)), and `/ws` with the table server, as the live unit does. It runs ahead of SvelteKit because SvelteKit 3's CSRF check, which cannot be turned off, refuses unsafe requests with no body type whose `Origin` is not the site's own, which the API allows from loopback dev pages and non-browser clients, as `serve-nl` did; it makes its own origin checks. It reads `RIVERMIND_SECRET` or `RIVERMIND_SECRET_FILE`, `DATABASE_URL`, `RIVERMIND_ALLOWED_ORIGINS` (comma-separated), `RIVERMIND_PRACTICE_STACK`, `RIVERMIND_HAND_PAUSE`, `RIVERMIND_BOT_DELAY` and `RIVERMIND_MAX_TABLES`, as listed in [`runtime.ts`](web/src/lib/server/api/runtime.ts). From `web/`, after `pnpm build` and `pnpm db:migrate`:

```sh
PORT=3000 RIVERMIND_API=1 DATABASE_URL=postgresql://localhost/rivermind RIVERMIND_SECRET_FILE=../artifacts/secret pnpm start
```

`contract.json` holds `serve-nl`'s answers to a fixed script of requests and the values of its pure functions (cookies, tokens, refs, guest names, address tags, the handle filter, origin rules), recorded with a fixed clock before P4B.8 and now a fixed fixture: a deliberate change to the API's HTTP behaviour updates it by hand, with the reason in BUILD.md. Vitest replays the script against the TypeScript API in memory (`contract.spec.ts`) and on PostgreSQL (`contract.db.spec.ts`) and expects the same status, headers and body text byte for byte.

### The TypeScript table server (P4B.5b)

The tables themselves are ported too, so the Node server runs the whole site without Python, as it has live since the P4B.7 cutover.

| Module | What it ports |
| --- | --- |
| [`web/src/lib/server/table/table.ts`](web/src/lib/server/table/table.ts) | `table.py`: seats, buy-ins, holds, the waitlist, hands and the turn clock |
| [`clock.ts`](web/src/lib/server/table/clock.ts), [`snapshot.ts`](web/src/lib/server/table/snapshot.ts) | `clock.py` and `snapshot.py`: the system and manual clocks, and snapshot formats 1 and 2 |
| [`runner.ts`](web/src/lib/server/table/runner.ts) | `runner.py`: one loop per table, the lock every change goes through, bots, and `cryptoDealer` (`crypto.randomInt`, D-8) |
| [`store.ts`](web/src/lib/server/table/store.ts) | `store.py` on Drizzle: the same rows, written before a change is published |
| [`web/src/lib/server/api/tables.ts`](web/src/lib/server/api/tables.ts) | `Server` in `app.py`: the lobby, seating, quick seat, practice, wallets at the table, closing and eviction |
| [`socket.ts`](web/src/lib/server/api/socket.ts) | the `/ws` endpoint: the hello, the session cookie, one message at a time |

`api.ts` gains the table routes: `POST` and `GET /api/tables`, `GET /api/invites/{code}`, `POST` and `DELETE /api/tables/{id}/seat` and `/waitlist`, `POST /api/quick-seat`, `POST /api/practice`, `POST /api/reports` and `PUT /api/relations`. [`web/server/app.ts`](web/server/app.ts) hands each `/ws` connection to `socket.ts`: a handshake from another origin gets 403, a frame over 64 KB or a binary one closes the socket, and a shutdown closes every socket with code 1012 after the changes in flight are saved.

Three things differ from `serve-nl` on purpose. Bots decide on the event loop, since they answer in microseconds; a bot's turn first yields to the requests already due. The runner wakes its loop only after a change is saved and published, so events come in one order whether tables are in memory or in PostgreSQL. And a refused action says what is allowed (“you may check, bet 100 to 4900 or fold”) where `serve-nl` quoted the engine's `repr`.

Parity with `serve-nl` was measured in three ways, each with a small recorded file that Vitest replays without Python. Since P4B.8 only the table's is still recorded from Python; the other two are fixed fixtures.

- **The table.** `uv run --locked python -m test.server.table_differential --fixture` writes [`parity.json`](web/src/lib/server/table/parity.json): seeded random requests (seating, holds, the waitlist, hands, clocks, snapshot round trips) with a digest of every answer, event and snapshot, and two tables saved mid-hand in snapshot formats 1 and 2. `pnpm table:parity` runs a longer fuzz against Python directly (`-- --sequences 400 --ops 300` for the long run) and names the first field that differs.
- **The whole server.** [`table-contract.json`](web/src/lib/server/api/table-contract.json), recorded from `serve-nl` before P4B.8: a session of 168 steps played against it on one event loop, with fixed clocks, seeded decks and numbered table ids. Each step records its HTTP response as text and a digest of every socket message. `table-contract.spec.ts` and `tables.db.spec.ts` replay it in memory and on PostgreSQL. A deliberate change to the table server's behaviour updates it by hand, with the reason in BUILD.md.
- **One database, two servers.** Until P4B.8, `tables.db.spec.ts` handed a table mid-hand between a real `serve-nl` and the TypeScript server and back. Now `store.db.spec.ts` stops a Node server mid-hand without a last save and checks the next one deals on the same hand, and that a release candidate's check (`Tables.restorable`) reads every saved table without changing one.

Seeded tests deal the same cards in both servers: `seededDealer(seed)` draws as `random.Random(seed)` does, for the shuffle and for the bots' own generator.

### RiverMind Hard: serving a champion (P5.7a)

With `RIVERMIND_MODELS` set, the Node server plays the registry's heads-up champion ([docs/models.md](docs/models.md)) as **RiverMind Hard**, at two-seat tables and in practice. [`champions.ts`](web/src/lib/server/bots/champions.ts) loads `<models>/<name>/bundle` and refuses it unless every file's SHA-256 is the one in [`web/src/lib/champions.json`](web/src/lib/champions.json), the extract of the registry that `rivermind-poker blueprint promote` writes and the release is built with. It also checks the card table set and the checkpoint the bundle names. So the strategy at a table is the one whose evaluation its label links to (D-7). Without the variable, or when the check fails, the server logs why and runs without that bot.

```sh
PORT=3000 RIVERMIND_API=1 RIVERMIND_MODELS=../artifacts/models ORIGIN=http://127.0.0.1:3000 pnpm start
# RiverMind Hard plays hu-m1-s0-1024m: bundle … checked against the registry in 0.8 s (strategy.u8 31a782ea…, table set 4ff8b0ef…)
```

- **What players see.** `GET /api/config` lists the bot with `seats: [2]` and `champion`: the model's name and the promotion gate's results for the served strategy. The lobby shows the result against RiverMind Easy with its 95% interval beside “Practice vs RiverMind Hard”, and links to [`/bots`](web/src/routes/bots/+page.svelte), which shows every matchup of the champion's evaluations from `champions.json` and what they do not say. “Practice vs bots” still starts RiverMind Easy in one click.
- **Changing opponents.** `POST /api/practice` takes `{"bot": "hard"}`. At a new table it chooses the opponent; at a table already running it changes it, at once between hands and otherwise when the hand ends, and the answer's `next_bot` names the bot still waiting. The practice table's “Opponent” control does this.
- **One policy a table.** The policy remembers how it mapped each hand's bets, so every table gets its own (`forTable`) over the one copy of the arrays.
- **A missing bot.** A saved table whose bot the server does not run, which is RiverMind Hard after its bundle went missing, plays on against RiverMind Easy under that label. Seats, stacks and the hand in progress are kept.
- **Tests.** [`champion.spec.ts`](web/src/lib/server/api/champion.spec.ts) writes a small champion and its registry extract, and also loads the registered bundle from `artifacts/models` when it is there. The browser tests' server gets one from `e2e/global-setup.ts` through `RIVERMIND_MODELS` and `RIVERMIND_CHAMPIONS`, a registry extract to use instead of the built-in one; that variable is for tests only.

## SvelteKit client

The browser client lives in [`web/`](web/). It is a SvelteKit app (Svelte 5, strict TypeScript) built with `adapter-node` and served by a small Node server of its own (P4B.1, D-14). The pages are client-rendered (`ssr = false` in the root layout). Use Node 26.13.1, as [`web/.node-version`](web/.node-version) and `engines` say (mise reads the file), and pnpm 12.18.0, as `packageManager` says; `web/pnpm-workspace.yaml` sets `saveExact` and `engineStrict`, so a wrong Node fails the install. On ubuntu-vm run each command through `node-26`, which puts the host's pinned Node and pnpm first on `PATH`. Every dependency is pinned to an exact version: add one with `pnpm add --save-exact`. Run these from `web/`.

```sh
pnpm install --frozen-lockfile
pnpm check   # svelte-kit sync and svelte-check, warnings fail
pnpm lint    # Prettier and ESLint; `pnpm format` rewrites files
pnpm test    # Vitest unit tests
pnpm build   # the Node build in web/build, with the server bundled as build/start.js
pnpm start   # node build/start.js
```

For development, run the built Node server and the Vite dev server side by side. Vite proxies `/api` and `/ws` to `http://127.0.0.1:8000`, so the client stays same-origin as it is behind Caddy. Set `RIVERMIND_BACKEND` to proxy somewhere else.

```sh
pnpm build && PORT=8000 ORIGIN=http://127.0.0.1:5173 RIVERMIND_API=1 pnpm start &
pnpm dev
```

The no-limit protocol is defined once, in [`web/src/lib/protocol-v2.ts`](web/src/lib/protocol-v2.ts), its source since P4B.5b. The TypeScript server checks every incoming message against it ([`protocol.ts`](web/src/lib/server/api/protocol.ts)). The legacy short-deck protocol is still generated: `pnpm protocol` rewrites `protocol.ts` from `poker_ai/web/protocol.py`, and `test/functional/test_protocol.py` fails while it is stale. Malformed messages, including a `seq` sent as a string, are rejected with `bad_request`.

To run the production build the way the site serves it, start the Node server. [`web/server/`](web/server/) puts SvelteKit's `handler.js` and the `/ws` WebSocket on one HTTP server, answers `/healthz` (`{"status":"ok","revision":…,"database":"ok"}`, the revision from the release's `REVISION`), sends the site's security headers, caches `/_app/immutable/*` as immutable and makes everything else revalidate, and on SIGTERM finishes open requests before exiting. With `RIVERMIND_API=1` the Node server serves `/api/*` and `/ws` itself (see [the TypeScript table server](#the-typescript-table-server-p4b5b)); with `RIVERMIND_CANDIDATE=1` as well it is a release candidate, which checks the database, the saved tables and the champion on `/healthz` but never restores or deals a table. Without either, `/api/*` goes to SvelteKit (a 404) and `/ws` closes every socket with code 1013. Set `ORIGIN` to the address the browser uses, since adapter-node otherwise assumes https. `PORT`, `HOST`, `RIVERMIND_BUILD_DIR`, `SHUTDOWN_TIMEOUT` and adapter-node's handler variables are listed in [`web/server/index.ts`](web/server/index.ts).

```sh
pnpm build
DATABASE_URL=postgresql://localhost/rivermind PORT=3000 ORIGIN=http://127.0.0.1:3000 RIVERMIND_API=1 pnpm start
```

The CSP allows no inline script or style apart from SvelteKit's start-up script. Its hash goes in each page's policy (`csp` in `web/vite.config.ts`), and `web/src/hooks.server.ts` adds the page's own `ws://` or `wss://` origin to `connect-src`. `pnpm build` fails if a client module renders a style attribute, or if any page the built handler serves has an unhashed inline script, a `<style>` element, a style attribute or an inline event handler (`web/scripts/check-inline-code.js`). A small Vite plugin in `web/vite.config.ts` removes the inline style from SvelteKit's route announcer. Svelte transitions also inject styles at run time, so animate with CSS classes instead.

The no-limit UI is in `web/src/lib/nl/`. `NlConnection` (`connection.svelte.ts`) owns the socket: on page load it calls `POST /api/session`, says hello (the cookie authenticates it), follows the saved table, sends actions with the view's `seq`, rejoins with backoff (1, 2, 4, then 8 seconds) and keeps the table in `localStorage`. The page never sees the session. Bet sizes and log wording live in `bet.ts`. The short-deck components in `web/src/lib/components/` stay until P7.6; `PlayingCard` is shared. The cards, chips, avatars, frames and the pixel font are original pixel art drawn as text in `web/art/` and rendered by `pnpm art` into `web/src/lib/art/`; see [the design notes](docs/design.md) and the `/style` reference page.

`pnpm e2e` runs the Playwright tests in `web/e2e/` in Chromium, Firefox and WebKit at desktop (1440×900) and phone (375×812) sizes. It builds the client once. Then each worker starts the built Node server (`node build/start.js`) on port 8800 and up, serving the pages, the API and the tables itself, with tables in memory (their durability is tested in Vitest on PostgreSQL). The tests play at 2, 6 and 9 seats. Install the browsers once with `pnpm exec playwright install`, and pass `--project chromium` for a quick run.

The player journey ([`journey.e2e.ts`](web/e2e/journey.e2e.ts), P5.9) is the exception: it runs against one Node server that keeps its players, wallets, tables and hands in PostgreSQL, started by [`journey-setup.ts`](web/e2e/journey-setup.ts) on port 8790 for every browser project to share. A new guest, and a guest with no chips left, practise in one click, choose RiverMind Hard, finish a hand against it, open it from its result, return and play again, and the test reads the wallet and its ledger from the database before and after. It needs `RIVERMIND_TEST_DATABASE_URL`, which it empties and migrates, so do not run it beside `pnpm test`; without the variable it is skipped locally, and CI sets it.

```sh
RIVERMIND_TEST_DATABASE_URL=postgresql://localhost/rivermind_test pnpm e2e
```

### Comparing screenshots (P4B.2)

`pnpm visual` captures fixed scenes of the production build for comparing two commits pixel for pixel: the lobby, a table being watched and the player menu, a heads-up table at the first turn, with a bet being sized, at the result and with that hand under review (at its result and stepped back), a practice table, a private table's invite, a full nine-seat table and the seat tools, `/style`, `/fairness`, and `/hands` with a hand open at its result and at its first step. It takes them at 375×812, 768×1024 and 1440×900 at one, two and three device pixels per CSS pixel, and at 1024×768 and 860×600 at one, in Chromium, Firefox and WebKit: 561 PNGs under `VISUAL_OUT` (`artifacts/visual/current` by default).

Each size gets its own site from [`web/e2e/visual/server.ts`](web/e2e/visual/server.ts), a test-only server built from the same parts as the live one, with seeded decks and bots, handles from a fixed list, numbered table ids and clocks that stand still; the browser's clock, time zone and locale are pinned too. The live server has no seeding switch (D-8). A scene is saved once two captures in a row agree.

```sh
git stash                                              # or check out the commit to compare with
VISUAL_OUT=../artifacts/visual/before-1 pnpm visual    # two or three times, into before-1, before-2, ...
git stash pop
VISUAL_OUT=../artifacts/visual/after pnpm visual
pnpm visual:compare ../artifacts/visual/before-1 ../artifacts/visual/before-2 ../artifacts/visual/after --diff ../artifacts/visual/diff
```

`pnpm visual:compare` passes a pixel only when some "before" capture has exactly that value there. One "before" run is the strict test. Several allow for what a browser does not draw the same way twice: Chromium anti-aliases the fanned (rotated) cards differently between runs of one build at three device pixels per CSS pixel, by 15 to 130 pixels in a capture of 11.6 million, so capture that size a few more times (`--project chromium -g "@3"`) when it is the only difference. `--diff` writes each failing capture with the changed pixels in magenta. `pnpm visual` builds first unless `E2E_SKIP_BUILD` is set, keeps its own `test-results-visual`, and takes ports from 8950 (`VISUAL_PORT`).

## Table voice

Table voice is Phase 4C; [docs/voice.md](docs/voice.md) holds the design and what each step found. Nothing a player sees is built yet. What exists is the frame encryption (P4C.2) in [`web/src/lib/voice/`](web/src/lib/voice/), and the prototype (P4C.1) in [`web/voice/prototype/`](web/voice/prototype/), which is not part of the site, the build or `pnpm e2e`.

### Frame encryption (P4C.2)

Every Opus frame is sealed in the sender's browser and opened in each listener's with SFrame (RFC 9605), cipher suite `AES_128_GCM_SHA256_128`, over WebCrypto.

| File | What it holds |
| --- | --- |
| [`sframe.ts`](web/src/lib/voice/sframe.ts) | The RFC: the header, the key and salt, the nonce, sealing and opening, and key ids made of an MLS sender and epoch. Then `KeyStore`, the keys one page holds: counters that never repeat, epochs added and retired, and what it refuses. |
| [`sframe-transform.ts`](web/src/lib/voice/sframe-transform.ts) | What the worker does to each frame, and its tallies. Kept apart from the worker so Vitest can run it. |
| [`sframe.worker.ts`](web/src/lib/voice/sframe.worker.ts) | The encoded-transform worker: one for a page's sender and all its receivers. |
| [`sframe-client.ts`](web/src/lib/voice/sframe-client.ts) | `FrameCrypto`, the page's handle on the worker: `addEpoch`, `sendAs`, `retire`, `encrypt(sender)`, `decrypt(receiver, id, from)` and `tallies()`. |
| [`sframe-vectors.json`](web/src/lib/voice/sframe-vectors.json) | RFC 9605's appendix C, written from the RFC's text by `node scripts/sframe-vectors.ts rfc9605.txt`. Prettier must not touch it. |

```sh
pnpm test src/lib/voice/sframe.spec.ts   # the vectors and every refusal, under Node
pnpm voice:check                         # the same vectors and a real call through the worker, in three browsers
pnpm voice:check --project webkit -g cost
VOICE_DEBUG=1 pnpm voice:check -g heard  # with the page's console
```

`pnpm voice:check` (CI runs it) builds [`web/voice/check/`](web/voice/check/) with Vite, the worker a bundled module of its own, and serves it on `127.0.0.1:4391` with the site's CSP. Its page runs the vectors on the engine's own WebCrypto, then a WebRTC call between two peer connections on the one page, a speaker's and a listener's, each with a worker and key store of its own. The checks are a call that is heard, a listener with another secret, with no key and with the stream taken for another person's, a speaker with no key, a sender with no worker at all, a change of epoch and a retired one, and what SFrame costs a page in a full room. It needs no voice service: what a forwarding server does to frames is the prototype's to show, and P4C.4's.

CI runs the checks in Playwright's Linux browsers, which differ from the macOS ones: Chromium's fake microphone works there, Firefox has no sound device, and WebKit has no `RTCRtpScriptTransform`, so its call checks are skipped. To run them that way before a push, with Docker running:

```sh
scripts/voice-check-linux.sh              # every check, as CI runs them
scripts/voice-check-linux.sh -g "behind"  # arguments go to playwright test
```

It copies the working tree into Playwright's image for the pinned version (3.6 GB, which stays until `docker rmi` removes it), installs Node and pnpm at the repository's versions and runs `pnpm voice:check` with `CI` set.

A frame that is not opened is never passed to the decoder, and a frame that cannot be sealed is never sent. Each is counted in its transform's tally under the reason: `malformed`, `unknown-key`, `stale-epoch`, `wrong-sender`, `tampered` or `replayed` on the way in, `unsent` on the way out.

### The group key (P4C.3)

The people in voice agree a key for each epoch through an MLS group (RFC 9420) on ts-mls. [docs/voice.md](docs/voice.md#the-group-key-as-built-p4c3) says how it works and what it refuses.

| File | What it holds |
| --- | --- |
| [`group.ts`](web/src/lib/voice/group.ts) | `Member`, one person's side: create, join by external commit, apply what the service passes on, commit the removals the service proposed. |
| [`delivery.ts`](web/src/lib/voice/delivery.ts) | `Delivery`, the voice service's side: one commit an epoch, what each sender may change, and removals signed as the external sender. |
| [`group-keys.ts`](web/src/lib/voice/group-keys.ts) | `EpochKeys`: each epoch's SFrame base key into the worker, the grace window, and the check of members against seats. |
| [`voice-code.ts`](web/src/lib/voice/voice-code.ts) | The four-word table voice code, from the epoch authenticator. [`voice-words.json`](web/src/lib/voice/voice-words.json) is the BIP-39 English list; Prettier must not touch it. |

```sh
pnpm test src/lib/voice/group.spec.ts src/lib/voice/group-keys.spec.ts
pnpm voice:check -g "ms behind"   # a join and a leave during a real call, in three browsers
```

### The MLS test vectors (P4C.3)

`pnpm test` also holds the pinned ts-mls to the MLS working group's interoperability test vectors for ciphersuite 0x0001 ([`web/src/lib/voice/mls-vectors/`](web/src/lib/voice/mls-vectors/), 395 cases in 14 spec files). The vectors are not in this repository, because the working group's states no license: [`load.ts`](web/src/lib/voice/mls-vectors/load.ts) fetches them from GitHub at the commit [`source.json`](web/src/lib/voice/mls-vectors/source.json) pins, checks each file's SHA-256 and keeps them in `node_modules/.cache/mls-vectors/`. The first run needs the network. Without it the vector checks are reported as skipped, except in CI, where that is a failure.

To move to a newer commit of the working group's files, change `commit` in `source.json`, then each file's `sha256` (`shasum -a 256`) and `cases` (its cases with `cipher_suite` 1, or all of them where the file has no such field), and run the specs.

### The prototype (P4C.1)

The prototype talks through a mediasoup service, with frames sealed by the site's own worker since P4C.2.

```sh
pnpm voice:proto                       # every check: Chromium, Firefox, WebKit, then one room of all three
pnpm voice:proto --project firefox     # one engine
VOICE_DEBUG=1 pnpm voice:proto -g TCP  # with each page's console
node voice/prototype/server.ts         # the service alone, at http://127.0.0.1:4390/?room=a&freq=440
```

`pnpm voice:proto` starts the prototype service itself: one mediasoup worker with a `WebRtcServer` on UDP and TCP 44390, a Router per room, signalling on a WebSocket and the test page under the site's CSP, on `127.0.0.1:4390`. Each person is a browser context that sends one audio track through the SFrame worker and reports what it decoded from everyone else. The checks are two-person rooms, a nine-person room that also measures the service, a member with the wrong key, a control that leaves the audio-level extension in, media over TCP, and fake capture devices. Media also listens on this machine's first LAN address, because Firefox's ICE fails against a loopback address alone (`VOICE_SERVER_ARGS="--listen-ip 127.0.0.1"` shows it); nothing else is exposed.

How each engine has to be started is in [`browsers.ts`](web/voice/check/browsers.ts): Playwright's WebKit needs a browser per person, the microphone permission and no Web Audio, and Chromium's fake microphone does not work on macOS here, so its capture check is skipped.

The group-key check is an ordinary Vitest spec, [`mls-design.spec.ts`](web/src/lib/voice/mls-design.spec.ts), and runs with `pnpm test`. Import ts-mls by subpath (`ts-mls/createCommit.js`), never from its root: the root loads a provider that needs a package ts-mls does not declare.

`mediasoup` runs a C++ worker beside Node. Its install script downloads the worker built for the platform, the architecture and, on Linux, the kernel's major version from mediasoup's GitHub release, which `allowBuilds` in `web/pnpm-workspace.yaml` permits; with no download it tries to compile one. To check a host, run the self-test, or bundle it as a release would be and run that where there is no `node_modules`:

```sh
node voice/prototype/sfu-selftest.ts
node voice/prototype/bundle.ts /tmp/voice-selftest
MEDIASOUP_WORKER_BIN=/tmp/voice-selftest/mediasoup-worker node /tmp/voice-selftest/sfu-selftest.js
```

## Deploy rivermindpoker.com

The site runs on the owner’s ubuntu-vm under the host's web platform contract (`/home/sawyer/github/ubuntu-vm-backup/docs/web-platform.md`). Caddy terminates HTTPS and proxies everything to `rivermind-poker-web.service`, the Node server running the current release from `/srv/rivermindpoker.com/current` on `127.0.0.1:4320` on Node 26 (`/opt/node-26/bin/node`): pages and assets, `/api/*` and the tables' `/ws`. Its tables are saved to PostgreSQL after every change and restored at start-up, so a restart or a deploy keeps every game, hands in progress included. After pushing `main`, update the live site with the following command.

```sh
ssh root@ubuntu-vm 'bash /home/sawyer/github/rivermind-poker/deploy/update.sh'
```

[The script](deploy/update.sh) deploys `origin/main` and fixes forward: there is no way back to an older release, so each release is checked as a candidate before it takes traffic. Outside the host's deploy lock, as sawyer, it archives the commit with `git archive` into `/home/sawyer/web-work/rivermindpoker.com-<commit>`, runs the Python suite from `uv.lock`, checks the champions on the host against the registry, and runs the web suite from the frozen lockfile on the pinned Node and pnpm: check, lint, Vitest with the database tests on the test database, the engine, bot and table parity checks, and the build. Then, in one `with-deploy-lock` process as root, it

1. stages the release as `/srv/rivermindpoker.com/<UTC time>-<commit12>` (root-owned, read-only to the service) with `REVISION` (the full commit), `.node-version`, `package.json`, `build/`, `deploy/` and `drizzle/`;
2. dumps the database to `/var/backups/rivermindpoker.com/pre-migrate-<commit>.dump`, runs the release's `build/migrate.js` as the service's user with only `migration.env`, and checks Drizzle's journal has every migration of the release;
3. starts the release from its own directory under a copy of its unit, `rivermind-poker-web-candidate`, on a free port in 4400-4499 with `RIVERMIND_CANDIDATE=1`: it connects to the real database as the web role, loads the champion and checks every saved table can be restored, but never restores, deals or saves one, so it is safe beside the live server. [`deploy/smoke.sh`](deploy/smoke.sh) checks its `/healthz` (the commit, the database, the tables, the champion), the main pages, a 404 and the headers, and the candidate is stopped;
4. installs the unit if it changed, switches `current` atomically and restarts the Node server;
5. waits for `/healthz` on the live port to report the commit, runs the smoke check there, and checks with `web-live` that the running process is the new release on `/opt/node-v26.13.1-linux-x64/bin/node`;
6. installs the [Caddy site](deploy/rivermindpoker.com.caddy) with `caddy-apply` if it changed;
7. logs `rivermindpoker.com <commit> live` and runs the smoke check on https://rivermindpoker.com.

Any failure stops the deploy and says which step failed. Before step 4 the previous release is still serving. After it, the new release is live: read `journalctl -u rivermind-poker-web`, fix it in a new commit and deploy again. The five newest releases are kept as evidence. What is live is what `/healthz` and `sudo /home/sawyer/github/ubuntu-vm-backup/bin/web-live rivermind-poker-web.service` report, never the checkout.

**Deploying a champion** (an owner gate, as every deploy is). A champion reaches the site in three steps. Promote it on the training machine (`blueprint promote`, [docs/bots.md](docs/bots.md#promotion-and-the-registry-p55)), which records it in the registry and in `web/src/lib/champions.json`. Copy `artifacts/models/<name>` to `/srv/rivermind-poker/models/champions/` on ubuntu-vm and compare its hashes ([the commands](docs/bots.md#where-models-are-kept)); that is server setup (D-10) and changes nothing players see. Then, with the owner's approval, push and deploy as usual. `update.sh` runs `rivermind-poker blueprint champions --verify` against that directory and stops before the site changes if a file is missing or differs. The web unit sets `RIVERMIND_MODELS`, and after the restart the script warns if `/api/config` does not offer RiverMind Hard. A table playing the old champion's seat simply meets the new one in its next decision. To withdraw a champion, deploy a release whose registry does not name it; its tables then play on against RiverMind Easy.

The web unit runs as a dynamic user with no access to the checkout or to anyone's home, and owns no file on the host. It gets `DATABASE_URL` from `/etc/web-apps/rivermind_poker/web.env` and the session secret as a systemd credential (`LoadCredential=`) from root-only `/var/lib/rivermind-poker/secret`, the file the first table server made, so guests stay signed in. Its limits are 2 GB (`MemoryHigh`) and 3 GB (`MemoryMax`); the champion's bundle takes about 0.55 GB of that.

The site database is set up once with [`deploy/setup-database.sh`](deploy/setup-database.sh), run as root on ubuntu-vm. It is safe to rerun and keeps existing passwords. It creates PostgreSQL roles for an owner, migrations, the web service and tests, plus the `rivermind_poker` and `rivermind_poker_test` databases, the site's `app` schema and the `drizzle` schema where `pnpm db:migrate` records migrations (both owned by the owner role), and pg_hba rules for 127.0.0.1. Credentials go in root-only `/etc/web-apps/rivermind_poker/web.env`, `migration.env` and `test.env`. `update.sh` runs the web suite's database tests against the test database with `test.env`, migrates the site database with `migration.env` before the candidate, and stops if an env file or the session secret is missing. The script edits `pg_hba.conf` itself, which predates the host's `bin/provision-app-database`; a new database on this host is provisioned with that instead.

After a deploy, `pnpm e2e:live` from `web/` checks the site’s headers, plays a hand at 2, 6 and 9 seats, sits out, comes back and rebuys, and, where the site serves a champion, practises against RiverMind Hard, changes to RiverMind Easy and opens its evaluation, and takes the P5.9 journey as a new guest ([`journey.live.ts`](web/e2e/journey.live.ts): practice in one click, RiverMind Hard, a finished hand opened from its result, another hand, the wallet unchanged); with `LIVE_RESTART_COMMAND="ssh root@ubuntu-vm systemctl restart rivermind-poker-web"` it also restarts the server mid-hand and checks the hand continues. Set `LIVE_URL` to smoke-test another deployment.

For bot changes, record the rules, seat count, training settings, checkpoint and evaluation opponent along with results. For engine changes, add a reproducible hand or action sequence that exercises the rule. Run the full suite before proposing a change to `main`.

## Project history

RiverMind's first commit preserves the copied source, including the original research scripts and visualization experiments. The next commit establishes the active project layout. Historical experiments can be inspected without installing their dependencies. Run `git ls-tree --name-only 0cca63f` to browse the snapshot.
