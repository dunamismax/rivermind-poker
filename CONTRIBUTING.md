# Developing RiverMind Poker

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

## Browser table

`rivermind-poker serve` runs a FastAPI app under Uvicorn. It serves the table API (`/api/*`) and the game WebSocket (`/ws`) and wraps `Table`; the browser client is the SvelteKit app below, which Caddy serves on the live site. Messages follow the typed protocol described under [SvelteKit client](#sveltekit-client). `POST /api/tables` with `{"opponents": "random"}` or `"checkpoint"` returns a table id and the human seat’s token. Play then runs over one WebSocket at `/ws`. The client first sends `{"type": "join", "table_id", "token"}`, so the token never appears in a URL or access log. After that it sends `act` with an action and `seq`, `next_hand` with `seq`, or `refresh`. Each change sends every connected socket its own seat’s view. A rejected message returns an error code with the current view. The browser stores the seat in `localStorage` and rejoins after reloads and dropped connections with backoff. With `--state_path`, the [store](poker_ai/web/store.py) saves each table to SQLite after every change, before anyone sees the new state. Tables are restored at startup, so a restart or crash mid-hand only shows players a brief reconnect. A saved table is about 6 KB, because the shared hand evaluator and card table are left out. Tables idle for a week are dropped. So are snapshots that a newer engine cannot restore, which is logged. Checkpoint tables are kept but not loaded when the server starts without a checkpoint. Snapshots are pickled and include seat tokens, so the file must stay private to the service. Without `--state_path`, tables live only in memory. Either way, idle tables are evicted when `--max_tables` is reached. The server binds to 127.0.0.1 by default. Put it behind an HTTPS reverse proxy before exposing it. [App](poker_ai/web/app.py) · [Tests](test/functional/test_web.py)

## SvelteKit client

The new browser client lives in [`web/`](web/). It is a SvelteKit single-page app (Svelte 5, strict TypeScript) built with `adapter-static`, and every route is served by the `200.html` fallback. Use the Node LTS major in [`web/.node-version`](web/.node-version) (mise reads it) and the pnpm version in `package.json`, which corepack provides. Run these from `web/`.

```sh
pnpm install --frozen-lockfile
pnpm check   # svelte-kit sync and svelte-check, warnings fail
pnpm lint    # Prettier and ESLint; `pnpm format` rewrites files
pnpm test    # Vitest unit tests
pnpm build   # static site in web/build
```

For development, run the table server and the Vite dev server side by side. Vite proxies `/api` and `/ws` to `http://127.0.0.1:8000`, so the client stays same-origin as it is behind Caddy. Set `RIVERMIND_BACKEND` to proxy somewhere else.

```sh
uv run --locked rivermind-poker serve --port 8000
pnpm dev
```

The wire protocol is defined once, as Pydantic models in [`poker_ai/web/protocol.py`](poker_ai/web/protocol.py). The server validates every incoming message with them and builds every outgoing one from them. `rivermind-poker protocol-schema` prints the JSON Schema, and `pnpm protocol` regenerates [`web/src/lib/protocol.ts`](web/src/lib/protocol.ts) from it. After changing a model, regenerate the file and commit both; `test/functional/test_protocol.py` fails while the TypeScript is stale. Malformed messages, including a `seq` sent as a string, are rejected with `bad_request`.

To run the production build the way the site serves it, pass the build to the table server. `serve --client_dir web/build` serves the client's files, falls back to `200.html` for every other path, caches `/_app/immutable/*` as immutable and sends the same security headers and Content-Security-Policy as the Caddy site.

```sh
pnpm build
cd .. && uv run --locked rivermind-poker serve --client_dir web/build --state_path artifacts/tables.sqlite3
```

The CSP allows no inline script or style. `pnpm build` therefore moves SvelteKit's inline bootstrap script into a hashed file (`web/scripts/externalize-bootstrap.js`) and fails if any page or module still carries inline code, and a small Vite plugin in `web/vite.config.ts` removes the inline style from SvelteKit's route announcer. Svelte transitions also inject styles at run time, so animate with CSS classes instead.

The UI is a set of components in `web/src/lib/components/`. `TableConnection` (`web/src/lib/table-connection.svelte.ts`) owns the socket: it joins with the saved seat, sends actions with the view's `seq`, rejoins with backoff (1, 2, 4, then 8 seconds) and keeps the seat in `localStorage`. The wording of buttons, actions, results and the hand log lives in `web/src/lib/wording.ts`. Cards are original SVG artwork in `web/static/cards/`, generated by `pnpm cards`; see [the card artwork notes](docs/card-art.md).

`pnpm e2e` runs the Playwright tests in `web/e2e/` in Chromium, Firefox and WebKit at desktop (1440×900) and phone (375×812) sizes. It builds the client once, then each worker starts its own `rivermind-poker serve --client_dir web/build --state_path …` on port 8700 and up, which some tests kill and restart. Install the browsers once with `pnpm exec playwright install`, and pass `--project chromium` for a quick run.

## Deploy rivermindpoker.com

The site runs on the owner’s ubuntu-vm from the checkout at `/home/sawyer/github/rivermind-poker`. Caddy terminates HTTPS, serves the built client from `/srv/rivermindpoker.com/current` and proxies `/api/*` and `/ws` to `rivermind-poker.service` on `127.0.0.1:4316`. After pushing `main`, update the live site with the following command.

```sh
ssh root@ubuntu-vm 'bash /home/sawyer/github/rivermind-poker/deploy/update.sh'
```

[The script](deploy/update.sh) fast-forwards the checkout and syncs the locked environment on Python 3.12. It runs the full test suite and builds the web client from the frozen lockfile (Node from `web/.node-version`, through mise on the server, and pnpm through corepack), and stops before the live site changes if either fails. It then migrates the site database. It then installs the [systemd unit](deploy/rivermind-poker.service) and [Caddy site](deploy/rivermindpoker.com.caddy), restarts the service, copies the build to a new release directory under `/srv/rivermindpoker.com/`, switches the `current` symlink to it atomically and reloads Caddy. The three newest releases are kept; to roll the client back, point `current` at an older one. Caddy caches `/_app/immutable/*` for a year and makes everything else revalidate, so browsers pick up a deploy on their next load. Open tables are saved in `/var/lib/rivermind-poker/tables.sqlite3` and survive the restart. Players see the client reconnecting for the roughly 23 seconds the card table takes to load. A change to the engine’s internal state can make older snapshots unrestorable. Such tables are dropped with a log message, so call out engine-state changes before deploying. Checkpoints and tables are not in Git. To serve a new pair, copy both into `artifacts/` on the server, update the paths in the unit file and run the script. Deploying to the live domain needs the owner’s authorization.

The site database is set up once with [`deploy/setup-database.sh`](deploy/setup-database.sh), run as root on ubuntu-vm. It is safe to rerun and keeps existing passwords. It creates PostgreSQL roles for an owner, migrations, the web service and tests, plus the `rivermind_poker` and `rivermind_poker_test` databases and pg_hba rules for 127.0.0.1. Credentials go in root-only `/etc/rivermind-poker/web.env`, `migration.env` and `test.env`. When those files exist, `update.sh` runs the test suite against the test database, runs `alembic upgrade head` on the site database before restarting the service, and the unit passes `DATABASE_URL` to the app.

After a deploy, `pnpm e2e:live` from `web/` checks the site’s headers and plays a hand against each opponent type; with `LIVE_RESTART_COMMAND="ssh root@ubuntu-vm systemctl restart rivermind-poker"` it also restarts the service mid-hand and checks the hand continues. Set `LIVE_URL` to smoke-test another deployment.

For bot changes, record the rules, seat count, training settings, checkpoint and evaluation opponent along with results. For engine changes, add a reproducible hand or action sequence that exercises the rule. Run the full suite before proposing a change to `main`.

## Project history

RiverMind's first commit preserves the copied source, including the original research scripts and visualization experiments. The next commit establishes the active project layout. Historical experiments can be inspected without installing their dependencies. Run `git ls-tree --name-only 0cca63f` to browse the snapshot.
