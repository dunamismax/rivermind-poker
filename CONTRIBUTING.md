# Developing RiverMind Poker

The site runs on SvelteKit on Node (`adapter-node`) with Tailwind CSS 4 and Drizzle ORM on PostgreSQL 18, behind Caddy. Python stays for training and evaluation (D-14, Phase 4B in [BUILD.md](BUILD.md)). Since the P4B.7 cutover the live table server is the TypeScript one in the Node server. The Python table server (`serve-nl`) and Alembic stay in the repository, tested and ready for a rollback, until P4B.8 removes them.

Run commands from the repository root unless a step changes directory. Use Python 3.12 and uv to reproduce the locked development environment.

```sh
uv sync --locked
uv run pytest
uv run rivermind-poker --help
```

For a quick edit-and-test cycle, run `uv run pytest test/unit` or point pytest at the functional test for the component you changed. The suite includes action order, payouts, hand evaluation, card combinations and training checkpoint smoke tests. The smoke tests group all hands into one synthetic bucket per street so that training can run on a fresh checkout.

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

From Phase 3, tables and hand histories live in PostgreSQL (D-4). [`rivermind/db`](rivermind/db/) has the SQLAlchemy 2 models and Alembic migrations, connecting through psycopg 3. The app reads `DATABASE_URL`, and a plain `postgresql://` URL is fine. The initial schema has `poker_tables`, `seats`, `hands` and `hand_histories`. Table state and hand records are versioned JSON from `rivermind.engine.history`, stored as `jsonb`. The database checks seat counts, blinds, buy-ins, seat numbers and stacks. [Models](rivermind/db/models.py) · [Migrations](rivermind/db/migrations/versions/)

The site runs PostgreSQL 18 and CI uses `postgres:18`; locally any PostgreSQL 16 or later works. With Homebrew, install and start a server, then create a development database and a separate test database.

```sh
brew install postgresql@18 && brew services start postgresql@18
createdb rivermind
createdb rivermind_test
DATABASE_URL=postgresql://localhost/rivermind uv run alembic upgrade head
```

The database tests in `test/db` use `RIVERMIND_TEST_DATABASE_URL`. Each test drops and recreates the `public` schema, so the test refuses to run unless the database name contains `test`. Without the variable the tests are skipped locally, but they fail in CI, where the test job runs a PostgreSQL 18 service. Set the variable for the full run before committing.

```sh
RIVERMIND_TEST_DATABASE_URL=postgresql://localhost/rivermind_test uv run pytest
```

After changing the models, generate a migration and review it, then check that `test_models_match_the_migrations` passes.

```sh
DATABASE_URL=postgresql://localhost/rivermind uv run alembic revision --autogenerate -m "describe the change"
```

### Drizzle (P4B.3)

The Node server will use the same database through Drizzle ORM on node-postgres. [`web/src/lib/server/db/schema.ts`](web/src/lib/server/db/schema.ts) declares every table, constraint and index of Alembic head `0006`, and [`web/drizzle/`](web/drizzle/) holds the SQL migrations, starting with `0000_baseline`, which builds exactly Alembic's schema. `test/db/test_drizzle_baseline.py` compares the two on every pytest run with the database, so until the Python server is retired (P4B.8) a schema change needs both an Alembic revision and a Drizzle migration. Tables are not schema-qualified: they follow `search_path`, which is `app` on ubuntu-vm and `public` locally.

`pnpm db:migrate` (from `web/`) applies pending migrations to `DATABASE_URL`, after `SET ROLE` to `RIVERMIND_MIGRATION_ROLE` when that is set. A database that Alembic has already migrated to `0006`, such as the live one, is adopted: the baseline is recorded as applied in `drizzle.__drizzle_migrations` and nothing else changes. To change the schema, edit `schema.ts`, generate a migration and review it. `drizzle-kit` writes `"public".` before referenced tables, so delete that qualifier; a Vitest test fails while it is there.

```sh
cd web
pnpm db:generate --name describe_the_change
DATABASE_URL=postgresql://localhost/rivermind pnpm db:migrate
```

The Vitest database tests (`*.db.spec.ts`) use `RIVERMIND_TEST_DATABASE_URL` like pytest, refuse a database whose name lacks `test`, and are skipped locally without it but fail in CI, where the `web` job has its own PostgreSQL 18 service. They drop the `public` and `drizzle` schemas, so do not run them at the same time as pytest on the same database.

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

`rivermind-poker serve-nl` runs the Phase 3 server for no-limit tables of 2 to 9 seats on the [engine](rivermind/engine/) and the Phase 2 bots. It speaks protocol v2, defined as Pydantic models in [`rivermind/server/protocol.py`](rivermind/server/protocol.py), whose module docstring describes the flow. Players are anonymous (P4.1). `POST /api/session` makes a player with a random handle, such as `Quiet Heron 42`, on a browser's first visit, or returns the player it already is, and sets the `rm_session` cookie: the player id and issue time signed with HMAC-SHA256, `HttpOnly`, `SameSite=Lax`, valid for 180 days and renewed on a visit after a day. It is `Secure` except over plain HTTP to a loopback host, where browsers would drop it. The cookie authenticates `POST /api/tables`, which creates a table with bots and seats the player, and the WebSocket at `/ws`, which opens with `hello` and can follow up to eight tables. Unsafe HTTP requests and WebSocket handshakes whose `Origin` is another host are refused with 403, except loopback pages calling a loopback server (the Vite proxy) and origins given with `--allowed_origin`. Players are stored in the `players` table with a database, or in memory without one. A Phase 3 bearer token sent once as `legacy_token` moves that player onto a cookie with their old guest handle. Each player has a play-chip [wallet](rivermind/server/wallet.py) (P4.2; play money only, D-1): the first visit grants 20,000, and a visit with less than 10,000 tops it back up to 10,000 at most once a day. The balance changes only together with a row in `ledger_entries` (grant, top-up, buy-in, rebuy, cash-out or refund), in one statement that refuses to go below zero, so the entries always add up to the balance. Buy-ins and rebuys are paid when asked for and refunded if the table refuses them. Chips come back when the player leaves, when a waiting rebuy no longer fits the buy-in range, and when an idle table closes with them seated; with a database these credits are written in the same transaction as the table save, so a crash cannot pay them twice or lose them. A crash between a buy-in and the table's next save can still lose that buy-in. `GET /api/wallet` returns the balance, the play-money notice and the newest entries. After every change, each follower gets a `table` message with their own view and the new public events, numbered by `seq` without gaps. An `act` carries the `seq` of the view it answers, so an action meant for an earlier turn is refused as `stale`. Sessions are signed with the secret in `RIVERMIND_SECRET` or `--secret_file` (created with mode 600 if missing), so they survive restarts. With `DATABASE_URL` (or `--database_url`) set to a migrated database, the [store](rivermind/server/store.py) saves each table as a versioned JSON [snapshot](rivermind/server/snapshot.py) in `poker_tables.state` after every change and before any socket hears of it, mirrors the seats, and stores each finished hand's replayable history in `hand_histories`. Open tables are restored at startup with their people marked disconnected until they rejoin, so a crash or restart mid-hand only shows a reconnect. If a save fails the table plays on from memory and the next save catches up. Without a database, tables live only in memory. The live site runs it (see [Deploy](#deploy-rivermindpokercom)).

```sh
DATABASE_URL=postgresql://localhost/rivermind uv run --locked alembic upgrade head
DATABASE_URL=postgresql://localhost/rivermind uv run --locked rivermind-poker serve-nl --port 8000 --secret_file artifacts/secret
```

Safety and abuse controls (P4.5, [`rivermind/server/safety.py`](rivermind/server/safety.py)). The app rate-limits unsafe HTTP requests per player (or per address without a session, 429 with `Retry-After`), new players per address and messages per socket (a `rate_limited` error, then a closed socket); Caddy limits the same endpoints per address in front of it. Behind Caddy the client's address is read from `X-Forwarded-For`, trusted only from a loopback peer. Tests that send requests faster than people pass `limits=safety.UNLIMITED` to `create_app`. There is no free-text chat (Q-4): seated people send preset `react` messages, which every follower receives as a `reaction` unless they muted or blocked the sender. `POST /api/reports` reports the person in a seat (once a day per reporter, person and reason) and `PUT /api/relations` mutes or blocks them; people are named to each other by a public `ref` (a hash of the player id), never the id. Blocked players are kept apart by quick seat and their tables are tagged in the lobby. When two people sit at one table from the same address, a `same_address` signal is stored with a keyed hash of the address, never the address. Review with `rivermind-poker moderation reports`, `moderation signals` and `moderation rename PLAYER_ID` (a new random handle), which read `DATABASE_URL`. Every handle the server makes passes a blocked-word filter.

Hand histories (P4.6, [`rivermind/server/hands.py`](rivermind/server/hands.py)). When a hand ends the table records who was dealt into each seat; with a database the store writes them to `hand_players` (with each seat's net) beside the hand's history, and without one the server keeps the newest 5,000 hands in memory. `GET /api/hands` lists the hands the player was dealt into, newest first (`limit` up to 50, `before` a hand id for the next page), and `GET /api/hands/{hand_id}` returns one with the player's own cards, the board, every action, the hands shown at showdown and a readable history with names; folded and mucked hands are never included, and other players get 404. The client shows them at `/hands`, and `/fairness` explains dealing and the table rules. It names the generator the live server deals from: `crypto.randomInt` in Node since P4B.7 (D-8); `serve-nl` deals from `secrets.SystemRandom`, the same operating-system source.

The client for it is the SvelteKit app's main page ([`web/src/lib/nl/`](web/src/lib/nl/)): a lobby to pick 2 to 9 seats, the bots, the blinds and a buy-in, and a pixel-art table that keeps your seat at the bottom, shows each turn's clock as a segmented bar (green for the action time, red for the time bank), and offers a bet slider with minimum, ½ pot, ¾ pot, pot and all-in presets clamped to the legal range, plus sitting out, rebuys and leaving. Seat and bet positions are CSS classes generated from `layout.ts` into `seat-places.css`, a wide map for landscape screens and a tall one for phones and upright tablets, because the CSP blocks inline styles; a Vitest check fails if the file is stale. Run `serve-nl` behind the Node server (`RIVERMIND_LEGACY_API`), or proxy to it from `pnpm dev`. A page of the old short-deck client still open at the cutover is told its table closed, and a browser that still holds a short-deck seat shows the same notice in the lobby. The protocol's types are [`web/src/lib/protocol-v2.ts`](web/src/lib/protocol-v2.ts), which is its source since P4B.5b; the Pydantic models follow it. [App](rivermind/server/app.py) · [Tests](test/server/test_protocol_v2.py) · [Durability tests](test/db/test_durable_tables.py)

### The TypeScript API (P4B.5a)

[`web/src/lib/server/api/`](web/src/lib/server/api/) ports the parts of `serve-nl` that need no running table to TypeScript (D-14): session cookies and legacy tokens (`auth.ts`, the same format, signed message and secret, so guests stay signed in across the cutover), players and handles (`players.ts`), wallets and the ledger (`wallet.ts`), rate limits, the handle filter, reports, mutes, blocks and signals (`safety.ts`), hand histories (`hands.ts`, `views.ts`), runtime checks of every request body and socket message with Pydantic's rules and wording (`protocol.ts` on `validate.ts`, each schema type-checked against the generated `protocol-v2.ts`), and the routes `GET /api/config`, `POST /api/session`, `GET /api/wallet`, `GET /api/hands`, `GET /api/hands/{id}`, `GET /api/relations` and `DELETE /api/relations/{ref}` (`api.ts`). Each store has a memory and a Drizzle version. The lobby, seating, practice, reports and new mutes and blocks act on a running table and are part of [the table server](#the-typescript-table-server-p4b5b).

With `RIVERMIND_API=1` and no `RIVERMIND_LEGACY_API`, the Node server answers `/api/*` with it ahead of SvelteKit ([`web/server/api.ts`](web/server/api.ts)), and `/ws` with the table server; both stay off until the P4B.7 cutover, since live Caddy sends `/api` and `/ws` to `serve-nl`. It runs ahead of SvelteKit because SvelteKit 3's CSRF check, which cannot be turned off, refuses unsafe requests with no body type whose `Origin` is not the site's own, which `serve-nl` accepts from loopback dev pages and non-browser clients; the API makes its own origin checks. It reads `RIVERMIND_SECRET` or `RIVERMIND_SECRET_FILE`, `DATABASE_URL`, `RIVERMIND_ALLOWED_ORIGINS` (comma-separated), `RIVERMIND_PRACTICE_STACK`, `RIVERMIND_HAND_PAUSE`, `RIVERMIND_BOT_DELAY` and `RIVERMIND_MAX_TABLES`, as listed in [`runtime.ts`](web/src/lib/server/api/runtime.ts). From `web/`, after `pnpm build` and `pnpm db:migrate`:

```sh
PORT=3000 RIVERMIND_API=1 DATABASE_URL=postgresql://localhost/rivermind RIVERMIND_SECRET_FILE=../artifacts/secret pnpm start
```

`contract.json` holds `serve-nl`'s answers to a fixed script of requests and the values of its pure functions (cookies, tokens, refs, guest names, address tags, the handle filter, origin rules), recorded with a fixed clock by `uv run --locked python -m test.server.export_http_contract` from the repository root; pytest fails while it is stale. Vitest replays the script against the TypeScript API in memory (`contract.spec.ts`) and on PostgreSQL (`contract.db.spec.ts`) and expects the same status, headers and body text byte for byte.

### The TypeScript table server (P4B.5b)

The tables themselves are ported too, so the Node server can run the whole site without Python. It is off live until the P4B.7 cutover.

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

Parity with `serve-nl` is measured in three ways, each with a small recorded file that pytest keeps current and Vitest replays without Python.

- **The table.** `uv run --locked python -m test.server.table_differential --fixture` writes [`parity.json`](web/src/lib/server/table/parity.json): seeded random requests (seating, holds, the waitlist, hands, clocks, snapshot round trips) with a digest of every answer, event and snapshot, and two tables saved mid-hand in snapshot formats 1 and 2. `pnpm table:parity` runs a longer fuzz against Python directly (`-- --sequences 400 --ops 300` for the long run) and names the first field that differs.
- **The whole server.** `uv run --locked python -m test.server.export_table_contract` writes [`table-contract.json`](web/src/lib/server/api/table-contract.json): a session of 168 steps played against `serve-nl` on one event loop, with fixed clocks, seeded decks and numbered table ids. Each step records its HTTP response as text and a digest of every socket message. `table-contract.spec.ts` and `tables.db.spec.ts` replay it in memory and on PostgreSQL. To find a difference, record again with `--full /tmp/full.json` and set `TABLE_CONTRACT_FULL` to that file.
- **One database, two servers.** `tables.db.spec.ts` starts a real `serve-nl`, kills it mid-hand, restores the table in the TypeScript server, plays on, then hands the table back to a new `serve-nl`: the cutover and its rollback. It needs `uv` and `RIVERMIND_TEST_DATABASE_URL`.

Seeded tests deal the same cards in both servers: `seededDealer(seed)` draws as `random.Random(seed)` does, for the shuffle and for the bots' own generator.

### RiverMind Hard: serving a champion (P5.7a)

With `RIVERMIND_MODELS` set, the Node server plays the registry's heads-up champion ([docs/models.md](docs/models.md)) as **RiverMind Hard**, at two-seat tables and in practice. [`champions.ts`](web/src/lib/server/bots/champions.ts) loads `<models>/<name>/bundle` and refuses it unless every file's SHA-256 is the one in [`web/src/lib/champions.json`](web/src/lib/champions.json), the extract of the registry that `rivermind-poker blueprint promote` writes and the release is built with. It also checks the card table set and the checkpoint the bundle names. So the strategy at a table is the one whose evaluation its label links to (D-7). Without the variable, or when the check fails, the server logs why and runs without that bot.

```sh
PORT=3000 RIVERMIND_API=1 RIVERMIND_MODELS=../artifacts/models ORIGIN=http://127.0.0.1:3000 pnpm start
# RiverMind Hard plays hu-m1-s0-1024m: bundle … checked against the registry in 0.8 s (strategy.u8 31a782ea…, table set 4ff8b0ef…)
```

- **What players see.** `GET /api/config` lists the bot with `seats: [2]` and `champion`: the model's name and the promotion gate's results for the served strategy. The lobby shows the result against RiverMind Easy with its 95% interval beside “Practice vs RiverMind Hard”, and links to [`/bots`](web/src/routes/bots/+page.svelte), which shows every matchup of the champion's evaluations from `champions.json` and what they do not say. “Practice vs bots” still starts RiverMind Easy in one click.
- **Changing opponents.** `POST /api/practice` takes `{"bot": "hard"}`. At a new table it chooses the opponent; at a table already running it changes it, at once between hands and otherwise when the hand ends, and the answer's `next_bot` names the bot still waiting. The practice table's “Opponent” control does this. `serve-nl` does the same among the bots it runs.
- **One policy a table.** The policy remembers how it mapped each hand's bets, so every table gets its own (`forTable`) over the one copy of the arrays.
- **A missing bot.** A saved table whose bot the server does not run, which is RiverMind Hard after its bundle went missing or after a rollback to `serve-nl`, plays on against RiverMind Easy under that label, in both servers. Seats, stacks and the hand in progress are kept.
- **Tests.** [`champion.spec.ts`](web/src/lib/server/api/champion.spec.ts) writes a small champion and its registry extract, and also loads the registered bundle from `artifacts/models` when it is there. The browser tests' server gets one from `e2e/global-setup.ts` through `RIVERMIND_MODELS` and `RIVERMIND_CHAMPIONS`, a registry extract to use instead of the built-in one; that variable is for tests only.

## SvelteKit client

The browser client lives in [`web/`](web/). It is a SvelteKit app (Svelte 5, strict TypeScript) built with `adapter-node` and served by a small Node server of its own (P4B.1, D-14). The pages are client-rendered (`ssr = false` in the root layout). Use the Node LTS major in [`web/.node-version`](web/.node-version) (mise reads it) and the pnpm version in `package.json`, which corepack provides. Run these from `web/`.

```sh
pnpm install --frozen-lockfile
pnpm check   # svelte-kit sync and svelte-check, warnings fail
pnpm lint    # Prettier and ESLint; `pnpm format` rewrites files
pnpm test    # Vitest unit tests
pnpm build   # the Node build in web/build, with the server bundled as build/start.js
pnpm start   # node build/start.js
```

For development, run the table server and the Vite dev server side by side. Vite proxies `/api` and `/ws` to `http://127.0.0.1:8000`, so the client stays same-origin as it is behind Caddy. Set `RIVERMIND_LEGACY_API` (or the older `RIVERMIND_BACKEND`) to proxy somewhere else.

```sh
uv run --locked rivermind-poker serve-nl --port 8000
pnpm dev
```

The no-limit protocol is defined once, in [`web/src/lib/protocol-v2.ts`](web/src/lib/protocol-v2.ts), its source since P4B.5b. The TypeScript server checks every incoming message against it ([`protocol.ts`](web/src/lib/server/api/protocol.ts)). Until the Python server is removed (P4B.8), `serve-nl`'s Pydantic models in [`rivermind/server/protocol.py`](rivermind/server/protocol.py) must describe the same types: change both together, and `test/server/test_protocol_v2.py` fails while they differ. `rivermind-poker protocol-schema --version 2` prints the JSON Schema. The legacy short-deck protocol is still generated: `pnpm protocol` rewrites `protocol.ts` from `poker_ai/web/protocol.py`, and `test/functional/test_protocol.py` fails while it is stale. Malformed messages, including a `seq` sent as a string, are rejected with `bad_request`.

To run the production build the way the site serves it, start the Node server in front of the table server. [`web/server/`](web/server/) puts SvelteKit's `handler.js` and the `/ws` WebSocket on one HTTP server, answers `/healthz`, sends the site's security headers, caches `/_app/immutable/*` as immutable and makes everything else revalidate, and on SIGTERM finishes open requests before exiting. Until the P4B.7 cutover the tables are still in Python, so `RIVERMIND_LEGACY_API` makes it forward `/api/*` and `/ws` to `serve-nl` unchanged, with the browser's `Host` and `Origin`. Without it, and with `RIVERMIND_API=1`, the Node server serves `/api/*` and `/ws` itself (see [the TypeScript table server](#the-typescript-table-server-p4b5b)). With neither, `/api/*` goes to SvelteKit (a 404) and `/ws` closes every socket with code 1013. Set `ORIGIN` to the address the browser uses, since adapter-node otherwise assumes https. `PORT`, `HOST`, `RIVERMIND_BUILD_DIR`, `SHUTDOWN_TIMEOUT` and adapter-node's handler variables are listed in [`web/server/index.ts`](web/server/index.ts).

```sh
(cd .. && DATABASE_URL=postgresql://localhost/rivermind uv run --locked rivermind-poker serve-nl --port 8000 --secret_file artifacts/secret) &
pnpm build
PORT=3000 ORIGIN=http://127.0.0.1:3000 RIVERMIND_LEGACY_API=http://127.0.0.1:8000 pnpm start
```

The CSP allows no inline script or style apart from SvelteKit's start-up script. Its hash goes in each page's policy (`csp` in `web/vite.config.ts`), and `web/src/hooks.server.ts` adds the page's own `ws://` or `wss://` origin to `connect-src`. `pnpm build` fails if a client module renders a style attribute, or if any page the built handler serves has an unhashed inline script, a `<style>` element, a style attribute or an inline event handler (`web/scripts/check-inline-code.js`). A small Vite plugin in `web/vite.config.ts` removes the inline style from SvelteKit's route announcer. Svelte transitions also inject styles at run time, so animate with CSS classes instead.

The no-limit UI is in `web/src/lib/nl/`. `NlConnection` (`connection.svelte.ts`) owns the socket: on page load it calls `POST /api/session`, says hello (the cookie authenticates it), follows the saved table, sends actions with the view's `seq`, rejoins with backoff (1, 2, 4, then 8 seconds) and keeps the table in `localStorage`. The page never sees the session. Bet sizes and log wording live in `bet.ts`. The short-deck components in `web/src/lib/components/` stay until P7.6; `PlayingCard` is shared. The cards, chips, avatars, frames and the pixel font are original pixel art drawn as text in `web/art/` and rendered by `pnpm art` into `web/src/lib/art/`; see [the design notes](docs/design.md) and the `/style` reference page.

`pnpm e2e` runs the Playwright tests in `web/e2e/` in Chromium, Firefox and WebKit at desktop (1440×900) and phone (375×812) sizes. It builds the client once. Then each worker starts the built Node server (`node build/start.js`) on port 8800 and up, serving the pages, the API and the tables itself, with tables in memory (their durability is tested in Vitest and pytest). With `E2E_LEGACY=1` each worker also starts a `rivermind-poker serve-nl` 100 ports below and the Node server forwards to it, as the live site does until P4B.7; CI runs Chromium that way as well. The tests play at 2, 6 and 9 seats. Install the browsers once with `pnpm exec playwright install`, and pass `--project chromium` for a quick run.

### Comparing screenshots (P4B.2)

`pnpm visual` captures fixed scenes of the production build for comparing two commits pixel for pixel: the lobby, a table being watched and the player menu, a heads-up table at the first turn, with a bet being sized and at the result, a practice table, a private table's invite, a full nine-seat table and the seat tools, `/style`, `/fairness`, and `/hands` with a hand open. It takes them at 375×812, 768×1024 and 1440×900 at one, two and three device pixels per CSS pixel, and at 1024×768 and 860×600 at one, in Chromium, Firefox and WebKit: 462 PNGs under `VISUAL_OUT` (`artifacts/visual/current` by default).

Each size gets its own site from [`web/e2e/visual/server.ts`](web/e2e/visual/server.ts), a test-only server built from the same parts as the live one, with seeded decks and bots, handles from a fixed list, numbered table ids and clocks that stand still; the browser's clock, time zone and locale are pinned too. The live server has no seeding switch (D-8). A scene is saved once two captures in a row agree.

```sh
git stash                                              # or check out the commit to compare with
VISUAL_OUT=../artifacts/visual/before-1 pnpm visual    # two or three times, into before-1, before-2, ...
git stash pop
VISUAL_OUT=../artifacts/visual/after pnpm visual
pnpm visual:compare ../artifacts/visual/before-1 ../artifacts/visual/before-2 ../artifacts/visual/after --diff ../artifacts/visual/diff
```

`pnpm visual:compare` passes a pixel only when some "before" capture has exactly that value there. One "before" run is the strict test. Several allow for what a browser does not draw the same way twice: Chromium anti-aliases the fanned (rotated) cards differently between runs of one build at three device pixels per CSS pixel, by 15 to 130 pixels in a capture of 11.6 million, so capture that size a few more times (`--project chromium -g "@3"`) when it is the only difference. `--diff` writes each failing capture with the changed pixels in magenta. `pnpm visual` builds first unless `E2E_SKIP_BUILD` is set, keeps its own `test-results-visual`, and takes ports from 8950 (`VISUAL_PORT`).

## Deploy rivermindpoker.com

The site runs on the owner’s ubuntu-vm. Caddy terminates HTTPS and proxies everything to `rivermind-poker-web.service`, the Node server running the current release from `/srv/rivermindpoker.com/current` on `127.0.0.1:4320`: pages and assets, `/api/*` and the tables' `/ws` (P4B.7). Its tables are saved to PostgreSQL after every change and restored at start-up, so a restart or a deploy keeps every game. After pushing `main`, update the live site with the following command.

```sh
ssh root@ubuntu-vm 'bash /home/sawyer/github/rivermind-poker/deploy/update.sh'
```

[The script](deploy/update.sh) fast-forwards the checkout, then checks everything before the live site changes. It syncs the locked environment on Python 3.12 and runs the Python suite with the database tests. From the frozen lockfile (Node from `web/.node-version`, through mise on the server, and pnpm through corepack) it runs `pnpm check`, `pnpm lint`, Vitest on the same test database, `pnpm table:parity` against the Python table, and the build. If any of that fails it stops there. It then runs the Drizzle migrations (`pnpm db:migrate` with `migration.env`), installs the [web server unit](deploy/rivermind-poker-web.service) and the [Caddy site](deploy/rivermindpoker.com.caddy), stops the Python table server if it is running, copies the build into a new release directory under `/srv/rivermindpoker.com/` (as `build/`, beside a `package.json` that marks it as ES modules), switches the `current` symlink to it atomically and restarts the web server. Once the server answers `/healthz` and `/api/config`, with its tables restored, it reloads Caddy. The three newest releases are kept; to roll the build back, point `current` at an older one (`ln -sfn <release> current.new && mv -T current.new current`) and restart `rivermind-poker-web`.

**Deploying a champion** (an owner gate, as every deploy is). A champion reaches the site in three steps. Promote it on the training machine (`blueprint promote`, [docs/bots.md](docs/bots.md#promotion-and-the-registry-p55)), which records it in the registry and in `web/src/lib/champions.json`. Copy `artifacts/models/<name>` to `/srv/rivermind-poker/models/champions/` on ubuntu-vm and compare its hashes ([the commands](docs/bots.md#where-models-are-kept)); that is server setup (D-10) and changes nothing players see. Then, with the owner's approval, push and deploy as usual. `update.sh` runs `rivermind-poker blueprint champions --verify` against that directory and stops before the site changes if a file is missing or differs. The web unit sets `RIVERMIND_MODELS`, and after the restart the script warns if `/api/config` does not offer RiverMind Hard. A table playing the old champion's seat simply meets the new one in its next decision. To withdraw a champion, deploy a release whose registry does not name it; its tables then play on against RiverMind Easy.

The web unit runs as a dynamic user with no access to the checkout or to anyone's home. It gets `DATABASE_URL` from `/etc/rivermind-poker/web.env` and the session secret as a systemd credential (`LoadCredential=`) from `/var/lib/rivermind-poker/secret`, the file `serve-nl` made, so guests stay signed in. Its limits are 2 GB (`MemoryHigh`) and 3 GB (`MemoryMax`); the champion's bundle takes about 0.55 GB of that.

**Going back to `serve-nl`** (until P4B.8). [`deploy/rollback-to-serve-nl.sh`](deploy/rollback-to-serve-nl.sh), run as root on ubuntu-vm, stops the Node server, installs the pre-cutover [web unit](deploy/rollback/rivermind-poker-web.service) and [Caddy site](deploy/rollback/rivermindpoker.com.caddy) and starts [`rivermind-poker.service`](deploy/rollback/rivermind-poker.service), which restores the same tables; the Node server then serves only pages. `update.sh` cuts over again. The two servers must never run the tables at once: each restores every open table and deals it. The web unit names the Python one in `Conflicts=`, so systemd stops one when the other starts, and both scripts stop the running server before starting the other. Both directions were rehearsed mid-hand on a copy of the live database before the cutover (the P4B.7 evidence in [BUILD.md](BUILD.md)), and `tables.db.spec.ts` repeats the handover on every test run.

The site database is set up once with [`deploy/setup-database.sh`](deploy/setup-database.sh), run as root on ubuntu-vm. It is safe to rerun and keeps existing passwords. It creates PostgreSQL roles for an owner, migrations, the web service and tests, plus the `rivermind_poker` and `rivermind_poker_test` databases, the site's `app` schema and the `drizzle` schema where `pnpm db:migrate` records migrations (both owned by the owner role), and pg_hba rules for 127.0.0.1. Credentials go in root-only `/etc/rivermind-poker/web.env`, `migration.env` and `test.env`. `update.sh` runs both suites against the test database when `test.env` exists, runs `pnpm db:migrate` on the site database before restarting the service, and stops if `web.env` or the session secret is missing.

After a deploy, `pnpm e2e:live` from `web/` checks the site’s headers, plays a hand at 2, 6 and 9 seats, sits out, comes back and rebuys, and, where the site serves a champion, practises against RiverMind Hard, changes to RiverMind Easy and opens its evaluation; with `LIVE_RESTART_COMMAND="ssh root@ubuntu-vm systemctl restart rivermind-poker-web"` it also restarts the server mid-hand and checks the hand continues. Set `LIVE_URL` to smoke-test another deployment.

For bot changes, record the rules, seat count, training settings, checkpoint and evaluation opponent along with results. For engine changes, add a reproducible hand or action sequence that exercises the rule. Run the full suite before proposing a change to `main`.

## Project history

RiverMind's first commit preserves the copied source, including the original research scripts and visualization experiments. The next commit establishes the active project layout. Historical experiments can be inspected without installing their dependencies. Run `git ls-tree --name-only 0cca63f` to browse the snapshot.
