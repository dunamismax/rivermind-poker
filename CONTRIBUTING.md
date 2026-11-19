# Developing RiverMind Poker

Run commands from the repository root unless a step changes directory. Use Python 3.12 and uv to reproduce the locked development environment.

```sh
uv sync --locked
uv run pytest
uv run rivermind-poker --help
```

For a quick edit-and-test cycle, run `uv run pytest test/unit` or point pytest at the functional test for the component you changed. The suite includes action order, payouts, hand evaluation, card combinations and training checkpoint smoke tests. The smoke tests group all hands into one synthetic bucket per street so that training can run on a fresh checkout.

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

`rivermind-poker serve` runs a FastAPI app under Uvicorn. It serves the dependency-free JavaScript client from [`poker_ai/web/static`](poker_ai/web/static/) and wraps `Table`. Messages follow the typed protocol described under [SvelteKit client](#sveltekit-client). `POST /api/tables` with `{"opponents": "random"}` or `"checkpoint"` returns a table id and the human seat’s token. Play then runs over one WebSocket at `/ws`. The client first sends `{"type": "join", "table_id", "token"}`, so the token never appears in a URL or access log. After that it sends `act` with an action and `seq`, `next_hand` with `seq`, or `refresh`. Each change sends every connected socket its own seat’s view. A rejected message returns an error code with the current view. The browser stores the seat in `localStorage` and rejoins after reloads and dropped connections with backoff. With `--state_path`, the [store](poker_ai/web/store.py) saves each table to SQLite after every change, before anyone sees the new state. Tables are restored at startup, so a restart or crash mid-hand only shows players a brief reconnect. A saved table is about 6 KB, because the shared hand evaluator and card table are left out. Tables idle for a week are dropped. So are snapshots that a newer engine cannot restore, which is logged. Checkpoint tables are kept but not loaded when the server starts without a checkpoint. Snapshots are pickled and include seat tokens, so the file must stay private to the service. Without `--state_path`, tables live only in memory. Either way, idle tables are evicted when `--max_tables` is reached. The server binds to 127.0.0.1 by default. Put it behind an HTTPS reverse proxy before exposing it. [App](poker_ai/web/app.py) · [Tests](test/functional/test_web.py)

## SvelteKit client

The new browser client lives in [`web/`](web/). It is a SvelteKit single-page app (Svelte 5, strict TypeScript) built with `adapter-static`, and every route is served by the `200.html` fallback. It replaces the vanilla client during Phase 1. Use the Node LTS major in [`web/.node-version`](web/.node-version) (mise reads it) and the pnpm version in `package.json`, which corepack provides. Run these from `web/`.

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

`pnpm e2e` runs the Playwright tests in `web/e2e/`. It starts `rivermind-poker serve` on port 8000 and the built client under `vite preview` on port 4173, reusing servers that are already running outside CI. Install the browsers once with `pnpm exec playwright install`.

## Deploy rivermindpoker.com

The site runs on the owner’s ubuntu-vm from the checkout at `/home/sawyer/github/rivermind-poker`. Caddy terminates HTTPS and proxies to `rivermind-poker.service` on `127.0.0.1:4316`. After pushing `main`, update the live site with the following command.

```sh
ssh root@ubuntu-vm 'bash /home/sawyer/github/rivermind-poker/deploy/update.sh'
```

[The script](deploy/update.sh) fast-forwards the checkout and syncs the locked environment on Python 3.12. It runs the full test suite and stops if anything fails, then installs the [systemd unit](deploy/rivermind-poker.service) and [Caddy site](deploy/rivermindpoker.com.caddy), restarts the service and reloads Caddy. Open tables are saved in `/var/lib/rivermind-poker/tables.sqlite3` and survive the restart. Players see the client reconnecting for the roughly 23 seconds the card table takes to load. A change to the engine’s internal state can make older snapshots unrestorable. Such tables are dropped with a log message, so call out engine-state changes before deploying. Checkpoints and tables are not in Git. To serve a new pair, copy both into `artifacts/` on the server, update the paths in the unit file and run the script. Deploying to the live domain needs the owner’s authorization.

For bot changes, record the rules, seat count, training settings, checkpoint and evaluation opponent along with results. For engine changes, add a reproducible hand or action sequence that exercises the rule. Run the full suite before proposing a change to `main`.

## Project history

RiverMind's first commit preserves the copied source, including the original research scripts and visualization experiments. The next commit establishes the active project layout. Historical experiments can be inspected without installing their dependencies. Run `git ls-tree --name-only 0cca63f` to browse the snapshot.
