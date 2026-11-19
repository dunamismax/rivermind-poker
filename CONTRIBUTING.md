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

To start a full experiment, use a local artifact directory. Clustering the default 20-card deck enumerates millions of hands and board combinations in memory and can take substantial time and RAM. For a quick playable baseline, use the random opponents in the README.

```sh
mkdir -p artifacts/tables
cd artifacts
uv run rivermind-poker cluster --save_dir tables
uv run rivermind-poker train start --single_process --lut_path tables --nickname baseline
```

Clustering writes `tables/card_info_lut.joblib` and `tables/centroids.joblib`. Training creates a timestamped `baseline_*` directory. Once it passes the update threshold and reaches a dump iteration, it writes `agent.joblib`. Pass that file and the same tables to `play --agent offline`. Use `cluster --help` and `train start --help` for experiment settings. The game engine deals ranks ten through ace, so tables generated with a smaller rank range cover only a subset of its hands.

### Tables and checkpoints across the hand-strength fix

River clustering fits K-means to simulated `[win, loss, tie]` rates. Before RM-01, the first two rates were reversed. Turn and flop clustering use distributions over the following street’s clusters. For each postflop street, the builder saves the fitted cluster ID for each card combination. Preflop IDs come from a separate fixed mapping of ranks and suitedness. [Table builder](poker_ai/clustering/card_info_lut_builder.py) · [Preflop mapping](poker_ai/clustering/preflop.py)

Keep an existing checkpoint with the exact lookup table used to train it. Training and offline play look up the acting player’s bucket and combine it with the betting history to form the key for checkpoint regrets and strategy. They read the stored IDs directly, so using that pair requires no conversion. This follows from the lookup and checkpoint code. The fixed-card tests verify the corrected rates. To reuse a checkpoint with a regenerated table, first verify that the original and regenerated tables assign the same IDs to the same card combinations on every street. Equal cluster counts alone cannot establish compatibility. [Information-set key](poker_ai/games/short_deck/state.py) · [Checkpoint writer](poker_ai/ai/ai.py) · [Offline strategy lookup](poker_ai/terminal/runner.py)

For a bot trained on corrected labels, run clustering in a new, empty directory under `artifacts/`. The builder loads existing lookup tables and centroids and skips streets already present, so reusing a legacy directory can preserve old results or mix generations. Start a fresh training run against the regenerated tables and keep the resulting checkpoint with them.

For bot changes, record the rules, seat count, training settings, checkpoint and evaluation opponent along with results. For engine changes, add a reproducible hand or action sequence that exercises the rule. Run the full suite before proposing a change to `main`.

## Project history

RiverMind's first commit preserves the copied source, including the original research scripts and visualization experiments. The next commit establishes the active project layout. Historical experiments can be inspected without installing their dependencies. Run `git ls-tree --name-only 0cca63f` to browse the snapshot.
