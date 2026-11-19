# RiverMind Poker work tracker

**Today.** One human can play two bots in the terminal with a 20-card deck (tens through aces) and fixed-size raises. Random play works from a fresh checkout. Offline play loads a local strategy checkpoint and its matching card tables. Training can produce a checkpoint in a smoke run. Bot strength is unmeasured. The free, self-hosted browser table at `rivermindpoker.com` is the goal.

**Pick up RM-02 next.** RM-01’s fixed-card checks pass for all three river outcomes. The next task is to reproduce single-process resume from a saved `server.gz` and verify that the [resume command](poker_ai/ai/runner.py) continues the original run through a second dump.

## Active work

_None._

## Blockers

_None._

## Ordered backlog

Keep the ID with the task as it moves between backlog, active work and completed work. Dependencies below identify work that needs a particular result. The [roadmap](docs/roadmap.md) gives the milestone rationale and the [development guide](CONTRIBUTING.md) covers experiments and commands.

| ID | Outcome | Acceptance check |
| --- | --- | --- |
| RM-02 | Resume an interrupted single-process run. The [resume command](poker_ai/ai/runner.py) currently sends its saved CLI settings to the multiprocessing server. | Interrupt after a dump, invoke `train resume` on its `server.gz`, and reach a second dump. Test that the trainer keeps its mode, table settings, regrets and accumulated strategy, continues at the saved next iteration and records the new timestep. Exercise an existing-format checkpoint. |
| RM-03 | Apply regret and strategy discounting at the intended iterations. Both the [single-process loop](poker_ai/ai/singleprocess/train.py) and [worker scheduler](poker_ai/ai/multiprocess/server.py) mix a bitwise operator with comparisons in the discount condition. | In both modes test iterations between intervals, at an eligible interval, and at the threshold. Verify the expected factor reaches the stored values exactly once per eligible interval. |
| RM-04 | Take consistent asynchronous checkpoints while workers update the agent. | Exercise overlapping updates and repeated dumps. Reload each published checkpoint and its resume state, verify they describe the same completed iteration, and continue training. An interrupted write must leave a usable checkpoint. See the [writer](poker_ai/ai/ai.py). |
| RM-05 | Share random and checkpoint bot decisions between clients. | Both policies choose from legal actions using only the acting seat’s information. Test the checkpoint’s fallback for unseen hands. Complete a terminal hand with each policy and call each policy from a test without terminal I/O. |
| RM-06 | Establish a reproducible bot baseline using RM-05 and a matched checkpoint/table pair from the corrected training path. RM-04 matters if using asynchronous training. | Run fixed-seed three-seat matches against two uniform-random bots, rotating the checkpoint through each seat. Record rules, seeds, hand count, training settings, artifact identifiers, net chips per hand and sampling uncertainty. A second run with those inputs reproduces the result. |
| RM-07 | Build a server-owned play-chip table on the existing engine and RM-05 policies. The server owns the deck, turns, validation and payouts. | Tests reject duplicate and out-of-turn actions without advancing play. Inspect two seats’ responses mid-hand and after reconnect. Each gets its own hole cards, public board, stacks, pot and permitted actions. Test showdown disclosure and payouts. |
| RM-08 | Build a browser client against RM-07. | On desktop and mobile, one human completes consecutive hands against two bots, can select legal actions, and sees bot actions and payouts. Exercise both random and checkpoint opponents. |
| RM-09 | Package RM-08 for self-hosting with a pinned checkpoint and matching tables. Run training separately from the serving process. | From a clean install, play a hand and restart the service, then play again. With the owner’s deployment authorization, verify a fresh browser completes a hand over HTTPS at `rivermindpoker.com`. |

## Open questions

- Which server framework, browser framework and transport should implement the table API? Decide when designing RM-07 against the turn, privacy and reconnect requirements.

## Completed work

- **RM-01 · Hand-strength labels.** The lower evaluator rank wins. [Fixed-card river tests](test/functional/test_clustering.py) verify indices 0, 1 and 2 and their respective win, loss and tie vectors. The [development guide](CONTRIBUTING.md#tables-and-checkpoints-across-the-hand-strength-fix) covers legacy pairs, clean regeneration and retraining. All 5 clustering tests and all 58 suite tests passed.
- **Independent baseline.** RiverMind’s root commit `0cca63f` preserves the copied research source. `git ls-tree --name-only 0cca63f` shows the original layout. Commit `056e542` established the active project. Source provenance and human credits are in the [README](README.md), with the [GPL license](LICENSE) and [Deuces MIT notice](licenses/Deuces.txt).
- **Package and CLI.** The Python 3.12 development environment has a [uv lockfile](uv.lock). Both `rivermind-poker` and the legacy `poker_ai` entry point expose `play`, `cluster` and `train`. See the [package metadata](pyproject.toml) and [CLI registration](poker_ai/cli/runner.py).
- **Terminal play.** Random opponents sample legal actions without loading tables. Offline opponents sample checkpoint weights by information set and fall back to a uniform legal action for unseen states. The client supports seat rotation between hands and records results locally. See the [terminal loop](poker_ai/terminal/runner.py) and [results writer](poker_ai/terminal/results.py).
- **Training repairs.** In `056e542`, CFR’s debug loop stopped overwriting the seat being trained, multiprocessing managers moved out of module import, and the default worker count gained a floor of one. See the [CFR traversal](poker_ai/ai/ai.py), [agent](poker_ai/ai/agent.py) and [server](poker_ai/ai/multiprocess/server.py).
- **Local verification and CI configuration.** The [functional suite](test/functional/) covers action order, payouts, evaluation and card combinations. The [training smoke test](test/functional/test_cli.py) reads a one-iteration checkpoint and next timestep in single-process, synchronous-worker and asynchronous-worker modes with one synthetic bucket per street. Only the first two modes assert a nonempty strategy. The [GitHub Actions workflow](.github/workflows/test.yml) configures locked setup, CLI help and pytest on Ubuntu for pushes and pull requests. Hosted run status is unverified.
- **RM-00 · Agent handoff.** Added this tracker and the [repository instructions](AGENTS.md).

## Session handoffs

Prepend one entry per session that changes project state. Include date, task IDs, outcome, checks actually run and the next concrete action. For partial work, name the remaining acceptance check and why it is still open. Keep current priorities and blockers above.

**2026-11-18 · RM-01.** Before the fix, `uv run --locked pytest -q test/functional/test_clustering.py -k river_hand_strength` showed two failures and one pass. Four aces against four kings counted as a loss, the reversed deal counted as a win, and a royal flush on the board tied. Reversed the two rank comparisons in `GameUtility.get_winner()`. Afterward, `uv run --locked pytest test/functional/test_clustering.py` passed all 5 tests and `uv run --locked pytest` passed all 58. Traced bucket IDs from table generation to checkpoint lookup. The fixed-card check used one river simulation per deal. No full tables were generated or historical pairs compared. Next action for RM-02 is to capture a single-process dump and reproduce resume through the CLI.

**2026-11-18 · RM-00.** Established the tracker on `main` at baseline `056e542`. Ran `uv sync --locked`, help for both CLI names and for `play`, and `uv run --locked pytest` (55 passed). A scripted terminal check completed and recorded one three-seat hand in each mode using simulated input and temporary results. The offline check used synthetic tables and an empty strategy to exercise fallback. Checked document paths, workflow agreement and the documentation-only diff. Next action for RM-01 is to add fixed hero-win, hero-loss and tie cases alongside the [clustering tests](test/functional/test_clustering.py).
