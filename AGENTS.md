# Working on RiverMind Poker

## Start and finish a session

[BUILD.md](BUILD.md) is the phased plan to 1.0 and the record of where work stands. Its **How to work this file** section is the session procedure; the essentials are below.

1. Read **Now** in BUILD.md, then run `git status --short --branch` and `git log -5 --oneline --decorate`. Preserve unrelated work in the tree.
2. The owner’s current request comes first. Otherwise take **Next step**, or the first unchecked step in the current phase whose dependencies are checked. Claim it under **In progress** before you start.
3. Verify every **Done when** criterion through the real entry point (CLI, browser, server or live site) as well as with tests. For engine changes, exercise a reproducible hand or action sequence. For training changes, record the rules, seat count, settings and artifacts used. Run the full suites before committing.
4. Tick verified criteria, add an `Evidence:` line, then update **Now**. For partial work, add a `Remaining:` line instead of ticking the step. Build on the settled decisions (`D-n`). Use the open questions’ defaults (`Q-n`) rather than waiting, and stop only at **Owner gate** steps.
5. Prepend a dated entry to the handoff log (keep eight; archive older ones in [docs/build-history.md](docs/build-history.md)). Review the final working tree and diff, including new files.

## Stack

The project is moving to SvelteKit 3 · Svelte 5 · TypeScript · Tailwind CSS 4 · PostgreSQL 18 + Drizzle ORM · Node (`adapter-node`) · Caddy (D-14 in BUILD.md). Phase 4B does the move. Until its cutover (P4B.7), the live backend is still the Python `serve-nl` on FastAPI with SQLAlchemy and Alembic, and the commands below describe that.

- Write new site, API, table, engine-serving and database code in TypeScript in `web/`, with server-only code under `web/src/lib/server/`. Change `rivermind/server` and `rivermind/db` only to fix the live site; both are removed at P4B.8.
- Python stays for offline work: `rivermind/engine` is the reference engine, and `rivermind/bots` builds card tables, trains, evaluates and exports serving bundles. A rule change lands in both engines in the same commit, and the differential fuzz must pass.
- Keep protocol v2, session cookies, table snapshots and hand histories wire-compatible across the move, so open tables, stored hands and guests survive the cutover.

## Local development and play

From the repository root, use Python 3.12 and uv. These are the local equivalents of the [test workflow](.github/workflows/test.yml).

```sh
uv sync --locked
uv run --locked rivermind-poker --help
uv run --locked pytest
```

The database tests need a disposable PostgreSQL database whose name contains `test`. They are skipped locally without one, but the pre-commit full run must include them. The [development guide](CONTRIBUTING.md#postgresql) covers setup.

```sh
RIVERMIND_TEST_DATABASE_URL=postgresql://localhost/rivermind_test uv run --locked pytest
```

For focused checks, use `uv run --locked pytest test/unit` or name the affected functional test. The following command starts a table with two random bots.

```sh
uv run --locked rivermind-poker play --agent random
```

Use the arrow keys and Enter to act, or Q on your turn to leave. For offline play, set `TABLE_DIR` to the directory containing your card tables and `CHECKPOINT_FILE` to the matching strategy file.

```sh
uv run --locked rivermind-poker play --agent offline \
  --lut_path "$TABLE_DIR" --strategy_path "$CHECKPOINT_FILE"
```

The no-limit engine (`rivermind/engine`) and its bots (`rivermind/bots`) have their tests in `test/engine`. Engine rule tests are hands in `test/engine/fixtures.py`, with expected stacks worked out by hand rather than copied from engine output. After an engine change, also run the long fuzz and the benchmark and record their results.

```sh
uv run --locked python -m rivermind.engine.fuzz --hands 100000 --seats 2-9
uv run --locked python -m rivermind.engine.bench
```

The trained bots' card tables (P5.2, `rivermind/bots/cards`) are built with `uv run --locked rivermind-poker tables build` into `artifacts/tables/hu-m1`, which takes about 4 minutes and 3 GB, and checked with `rivermind-poker tables verify <dir>`. A build is byte-for-byte reproducible for its seed whatever the worker count. Keep it that way: scikit-learn's k-means gave slightly different centres between runs, so the build uses its own. After changing the pipeline, compare two builds' manifests. Tests build a small set with the hidden `--limit` option.

The heads-up blueprint (P5.3, `rivermind/bots/blueprint`) trains with `uv run --locked rivermind-poker blueprint train <run> --iterations N` and continues with `--resume`. Ctrl-C or SIGTERM stops at the end of a batch and writes a checkpoint. `blueprint info` and `blueprint strategy` read a checkpoint. A run is byte-for-byte a function of its settings, trees and card tables, whatever the worker count or the points where it was stopped and resumed. Keep it that way, and after changing the trainer, compare the `regrets.npy` and `strategy.npy` hashes of two runs with different worker counts. Every chunk of a batch starts from the same regrets, so the number of batches limits how far the strategy can move: on Kuhn poker ([the test helpers](test/engine/blueprint_helpers.py)), 25 batches of 64,000 iterations left an exploitability of 0.078, while 750 batches of 400 (300,000 iterations) reached 0.011. Tests train Kuhn poker in small batches; the CLI test uses the real card tables and is skipped without them.

The SvelteKit client in `web/` has its own suite (Node from `web/.node-version`, pnpm through corepack). Run it from `web/` before committing web changes; CI runs the same steps in its `web` job.

```sh
pnpm install --frozen-lockfile
pnpm check && pnpm lint && pnpm test && pnpm build
pnpm e2e    # Chromium, Firefox and WebKit against the Node server in front of a real `serve-nl`
```

The site’s art is pixel art drawn as text: the palette, sprites and font are in `web/art/`, and `pnpm art` (from `web/`) renders them into `web/src/lib/art/` and `web/static/`. Never edit a generated PNG, the font or `palette.css` by hand; change the source, run `pnpm art --preview <dir outside the repo>`, look at the contact sheets, and commit both. Draw only with palette names, keep art at whole-number scales, and size text in multiples of 10px. The cards are the exception: the owner’s PNG sprites in `web/art/cards/` (`fronts/<rank>-<suit>.png`, `backs/<name>.png`) are the only card art, are not on the palette, and are shrunk by `pnpm art` to 71 × 95. Size cards with `--k`; they snap to whole device pixels per art pixel, so check them at DPR 1, 2 and 3. [The design notes](docs/design.md) and the `/style` page describe the kit.

After changing `poker_ai/web/protocol.py` or `rivermind/server/protocol.py`, run `pnpm protocol` and commit the regenerated `web/src/lib/protocol.ts` and `protocol-v2.ts`. Keep the client free of inline script and style: the site CSP blocks them, and `pnpm build` fails on them. The one exception is SvelteKit's start-up script, whose hash each page's policy carries.

Socket tests of the table server (`test/server/test_protocol_v2.py`) run with a `ManualClock`, so nobody times out, and a `TestClient` receive has no timeout. Check the last message already received before waiting for a turn (the snapshot after joining is often one), and keep playing your own turns while waiting for a later hand, or the test hangs.

In the browser tests, the turn’s action panel opens above the table controls and pushes them down. Wait for the `Your action` group before clicking a button below it, or the click can land where the button was. The lobby lists every open table on the test server, each with its own “Sit down”, and has its own “Blinds” filter, so reach the new-table form through `newTableForm()` and a listed table through its `li[data-table]` row. After an action the panel stays up, disabled, until the table answers, so decide on an enabled button and click it by its exact label (as `playUntil` does): a click on a stale decision waits and lands on the next turn’s button.

Practice tables (P6.0b) never touch the wallet: `runner.practice` names the guest, and every place that pays chips out (`TableSaver`, `_cash_out`, `_seated_chips`) skips them. RiverMind Easy folds to almost every raise, so a guest who shoves or folds rarely busts. The browser tests' server runs `--practice_stack 300`, and a test that needs a bust checks or calls every turn: in a 40-seed simulation that busted every guest within 94 hands.

`create_app` applies the app's rate limits (P4.5) by default. Tests that send requests faster than people could pass `limits=safety.UNLIMITED`; a `Server` built directly has no limits.

When the browser pane is hidden, the page runs in the background and CSS animations stay on their first frame, so an element with an entrance animation (a reaction bubble, a win label) looks invisible. Finish them with `document.getAnimations()` before judging a screenshot.

Starlette's test client cancels the server's socket handler the moment a test's socket closes, and a real server can cancel a request's task too. Every request that changes a table goes through `TableRunner._change`, which applies, saves and publishes it in a task shielded from the caller; add new runner requests the same way, never as a bare `async with self.lock` around a change.

Other sessions may work in this checkout at the same time and leave staged or half-finished changes. Commit only your own files (`git commit -- <paths>`, or a temporary index when a file mixes your hunks with theirs), and if their edits break the build, verify in a scratch copy of `main` plus your changes.

Training workers are separate processes, and macOS starts them with spawn, so pytest monkeypatches do not reach them. To test server scheduling with deterministic updates, use the thread workers in [the training test helpers](test/functional/training_helpers.py). Keep a real-worker CLI run for the end-to-end check.

Keep the `poker_ai` Python namespace and legacy CLI alias. Existing scripts import it, and serialized objects can refer to its module paths. Load only trusted pickle/joblib artifacts. When changing saved state, check the writer and its consumers (resume and offline play as applicable). Exercise existing-format data and document any required migration or regeneration. Keep checkpoints paired with the tables that define their buckets.

## Repository boundaries

- Keep RiverMind’s independent Git history rooted at its source snapshot. Preserve GPL-3.0-or-later, the [license](LICENSE), the [original human credits](README.md#origins-and-license) and all third-party notices, including the [Deuces evaluator notice](licenses/Deuces.txt).
- Store generated lookup tables, checkpoints and local training runs under the ignored `artifacts/` directory. Keep them out of Git. The small tracked [action-sequence fixture](test/fixtures/action_sequences.pkl) is used by the tests.
- Obtain the owner’s authorization for each separate action of publishing, pushing to a remote or deploying to the live domain.
- Server setup does not need that authorization (D-10). You may SSH into ubuntu-vm as root and install packages or set up databases, roles, services and configuration. Keep the host’s other sites working, follow its conventions (see `deploy/setup-database.sh`) and record the changes in BUILD.md. Run git there as `sawyer`. When copying files from this Mac, set `COPYFILE_DISABLE=1` so macOS does not add `._*` files.
- Never include any AI or Claude attribution in commit messages. This includes AI co-author trailers, “Generated by” lines, and tool signatures. Preserve existing human authorship credits and license notices.

<!-- context7 -->
## Context7 documentation lookup

Use Context7 MCP whenever the user asks about a library, framework, SDK, API, CLI tool or cloud service, including familiar tools. This covers syntax, configuration, setup, CLI usage, version migrations, porting between libraries, platforms or SQL dialects, and library-specific debugging. Prefer Context7 to web search for library docs. Skip it for general programming concepts and for refactoring, debugging or review that is independent of a library or platform API.

1. Start with `resolve-library-id` using the library name and what you need to look up, unless the user supplied an exact `/org/project` ID.
2. Choose by exact name, description relevance, snippet count, source reputation (prefer High or Medium) and benchmark score. Retry with an alternate name or query if the results are poor. Use a version-specific ID when the user names a version.
3. Call `query-docs` with the selected ID and a specific question. Query distinct concepts separately unless the question concerns their interaction.
4. Answer using the fetched documentation.
<!-- context7 -->

At session end, agents may edit AGENTS.md when they discover a durable convention, verified command or recurring pitfall that will help future contributors. Put session results, temporary workarounds and plan changes in BUILD.md. The [development guide](CONTRIBUTING.md) has local commands, and the [roadmap](docs/roadmap.md) explains the architecture and why the phases are ordered as they are.
