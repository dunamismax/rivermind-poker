# Working on RiverMind Poker

## Start and finish a session

[BUILD.md](BUILD.md) is the phased plan to 1.0 and the record of where work stands. Its **How to work this file** section is the session procedure; the essentials are below.

1. Read **Now** in BUILD.md, then run `git status --short --branch` and `git log -5 --oneline --decorate`. Preserve unrelated work in the tree.
2. The owner’s current request comes first. Otherwise take **Next step**, or the first unchecked step in the current phase whose dependencies are checked. Claim it under **In progress** before you start.
3. Verify every **Done when** criterion through the real entry point (CLI, browser, server or live site) as well as with tests. For engine changes, exercise a reproducible hand or action sequence. For training changes, record the rules, seat count, settings and artifacts used. Run the full suites before committing.
4. Tick verified criteria, add an `Evidence:` line, then update **Now**. For partial work, add a `Remaining:` line instead of ticking the step. Build on the settled decisions (`D-n`). Use the open questions’ defaults (`Q-n`) rather than waiting, and stop only at **Owner gate** steps.
5. Prepend a dated entry to the handoff log (keep eight; archive older ones in [docs/build-history.md](docs/build-history.md)). Review the final working tree and diff, including new files.

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

The SvelteKit client in `web/` has its own suite (Node from `web/.node-version`, pnpm through corepack). Run it from `web/` before committing web changes; CI runs the same steps in its `web` job.

```sh
pnpm install --frozen-lockfile
pnpm check && pnpm lint && pnpm test && pnpm build
pnpm e2e    # Chromium, Firefox and WebKit against a real `serve-nl`
```

The site’s art is pixel art drawn as text: the palette, sprites and font are in `web/art/`, and `pnpm art` (from `web/`) renders them into `web/src/lib/art/` and `web/static/`. Never edit a generated PNG, the font or `palette.css` by hand; change the source, run `pnpm art --preview <dir outside the repo>`, look at the contact sheets, and commit both. Draw only with palette names, keep art at whole-number scales, and size text in multiples of 10px. [The design notes](docs/design.md) and the `/style` page describe the kit.

After changing `poker_ai/web/protocol.py` or `rivermind/server/protocol.py`, run `pnpm protocol` and commit the regenerated `web/src/lib/protocol.ts` and `protocol-v2.ts`. Keep the client free of inline script and style: the site CSP blocks them and `pnpm build` fails on them.

Socket tests of the table server (`test/server/test_protocol_v2.py`) run with a `ManualClock`, so nobody times out, and a `TestClient` receive has no timeout. Check the last message already received before waiting for a turn (the snapshot after joining is often one), and keep playing your own turns while waiting for a later hand, or the test hangs.

In the browser tests, the turn’s action panel opens above the table controls and pushes them down. Wait for the `Your action` group before clicking a button below it, or the click can land where the button was.

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
