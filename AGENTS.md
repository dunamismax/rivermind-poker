# Working on RiverMind Poker

The working manual for every coding agent, and every person, who changes this repository. Read it before you change anything, then read **Now** in [BUILD.md](BUILD.md). BUILD.md says what to build and records where work stands; this file says how to work. When they disagree about what to build, BUILD.md wins. When they disagree about how to work, this file wins.

> **No AI attribution, ever.** Commit messages, tags, release notes, code, comments, docs and file headers never mention Claude, Anthropic, ChatGPT, OpenAI or any other AI tool. No `Co-Authored-By` trailers, no “Generated with …” lines, no tool signatures. Use the configured git identity and never change git config. Re-read every commit message before committing and remove anything your tooling added by default.

Contents:

1. [What RiverMind is](#1-what-rivermind-is)
2. [Session workflow](#2-session-workflow)
3. [Autonomy and owner gates](#3-autonomy-and-owner-gates)
4. [Git](#4-git)
5. [Parallel sessions and background runs](#5-parallel-sessions-and-background-runs)
6. [Stack and layout](#6-stack-and-layout)
7. [Commands](#7-commands)
8. [Conventions and invariants](#8-conventions-and-invariants)
9. [Testing pitfalls](#9-testing-pitfalls)
10. [The live server](#10-the-live-server)
11. [Security baseline](#11-security-baseline)
12. [Repository boundaries](#12-repository-boundaries)
13. [Documentation](#13-documentation)
14. [Toolchain](#14-toolchain)
15. [Context7 documentation lookup](#15-context7-documentation-lookup)

---

## 1. What RiverMind is

A free, self-hosted poker site at https://rivermindpoker.com: no-limit Texas hold’em at 2 to 9 seats against anonymous people and labelled bots, for play money only. It is also a poker AI project, whose bots are trained offline with MCCFR and served by the site. [BUILD.md](BUILD.md#the-10-product) defines the 1.0 product, and [docs/roadmap.md](docs/roadmap.md) explains the architecture and the order of the phases.

These settled decisions (the `D-n` table in BUILD.md) settle most design questions. Change one only with the owner’s approval.

- **Play money only, forever** (D-1). Nothing may let chips be bought, sold, cashed out or transferred for value.
- **Bots are honest** (D-7). They are always labelled, never pose as people, and every strength claim links to a published evaluation in `docs/evaluations/`.
- **The server is authoritative** (D-2). It owns the deck, turns, validation and payouts, and a client sees only its own seat’s private information.
- **Fair dealing** (D-8). Live tables shuffle with the operating system’s cryptographic randomness. Seeded generators are for tests, training and evaluation only.
- **Guests, not accounts** (D-12). No sign-in before 1.0.
- **Player priorities** (D-13). One-click practice, then one evaluated heads-up opponent, then replay from the table, verified together at P5.9 before more bot formats, site features or hardening. The stack migration (D-14) comes first, and table voice (D-15) runs alongside, ahead of a ready Phase 5A step.
- **Table voice is end-to-end encrypted** (D-15). The site’s headline feature: seated people talk live, and the voice server relays only frames it cannot decrypt. No unencrypted fallback, and nothing is recorded or stored. Phase 4C and [docs/voice.md](docs/voice.md) hold the plan.
- **No third-party tracking** (Q-6) and **no free-text chat in 1.0** (Q-4).

When choosing between two ways of doing something, prefer the one that is measured over the one that is assumed: engines and bots are checked against their references byte for byte, evaluations are reproducible from their recorded inputs, and performance targets are met by measurement.

## 2. Session workflow

[BUILD.md](BUILD.md#how-to-work-this-file)’s **How to work this file** is the full procedure. The essentials:

1. **Orient.** Read **Now** in BUILD.md, then run `git status --short --branch` and `git log -5 --oneline --decorate`. Preserve unrelated work in the tree. Check whether a training run or another session is using the machine ([section 5](#5-parallel-sessions-and-background-runs)).
2. **Choose.** The owner’s current request comes first. Otherwise take **Next step**, or the first unchecked step in the current phase whose dependencies are checked. Claim it under **In progress** before you start.
3. **Build and verify.** Write tests with the code. Verify every criterion of the step through the real entry point (the CLI, the browser, the server or the live site) as well as with tests. For engine changes, exercise a reproducible hand or action sequence. For training changes, record the rules, seat count, settings and artifacts used. Run the full suites before committing ([section 7](#7-commands)).
4. **Record.** Tick verified criteria and add an `Evidence:` line with the commit and the checks you ran. For partial work, add a `Remaining:` line instead of ticking the step. Update **Now**.
5. **Hand off.** Prepend a dated entry to the handoff log (keep eight; move older ones to [docs/build-history.md](docs/build-history.md)). Review the final working tree and diff, including new files. Report what was done, what is next and what waits on the owner.

Build on the settled decisions (`D-n`). Use an open question’s default (`Q-n`) rather than waiting for an answer.

## 3. Autonomy and owner gates

**Decide it yourself.** Libraries, code structure, algorithms, file layout, test strategy and tuning are yours to choose. So is splitting a step, adding one you find is needed, or rewording a criterion that turned out to be wrong; say why in the handoff entry. Record anything a later session would wonder about in BUILD.md or the relevant doc.

**Owner gates.** Get the owner’s explicit approval, in the current conversation, for each separate action of:

- pushing to a remote;
- deploying to the live domain;
- tagging a release or publishing anything;
- a step marked **Owner gate**, or anything touching money or real identity;
- changing a settled decision, deleting an unfinished step, lowering acceptance criteria or reordering phases (raise these as an open question instead).

Approval for one push or deploy does not carry over to the next.

**Server setup is pre-authorized** (D-10). You may SSH into ubuntu-vm as root and install packages, set up databases, roles, services, files and configuration without asking. Keep the host’s other sites working, follow its conventions (see `deploy/setup-database.sh`) and record what changed in BUILD.md. This does not cover deploying to the live domain.

**When blocked,** work on a ready prerequisite within the current phase, or record exactly what is needed to proceed, and stop only at an owner gate.

## 4. Git

- **`main` only.** Never create branches, worktrees or pull requests, and never force-push.
- **Commit** verified work to `main` when a step or a coherent part of one is done, or when the owner asks. **Push** only with the owner’s approval, with `git push origin main`. `origin` has two push URLs, so one push updates both GitHub and Codeberg.
- **Before committing:** run the full Python suite with the database tests and, for any change under `web/`, the full web suite ([section 7](#7-commands)). Check `git status` for stray files, make sure every intended change is staged (including files edited after a rename), and never commit anything `.gitignore` excludes.
- **Messages:** a short imperative summary line, then a brief body saying what changed and why, naming the BUILD.md step (`P4B.5a`) where there is one.
- **Shared checkout:** stage explicit paths. Commit only your own files (`git commit -- <paths>`, or a temporary index when a file mixes your hunks with another session’s).
- **No AI attribution** (see the top of this file).

## 5. Parallel sessions and background runs

The owner runs several sessions at once, often in this checkout, and long training runs on this Mac.

- **Claim one step per session** under **In progress**, and stay out of the files another session’s step owns. Shared files (BUILD.md, AGENTS.md, `web/package.json`, `web/pnpm-lock.yaml`, `pyproject.toml`, `uv.lock`) take small edits, made right before committing.
- **Expect half-finished work.** Another session may leave staged or uncommitted changes. If its edits break the build, verify yours in a scratch copy of `main` plus your changes. Do the same before `pnpm add` or `uv add` while another session’s tests are running.
- **Don’t rebuild `web/build` while Playwright is running**, yours or anyone else’s: the run breaks.
- **Training runs in the background.** **Now** names any run in progress and the command that resumes it. Leave it running. Stop it only with SIGTERM (or Ctrl-C), which finishes the batch and writes a checkpoint first, and resume it with `--resume` at low priority (`nice -n 19`).
- **Heavy load changes timing.** With training and other sessions running, the load average can pass 100. A timing-sensitive test that fails under load and passes alone is still worth a look before you call it flaky: a ledger check that failed once under load turned out to be a real race in `serve-nl` (see the P4.2/P4.4 handoff in BUILD.md). Record the load when you report a failure.

## 6. Stack and layout

The stack is SvelteKit 3 · Svelte 5 · TypeScript · Tailwind CSS 4 · PostgreSQL 18 + Drizzle ORM · Node (`adapter-node`) · Caddy (D-14). The live site has run on all of it since the P4B.7 cutover: one Node service, `rivermind-poker-web` on 127.0.0.1:4320, serves the pages, the API and the tables on `/ws`. The Python table server (`serve-nl`, FastAPI, SQLAlchemy and Alembic) stays in the repository, tested and installed but stopped, as the rollback until P4B.8 removes it.

| | Live | Kept for a rollback until P4B.8 |
| --- | --- | --- |
| Pages and assets | SvelteKit on Node (`rivermind-poker-web`, 127.0.0.1:4320) | The same |
| Table API and `/ws` | The same Node server (`web/src/lib/server/table`, `api`) | Python `serve-nl` (`rivermind-poker`, 127.0.0.1:4316), started by `deploy/rollback-to-serve-nl.sh` |
| Engine and bots on the site | TypeScript (`web/src/lib/server/engine`, `bots`), kept in step with Python | Python (`rivermind/engine`, `rivermind/bots`) |
| Schema and migrations | Drizzle (`web/drizzle/`), run by `deploy/update.sh` | Alembic (`rivermind/db`), which builds the same schema |
| Styling | Tailwind CSS 4 utilities on a theme generated by `pnpm art` (P4B.2), over the kit in `pixel.css` | |

**Where new code goes.**

- Write new site, API, table, engine-serving and database code in TypeScript in `web/`, with server-only code under `web/src/lib/server/`.
- Change `rivermind/server` and `rivermind/db` only to keep the rollback working and in step with the TypeScript server; both are removed at P4B.8.
- Python stays for offline work: `rivermind/engine` is the reference engine, and `rivermind/bots` builds card tables, trains, evaluates and exports serving bundles.
- `poker_ai/` is the short-deck prototype and the terminal client: fixed but not extended until P7.6.
- Keep protocol v2, session cookies, table snapshots and hand histories wire-compatible with `serve-nl` until P4B.8, so open tables, stored hands and guests survive a rollback. A format change gets a version bump and a reader for the old version.

**Layout.**

```text
web/                             SvelteKit app (Node from web/.node-version, pnpm through corepack)
  src/routes/                    pages: the lobby and table (/), /hands, /fairness, /style
  src/lib/nl/                    no-limit lobby and table UI; connection.svelte.ts owns the socket
  src/lib/engine/                browser-safe cards and evaluator
  src/lib/server/engine/         TypeScript engine (P4B.4); rules.json is generated from Python fixtures
  src/lib/server/bots/           TypeScript bots and BlueprintPolicy (P4B.6), with PythonRandom
  src/lib/server/db/             Drizzle schema, pool, migrator and test-database guard (P4B.3)
  src/lib/server/table/          table, clock, snapshot, runner and Drizzle table store (P4B.5b)
  src/lib/server/api/            sessions, players, wallets, safety, hands, the HTTP API (P4B.5a),
                                 the lobby, seating, practice and /ws sockets (P4B.5b)
  src/lib/server/csp.ts          page Content-Security-Policy helper
  src/lib/protocol-v2.ts         protocol v2's types: the source; the Pydantic models follow it
  src/lib/art/, static/          generated by pnpm art; never edit by hand
  server/                        Node server: SvelteKit handler + /ws, /healthz, /api, legacy forwarding
  art/                           palette, sprites and font as text; cards/ holds the owner's PNG sprites
  drizzle/                       SQL migrations (never edit an applied one)
  scripts/                       art generator, parity and benchmark scripts, migrator, inline-code check
  e2e/                           Playwright tests against the Node table server (E2E_LEGACY=1: in front
                                 of serve-nl, the rollback); *.live.ts run against the live site; visual/ holds the
                                 screenshot comparison's scenes and its seeded test-only server
rivermind/engine/                reference no-limit engine, fuzz, bench, differential reference writer
rivermind/bots/                  simple bots, cards/ (card tables), blueprint/ (training, policy, bundles),
                                 match.py (evaluation), differential.py (bot parity reference)
rivermind/server/                Python table server serve-nl, protocol v2: the rollback (removed at P4B.8)
rivermind/db/                    SQLAlchemy models and Alembic migrations (removed at P4B.8)
poker_ai/                        short-deck prototype, terminal client, legacy serve (until P7.6)
test/                            engine/, server/, db/, unit/, functional/, fixtures/
deploy/                          systemd unit, Caddy site, setup-database.sh, update.sh; rollback/ and
                                 rollback-to-serve-nl.sh give the tables back to serve-nl (until P4B.8)
docs/                            rules, bots, design, roadmap, evaluations/, build-history
artifacts/                       ignored: tables/, blueprints/, bundles/, fuzz/, rm06/
```

## 7. Commands

### Python

From the repository root, with Python 3.12 and uv. These are the local equivalents of the `test` job in [the CI workflow](.github/workflows/test.yml).

```sh
uv sync --locked
uv run --locked rivermind-poker --help
uv run --locked pytest
```

The database tests need a disposable PostgreSQL database whose name contains `test`; each test recreates its schema. They are skipped locally without one, but fail in CI, and the full run before a commit must include them. [CONTRIBUTING.md](CONTRIBUTING.md#postgresql) covers setup.

```sh
RIVERMIND_TEST_DATABASE_URL=postgresql://localhost/rivermind_test uv run --locked pytest
```

For focused checks, use `uv run --locked pytest test/unit` or name the affected test file. To play the terminal prototype against two random bots (arrow keys and Enter to act, Q on your turn to leave):

```sh
uv run --locked rivermind-poker play --agent random
```

For offline play, set `TABLE_DIR` to the directory containing your card tables and `CHECKPOINT_FILE` to the matching strategy file.

```sh
uv run --locked rivermind-poker play --agent offline \
  --lut_path "$TABLE_DIR" --strategy_path "$CHECKPOINT_FILE"
```

### Engine

Engine tests live in `test/engine`. Rule tests are hands in `test/engine/fixtures.py`, with expected stacks worked out by hand from [the rules](docs/rules.md), never copied from engine output. After an engine change, also run the long fuzz and the benchmark and record their results.

```sh
uv run --locked python -m rivermind.engine.fuzz --hands 100000 --seats 2-9
uv run --locked python -m rivermind.engine.bench
```

From `web/`, after a change to either engine run `pnpm engine:parity` (CI runs it), and for an engine change also the long run and the benchmark. After changing `test/engine/fixtures.py`, rewrite `rules.json` from the root (pytest fails while it is stale).

```sh
pnpm engine:parity -- --hands 100000 --evaluator-hands 10000000 --all-five
pnpm engine:bench
uv run --locked python -m test.engine.export_fixtures
```

### Bots, card tables and training

After a change to either side of the bots, run `pnpm bots:parity` from `web/` (CI runs it on a synthetic bundle). For a change to the blueprint policy or the bundle format, also run the long parity run against a real bundle; the command is in [docs/bots.md](docs/bots.md#serving-p4b6), as is `pnpm bots:bench`.

| Task | Command | Notes |
| --- | --- | --- |
| Build the heads-up card tables (P5.2) | `uv run --locked rivermind-poker tables build` | Writes `artifacts/tables/hu-m1`; about 4 minutes and 3 GB |
| Check a table set | `uv run --locked rivermind-poker tables verify <dir>` | Checks every file against its manifest |
| Train the heads-up blueprint (P5.3) | `uv run --locked rivermind-poker blueprint train <run> --iterations N` | Add `--resume` to continue |
| Look up a hand’s bucket | `tables bucket <dir> <hole> [<board>]` | For example `artifacts/tables/hu-m1 AsKd Qh7c2s` |
| Read a checkpoint | `blueprint info <checkpoint or run>`, `blueprint strategy <checkpoint> <hole> [<board>]` | |
| Evaluate a checkpoint (P5.4) | `blueprint evaluate <checkpoint> --name <name> --out docs/evaluations` | See [an example report](docs/evaluations/hu-m1-s0-128m.md) for the full command |
| Check a report against the promotion gate (P5.5) | `blueprint gate <report.json>` | Exits 1 on failure; `--incumbent` for a replacement |
| Export a serving bundle (P4B.6) | `uv run --locked rivermind-poker blueprint export <checkpoint> --out <dir>` | Bundles go under `artifacts/bundles/` |
| Evaluate what the site serves (P5.5) | `blueprint evaluate <bundle> --name <name>-served` | A bundle plays its rounded strategy on its own card tables |
| Put a run to the gate and record it (P5.5) | `blueprint promote <report.json> --served <bundle report.json>` | Writes `docs/models.json` and `docs/models.md` whatever the outcome, and keeps a promoted run in `artifacts/models/<name>/`; exits 1 unless promoted |
| List the champions and check their kept files | `blueprint champions --verify artifacts/models` | Exits 1 on a missing or changed file |

### Web

From `web/`, with Node from `web/.node-version` and pnpm through corepack. CI runs the same steps in its `web` job. Run them before committing any web change.

```sh
pnpm install --frozen-lockfile
pnpm check && pnpm lint && pnpm test && pnpm build
pnpm e2e        # Chromium, Firefox and WebKit, desktop and phone, against the Node server and its own tables
pnpm e2e:live   # against https://rivermindpoker.com (or LIVE_URL)
```

`pnpm visual` and `pnpm visual:compare` capture fixed scenes and compare two commits pixel for pixel; run them for any change to styles or markup ([CONTRIBUTING.md](CONTRIBUTING.md#comparing-screenshots-p4b2)).

`pnpm format` is the quickest way to satisfy the Prettier half of `pnpm lint`. Pass `--project chromium` to `pnpm e2e` for a quick run, and `E2E_LEGACY=1` to run it in front of a real `serve-nl`, as the live site is until P4B.7 (CI runs Chromium that way too).

### Database, art and protocol

| Task | Command (from `web/`) |
| --- | --- |
| Generate a Drizzle migration from `schema.ts` | `pnpm db:generate` |
| Apply migrations (what production will run) | `pnpm db:migrate` |
| Render the pixel art | `pnpm art`, or `pnpm art --preview <dir outside the repo>` for contact sheets |
| Regenerate the short-deck `protocol.ts` | `pnpm protocol` |
| Re-record the HTTP contract from `serve-nl` (from the root) | `uv run --locked python -m test.server.export_http_contract` |
| Re-record the table session from `serve-nl` (from the root) | `uv run --locked python -m test.server.export_table_contract` |
| Rewrite the table parity fixture (from the root) | `uv run --locked python -m test.server.table_differential --fixture` |
| Check the TypeScript table against the Python one | `pnpm table:parity`, or `-- --sequences 400 --ops 300` for the long run |

## 8. Conventions and invariants

### One engine, two languages

- The Python engine is the reference. A rule change lands in both engines in the same commit, with a hand-worked fixture, and the differential fuzz must pass.
- The TypeScript engine in `web/src/lib/server/engine` must stay byte-identical to the Python one: `dumps` writes what Python’s `json.dumps(..., separators=(",", ":"), sort_keys=True)` writes.
- Keep the engine and bot files free of `$lib` imports and non-erasable TypeScript (enums, parameter properties), and import with relative `.ts` paths, so Node runs the parity and benchmark scripts directly.

### Bots in two languages

- The bots in `web/src/lib/server/bots` must play exactly as `rivermind/bots` does, seed for seed. Both draw from CPython’s `random.Random` (ported as `PythonRandom`), so keep every random draw in the same order in both languages, and land a bot change in both in the same commit.
- A bundle file is read into its own `ArrayBuffer`. `readFileSync` may return a pooled buffer whose offset breaks typed-array views.

### Training and artifacts

- **Card tables** are byte-for-byte reproducible for their seed whatever the worker count. Keep it that way: scikit-learn’s k-means gave slightly different centres between runs, so the build uses its own. After changing the pipeline, compare two builds’ manifests. Tests build a small set with the hidden `--limit` option.
- **Blueprint runs** are byte-for-byte a function of their settings, trees and card tables, whatever the worker count or where they were stopped and resumed. After changing the trainer, compare the `regrets.npy` and `strategy.npy` hashes of two runs with different worker counts.
- Every chunk of a batch starts from the same regrets, so the number of batches limits how far the strategy can move. On Kuhn poker ([the test helpers](test/engine/blueprint_helpers.py)), 25 batches of 64,000 iterations left an exploitability of 0.078, while 750 batches of 400 (300,000 iterations) reached 0.011. Tests train Kuhn poker in small batches; the CLI test uses the real card tables and is skipped without them.
- **Training workers are separate processes**, and macOS starts them with spawn, so pytest monkeypatches do not reach them. To test server scheduling with deterministic updates, use the thread workers in [the training test helpers](test/functional/training_helpers.py), and keep a real-worker CLI run for the end-to-end check.
- **Champions.** `docs/models.json` is the registry and `blueprint promote` is the only thing that writes it or the generated part of `docs/models.md`; pytest fails when the page, the registry or a recorded report disagree. Never edit a recorded report: the registry holds its SHA-256. A run prunes its old checkpoints (`--keep`), so a promoted checkpoint lives on in `artifacts/models/<name>/`, and reports name an incumbent by that path. Commit code before evaluating, so a report records a clean commit.
- **Artifacts** (card tables, checkpoints, bundles, local runs) go under the ignored `artifacts/` directory and never into Git. The small tracked [action-sequence fixture](test/fixtures/action_sequences.pkl) is the exception. Keep checkpoints paired with the tables that define their buckets.
- **Saved state.** When changing a saved format, check its writer and every consumer (resume, offline play, the table server’s restore). Exercise existing-format data and document any migration or regeneration it needs. Load only trusted pickle and joblib artifacts.

### Database

- Until P4B.8, the Drizzle schema (`web/src/lib/server/db/schema.ts`) and migrations (`web/drizzle/`) must build exactly Alembic head’s schema. `test/db/test_drizzle_baseline.py` compares them, so a schema change needs an Alembic revision and a Drizzle migration in the same commit.
- Keep each table’s columns in their database order (later Alembic revisions appended some), the Alembic constraint names, and tables unqualified: they live in `app` on ubuntu-vm through `search_path`. Delete the `"public".` that `drizzle-kit generate` writes into foreign keys. `drizzle-kit pull` drops single-column primary-key names and can reverse composite keys, so check its output against Alembic’s.
- Never edit an applied migration’s SQL. Drizzle records each migration’s hash and runs only entries newer than the last one recorded.
- Run the Vitest database tests with `RIVERMIND_TEST_DATABASE_URL` set, but not while pytest uses the same database.

### Table server

- Every request that changes a table goes through `TableRunner._change`, which applies, saves and publishes it in a task shielded from the caller, because Starlette’s test client, and a real server, can cancel a request’s task. Add new runner requests the same way, never as a bare `async with self.lock` around a change.
- A request can reach a runner after its table closed and paid out its seats. A runner request that brings chips to the table (sit, rebuy) refuses once the runner is closed, and its caller refunds the payment. Keep that rule in the TypeScript table server.
- Practice tables (P6.0b) never touch the wallet: `runner.practice` names the guest, and every place that pays chips out (`TableSaver`, `_cash_out`, `_seated_chips`) skips them.
- `create_app` applies the app’s rate limits (P4.5) by default. Tests that send requests faster than people could pass `limits=safety.UNLIMITED`; a `Server` built directly has no limits.
- A change to the table snapshot format (`rivermind/server/snapshot.py`) can make saved tables unrestorable. Call it out before deploying.

### The TypeScript table server

- `web/src/lib/server/table` and the table half of `web/src/lib/server/api` port `rivermind/server` and must behave as it does until P4B.8. After changing either side, run `pnpm table:parity`, re-record `table-contract.json` and `parity.json` (pytest fails while they are stale) and make both agree. Prettier must not touch either file.
- Every runner request goes through `TableRunner.change`, never a bare `lock.run` around a table call: the change is applied, saved and published as one unit, and the loop wakes only afterwards. Nothing cancels it part-way; a caller that went away only stops reading the answer.
- `sit` and `rebuy` refuse once the runner is closed, and their callers refund. Practice tables never touch the wallet (`runner.practice`).
- A bot's turn yields to the event loop first, even with no delay, so requests already due go ahead of it. Keep that: the recorded session depends on it, and so does a table of quick bots not starving sockets.
- Record sessions only at settled points. The recorder and the replay both wait until every socket is idle and every table waits on a person or the clock; a request sent while bots are still acting lands in a different batch of events in each server.
- JavaScript writes `20` where Python writes `20.0`. Clients do not care, and either server reads the other's snapshots, but compare recorded socket messages as parsed JSON or by canonical digest, never as text. HTTP bodies stay byte-identical because their only floats are times with a fraction.

### The TypeScript API

- `web/src/lib/server/api/contract.json` is `serve-nl`'s answers to a fixed script of requests, and Vitest expects the TypeScript API to give the same bytes. After changing either side's HTTP behaviour, re-record it (pytest fails while it is stale) and make both agree. Prettier must not touch it.
- `/api/*` is served by the Node server ahead of SvelteKit (`web/server/api.ts`), never by a `+server.ts` route: SvelteKit 3's CSRF check cannot be turned off and refuses bodiless unsafe requests from non-browser clients and loopback dev pages, which the API's own origin check allows. It is on only with `RIVERMIND_API=1` and no `RIVERMIND_LEGACY_API`; the live unit sets it.
- Read stored times as `extract(epoch …)::float8` (`epochOf` in `time.ts`). A JavaScript `Date` drops PostgreSQL's microseconds, so the wire value would no longer match Python's.

### Client, CSP and Caddy

- Keep the client free of inline script and style: the site CSP blocks them, and `pnpm build` fails on them. The one exception is SvelteKit’s start-up script, whose hash each page’s policy carries. Svelte transitions inject styles at run time, so animate with CSS classes.
- Caddy must never add a policy to a page or an asset from the Node server (it adds one to `/api/*`, `/ws` and its own error page). Node leaves the policy off a 304, and Chromium applies a 304’s headers to the cached page, so a Caddy policy there blanks the page on reload. The local Playwright suite does not go through Caddy, so check Caddy changes with `pnpm e2e:live`, against a local Caddy or the live site.
- `adapter-node` assumes https unless `ORIGIN` or `PROTOCOL_HEADER` is set, so set `ORIGIN` when running `pnpm start` locally. Unknown paths are 404s, not an SPA fallback; invites use `/?invite=`.
- `web/src/lib/protocol-v2.ts` is the no-limit protocol's source (P4B.5b). Change it and `rivermind/server/protocol.py` together until P4B.8; pytest fails while the Pydantic models describe anything else. After changing `poker_ai/web/protocol.py`, run `pnpm protocol` and commit the regenerated `web/src/lib/protocol.ts`.

### Styles

Pages and components are styled with Tailwind utilities on the theme `pnpm art` generates ([docs/design.md](docs/design.md#styling-tailwind-on-the-kits-own-theme) has the tokens, variants and what stays outside utilities). Check every change to styles or markup with `pnpm visual` against captures of the commit before it.

- One utility per property on an element. When two set the same property at the same variant, the stylesheet's order decides, not the markup's: a tag with `ml-3` and `ml-0` kept `ml-3`. Build class strings so that never happens.
- Layers decide before specificity: preflight, then `base` (app.css), then the kit (`pixel.css`, `components`), then utilities. A component's `<style>` block is unlayered and beats them all, so a property set there cannot be changed by a utility.
- Preflight removes margins, borders, list markers and link underlines. A page that needs one says so (`list-disc`, `my-10`). Checkboxes keep each browser's own margins (`margin: revert` in `base`): WebKit's differ from Chromium's.
- `grid-cols-5` and `auto-cols-fr` are `minmax(0, 1fr)`. Where the layout was drawn with plain `1fr`, write `grid-cols-[repeat(5,1fr)]`.
- Write a value out when it must match exactly: `bg-[rgb(12_13_21/0.72)]`, not `bg-ink/72` (the modifier rounds the alpha), and `[box-shadow:…]`, not `shadow-[…]` (which brings Tailwind's ring and shadow variables into the page).
- The translate utilities set the `translate` property, not `transform`. A keyframe that animates `transform` then moves on top of it, so write keyframes as offsets from the resting place.
- Tailwind reads every word of a scanned file as a possible class. Do not name a class after a utility (`grow`), and add an ordinary word that turns into one to the `@source not inline(...)` list in `app.css`.
- A variable named `state` in a component makes `$state(...)` a store read; Svelte only warns.

### Art

The site’s art is pixel art drawn as text: the palette, sprites and font are in `web/art/`, and `pnpm art` renders them, and the Tailwind theme (`theme.css`), into `web/src/lib/art/` and `web/static/`. [The design notes](docs/design.md) and the `/style` page describe the kit.

- Never edit a generated PNG, the font or `theme.css` by hand. Change the source, run `pnpm art --preview <dir outside the repo>`, look at the contact sheets, and commit both.
- Draw only with palette names, keep art at whole-number scales, and size text in multiples of 10px.
- The cards are the exception: the owner’s PNG sprites in `web/art/cards/` (`fronts/<rank>-<suit>.png`, `backs/<name>.png`) are the only card art, are not on the palette, and are shrunk by `pnpm art` to 71 × 95. Size cards with `--k`; they snap to whole device pixels per art pixel, so check them at DPR 1, 2 and 3.

### Legacy code

Keep the `poker_ai` Python namespace and the legacy `poker_ai` command. Existing scripts import it, and serialized objects can refer to its module paths.

## 9. Testing pitfalls

**Python socket tests.** Tests of the table server’s sockets (`test/server/test_protocol_v2.py`) run with a `ManualClock`, so nobody times out, and a `TestClient` receive has no timeout. Check the last message already received before waiting for a turn (the snapshot after joining is often one), and keep playing your own turns while waiting for a later hand, or the test hangs. Don’t move the manual clock while a bot’s thread may still be deciding; wait for the turn you expect instead.

**Waits in tests.** Bound a wait by time, never only by turns of the event loop. A server saving to PostgreSQL spends the wait idle, where a turn takes microseconds: 20,000 of them passed in CI before a few dozen saves had, and the same test passed on a busy Mac, where turns are slow. The helpers in `tables.testing.ts` wait for at least their turns and at least ten seconds.

**Vitest table-server tests.** `TestServer` (`web/src/lib/server/api/tables.testing.ts`) is the whole table server in one process, with seeded decks and a `ManualClock`. Nothing times out unless the test moves the clock. Call `await server.settle()` before reading a table's state after a request, and before moving the clock: it waits until the bots have stopped acting. A test that spawns `uv run … serve-nl` must start it in its own process group and kill the group, or the Python child lives on and answers on the port.

**Playwright.**

- The turn’s action panel opens above the table controls and pushes them down. Wait for the `Your action` group before clicking a button below it, or the click can land where the button was.
- The lobby lists every open table on the test server, each with its own “Sit down”, and has its own “Blinds” filter. Reach the new-table form through `newTableForm()` and a listed table through its `li[data-table]` row.
- After an action the panel stays up, disabled, until the table answers. Decide on an enabled button and click it by its exact label, as `playUntil` does: a click on a stale decision waits and lands on the next turn’s button. Give every check of a button’s state a timeout.
- RiverMind Easy folds to almost every raise, so a guest who shoves or folds rarely busts. The browser tests’ server runs `--practice_stack 300`, and a test that needs a bust checks or calls every turn: in a 40-seed simulation that busted every guest within 94 hands.
- Playwright empties its output directory when a run starts. A second run with the same configuration in `web/` deletes the first one's traces, and its tests then fail on `ENOENT`. `pnpm visual` has its own directory for that reason; do not start a second `pnpm e2e` beside a running one.
- The trace keeps DOM snapshots but not the screencast (`screenshots: false` in `playwright.config.ts`). The screencast made every WebKit action slow enough to time tests out in CI; don’t turn it back on.

**The browser pane.** When the pane is hidden, the page runs in the background and CSS animations stay on their first frame, so an element with an entrance animation (a reaction bubble, a win label) looks invisible. Finish them with `document.getAnimations()` before judging a screenshot.

## 10. The live server

The site runs on the owner’s ubuntu-vm. [CONTRIBUTING.md](CONTRIBUTING.md#deploy-rivermindpokercom) has the full description; the facts later steps rely on are in Phase 0 of BUILD.md.

- **Deploy** (an owner gate): after the approved push, run `ssh root@ubuntu-vm 'bash /home/sawyer/github/rivermind-poker/deploy/update.sh'`. It fast-forwards the checkout and runs the Python suite and the web suite (check, lint, Vitest and `pnpm table:parity`) against the test database, then builds, and stops before the live site changes if anything fails. It then runs the Drizzle migrations, publishes a release under `/srv/rivermindpoker.com/`, switches `current` atomically and restarts the Node server, which restores the open tables before it listens. Three releases are kept for rollback.
- **Check it live** with `pnpm e2e:live` from `web/`. With `LIVE_RESTART_COMMAND="ssh root@ubuntu-vm systemctl restart rivermind-poker-web"` it also restarts the server mid-hand. Record the revision, the release and the results in BUILD.md.
- **Services:** `rivermind-poker-web` (Node, 127.0.0.1:4320) behind [the Caddy site](deploy/rivermindpoker.com.caddy). `rivermind-poker` (`serve-nl`, 127.0.0.1:4316) is installed but stopped and disabled; `deploy/rollback-to-serve-nl.sh` gives it the tables back. Never run both with the tables: each would restore and deal them. The web unit's `Conflicts=` makes systemd stop one when the other starts.
- **Database:** `rivermind_poker` with its tables in the `app` schema, set up by [`deploy/setup-database.sh`](deploy/setup-database.sh), which is safe to rerun. Credentials for the web, migration and test roles are in root-only `/etc/rivermind-poker/{web,migration,test}.env`.
- **Session secret:** `/var/lib/rivermind-poker/secret`, root-only; the web unit reads it as a systemd credential. Replacing it signs every guest out for good.
- On the host, run git as `sawyer`. When copying files from this Mac, set `COPYFILE_DISABLE=1` so macOS does not add `._*` files. Never edit another site’s files.

## 11. Security baseline

- Every client message is untrusted. The server validates type, size, rate and authority, refuses stale or duplicate actions by `seq`, and rejects unsafe requests and socket handshakes from other origins.
- A seat view never includes another seat’s private cards, and stored hands are shown only to the players dealt into them.
- Session cookies are signed with HMAC-SHA256, `HttpOnly`, `SameSite=Lax` and `Secure` outside loopback. Keep their format so guests stay signed in across the cutover.
- Rate limits exist in the app and in Caddy; keep both.
- The CSP stays as strict as it is now: no inline script or style, no third-party origins. The one approved addition is `'wasm-unsafe-eval'` in `script-src`, for voice noise suppression (D-15, Q-11), once P4C.6 ships it.
- Secrets never go in the repository. They live in root-only env files on the host.
- Load only trusted pickle and joblib files.

## 12. Repository boundaries

- Keep RiverMind’s independent Git history rooted at its source snapshot (`0cca63f`).
- Preserve GPL-3.0-or-later, the [license](LICENSE), the [original human credits](README.md#origins-and-license) and every third-party notice, including the [Deuces evaluator notice](licenses/Deuces.txt). Preserve existing human authorship credits.
- The card sprites’ source and license terms are open question Q-8, due at P7.7. Don’t add other third-party art, fonts or code without recording its license in `licenses/`.
- Keep generated tables, checkpoints, bundles and training runs under `artifacts/`, out of Git.

## 13. Documentation

| File | What belongs there |
| --- | --- |
| [BUILD.md](BUILD.md) | The plan, step status, evidence, decisions, open questions and the handoff log |
| [docs/build-history.md](docs/build-history.md) | Archived evidence and older handoffs, preserved as written |
| [docs/roadmap.md](docs/roadmap.md) | Where 1.0 is going and why; changes only when the plan does |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to develop, run and deploy each part; each Phase 4B step updates it as it lands |
| [docs/rules.md](docs/rules.md) | The no-limit rules, with worked examples |
| [docs/bots.md](docs/bots.md) | Bot design, card tables, training, evaluation and serving |
| [docs/evaluations/](docs/evaluations/) | One report per evaluated checkpoint or bundle, with everything needed to reproduce it |
| [docs/models.md](docs/models.md) | The champions and every run put to the promotion gate, generated from `docs/models.json` |
| [docs/design.md](docs/design.md) | The pixel-art kit and its rules |
| [docs/voice.md](docs/voice.md) | Table voice: threat model, encryption, media server, audio settings and host needs |
| This file | Durable conventions, verified commands and recurring pitfalls |

Write plainly, in short sentences. At the end of a session, you may edit this file when you find a durable convention, a verified command or a recurring pitfall that will help later sessions. Put session results, temporary workarounds and plan changes in BUILD.md instead.

## 14. Toolchain

Ranges are in `pyproject.toml` and `web/package.json`; the exact versions are in `uv.lock` and `web/pnpm-lock.yaml`.

| Tool | Version | Where it is set |
| --- | --- | --- |
| Python | 3.12 | `.python-version`, through uv |
| Node | 26 | `web/.node-version` and `engines` (mise reads it on this Mac and the server) |
| pnpm | 12.18.0 | `packageManager`, through corepack |
| SvelteKit, Svelte | 3, 5.57 | with `@sveltejs/adapter-node` 6 |
| Tailwind CSS | 4.3 | through `@tailwindcss/vite` |
| TypeScript, Vite, Vitest | 6.0, 8.3, 5.1 | |
| Playwright | 1.65 | Chromium, Firefox and WebKit |
| Drizzle ORM, drizzle-kit, pg | 0.45, 0.31, 8.23 | |
| PostgreSQL | 18 | ubuntu-vm, and the `postgres:18` service in CI |

These tools change quickly. Look up current documentation rather than relying on memory ([section 15](#15-context7-documentation-lookup)).

## 15. Context7 documentation lookup

Use Context7 MCP whenever the user asks about a library, framework, SDK, API, CLI tool or cloud service, including familiar tools. This covers syntax, configuration, setup, CLI usage, version migrations, porting between libraries, platforms or SQL dialects, and library-specific debugging. Prefer Context7 to web search for library docs. Skip it for general programming concepts and for refactoring, debugging or review that is independent of a library or platform API.

1. Start with `resolve-library-id` using the library name and what you need to look up, unless the user supplied an exact `/org/project` ID.
2. Choose by exact name, description relevance, snippet count, source reputation (prefer High or Medium) and benchmark score. Retry with an alternate name or query if the results are poor. Use a version-specific ID when the user names a version.
3. Call `query-docs` with the selected ID and a specific question. Query distinct concepts separately unless the question concerns their interaction.
4. Answer using the fetched documentation.
