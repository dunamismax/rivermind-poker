# RiverMind bot design

This is the design for RiverMind’s trained no-limit bots (P5.1). It fixes the game the first champion plays, its action and card abstractions, how real bets map onto them, the info-set key, and memory and time estimates for training it on this Mac (Q-5). Later steps build it: card tables at P5.2, training at P5.3, evaluation at P5.4, promotion at P5.5 and serving at P5.7a. They change this page when a measurement shows a choice was wrong, and say so in the handoff log. The six-seat format, `6max-s1`, is [below](#6-max-and-9-max) (P5.6).

The engine in `rivermind/engine` is the only source of rules. Every abstract betting tree is built by playing actions through `start_hand`, `legal_actions` and `apply`, so minimum raises, incomplete all-ins and [rule 7.8](rules.md#7-legal-actions-and-amounts) come out exactly as at a live table.

## The first format: `hu-m1`

The first champion plays **heads-up no-limit hold’em without an ante**. Its abstraction is named `hu-m1` (heads-up, medium action abstraction, version 1). Its sizes are fractions of the pot or multiples of the bet faced, so it plays any stakes; stacks are measured in big blinds.

**Stack depth.** Site buy-ins run from 40 to 100 big blinds (`TableConfig`), and practice tables give 100. The tree is built for two **depth classes**, 50 and 100 big blinds, and trained on both (each iteration picks one at random, weighted by the number of info sets in each). At the start of each hand the bot takes the effective stack, the smaller of the two stacks, and uses the 50 class below 71 big blinds (about the geometric midpoint) and the 100 class from 71 up. Deeper stacks play the 100 tree: its all-in is then a larger overbet than it was in training. P5.4 reports results at 40, 100 and 150 big blinds, so this cost is measured, not assumed. A 200 class (or a 25 class) can be added later as a new abstraction version.

Heads-up, the button posts the small blind and acts first before the flop and last after it ([rule 4.2](rules.md#4-heads-up)), so the actor at every node follows from the history alone.

## Action abstraction

At each decision the bot chooses among: fold (only when facing a bet), check or call, a few bet or raise sizes, and all-in (whenever a raise is legal). The sizes depend on the street and on how many bets and raises the street has already seen (its **level**: 0 for the first bet, or the first raise before the flop, where the blinds do not count).

| Street | Level 0 | Level 1 | Level 2 | Level 3 and up |
| --- | --- | --- | --- | --- |
| Pre-flop (multiples of the bet faced) | 2.5×, 4× | 3×, 4.5× | 2.25× | all-in only |
| Flop (fractions of the called pot) | ⅓, ¾, 1¼ | ¾ | ¾ | all-in only |
| Turn | ½, 1, 1½ | 1 | all-in only | all-in only |
| River | ½, 1, 1½ | 1 | all-in only | all-in only |

- **Pre-flop sizes** are “raise to” totals as a multiple of the current bet. An open from the small blind to 2.5× is 250 at 50/100; a 3× three-bet of that is to 750.
- **Post-flop sizes** are fractions of the **called pot**, the pot after the actor calls: a bet or raise of fraction *f* is to `current bet + f × (pot + amount owed)`. A pot-sized bet into 1,000 is 1,000; a pot-sized raise of a 300 bet into 1,000 is to 300 + 1 × 1,600 = 1,900.
- **Legality.** A size below the legal minimum raises to the minimum. A size at or above the actor’s whole stack is dropped, because all-in already covers it. A size that would leave less than 20% of the pot (as it stands once the raise is called) behind is replaced by all-in. Sizes that end up equal are kept once.
- **Order.** A node’s actions are ordered fold, check or call, the sizes in ascending order, all-in. The order fixes action indexes in the info-set key and the stored tables.

**Why this size.** Three candidates were built on the engine at 100 big blinds and timed with a prototype trainer (see [Estimates](#estimates-for-heads-up-on-this-mac)):

| Candidate | Sizes | Decision nodes | Actions per street (pre-flop, flop, turn, river) | Prototype iterations/s, one core |
| --- | --- | --- | --- | --- |
| small | 2.5×, 3×, 2.25× pre-flop; ½ and pot, then pot | 3,772 | 45, 344, 1,904, 7,576 | 39,274 |
| **medium (`hu-m1`)** | as in the table above | **11,708** | **129, 1,332, 6,256, 22,576** | **21,107** |
| large | 3 open sizes, 4 to 5 bet sizes a street, 2 raise sizes | 52,084 | 393, 4,204, 23,408, 110,568 | 10,027 |

The small tree leaves too many real bets far from any abstract size. The large one costs more than twice as much per iteration and needs about five times the iterations to reach the same number of visits per info set. The first champion only has to beat RiverMind Easy and the calling station by a clear margin (P5.5), and medium has room to do that. Large is the next step once there is an incumbent to beat. At 50 big blinds the medium tree has 5,472 decision nodes (117, 812, 3,216 and 9,704 actions per street).

## Mapping real actions onto the tree

Opponents bet any amount; the bot only knows its abstract sizes. Off-tree amounts are mapped to an abstract action, and the bot’s own abstract choices are turned into chips.

**Measuring a size.** At any node, every bet or raise, real or abstract, is measured as *x* = (raise-to total − current bet) / called pot, as above. Pre-flop multiples are converted to this measure at the node, so one rule serves every street.

**Opponent bets and raises.** Let *A* < *B* be the two abstract sizes at the node that bracket the real *x*, all-in included at its own *x*. The bot maps the action to *A* with probability

> *p*(*A*) = (*B* − *x*)(1 + *A*) / ((*B* − *A*)(1 + *x*))

and to *B* otherwise. This is the pseudo-harmonic mapping of Ganzfried and Sandholm (2013), which is hard to exploit by betting just between two sizes. For example, on a flop pot of 500 an opponent bets 250 (*x* = ½) between ⅓ and ¾: *p*(⅓) = (¾ − ½)(1 + ⅓) / ((¾ − ⅓)(1 + ½)) = 0.533, so the bet maps to ⅓ pot 53.3% of the time and to ¾ pot otherwise. The draw uses the bot’s own generator: the table’s `secrets.SystemRandom` live (D-8), a seeded generator in evaluation.

- A bet or raise **smaller than the smallest abstract size** maps to that size. Mapping it to a check would leave the bot facing a bet at a node where it believes it can check. Tiny bets are therefore a known way to probe the blueprint. P5.4 adds a min-betting probe to the report, and real-time search (P5.8) is the real fix.
- A raise **larger than the largest non-all-in size**, or beyond the raise levels the tree has, maps between that size and all-in by the same rule, or straight to all-in if all-in is the only raise left.
- A **real all-in** maps to the abstract all-in, so the bot knows its opponent has nothing behind.
- **Folds, checks and calls** need no mapping. A call of an off-tree bet is the call of the mapped bet.

**The bot’s own sizes.** The chosen abstract size is computed from the **real** pot, current bet and stacks with the size rules above, rounded to whole chips and clamped to the legal minimum and maximum (`LegalActions.min_to` and `max_to`). All-in is `max_to`. If the real stacks drop that size (it would be all-in, or leave too little behind), the bot plays the real size whose *x* is closest.

**Re-entering the tree.** Mapping can leave the abstract history with no decision left while the real hand goes on, for example after a real raise mapped to an all-in that the bot called with chips behind. Then the bot restarts the current street at the abstract node with an empty history on that street whose ratio of stack to pot is closest to the real one (by the absolute difference of their logarithms) and continues from there. Its card bucket does not depend on the history, so nothing else changes. A real action that has no counterpart at the node it reaches also sends the bot back to the start of the street; if the street’s actions do not fit from there either, the bot checks or calls.

**How the bot keeps its place (P5.4).** [`BlueprintPolicy`](../rivermind/bots/blueprint/policy.py) works from the `SeatView` alone: at each decision it replays the hand’s real actions onto the tree, street by street. It remembers every abstract token it has given a real action, its own choices and its mapping draws alike, so a later decision never draws a mapping again. A table that knows when a hand starts can call `new_hand()`; otherwise the bot tells a hand from an earlier one with the same cards by its actions. It counts its decisions by outcome (`trained`, `borrowed`, `untrained_node`, `lost`) and its mappings (`off_tree`, `below_smallest`, `reentries`, `resized`), and the evaluation reports them.

## Card abstraction

Each player’s cards are reduced to a **bucket** on each street. The bucket depends only on that player’s hole cards and the board, not on earlier buckets: the abstraction has imperfect recall, as Pluribus’s did, which spends the memory on the current street’s cards.

**Pre-flop: 169 lossless classes.** The two hole cards’ ranks are *r*₁ ≥ *r*₂, numbered 0 (deuce) to 12 (ace). The class is `13 × r₁ + r₂` when suited, `13 × r₂ + r₁` when offsuit, and `14 × r` for a pair of rank *r*: the familiar 13 × 13 grid, with pairs on the diagonal and suited and offsuit hands on either side of it. Every one of the 1,326 starting hands falls in exactly one of the 169 classes, and hands in a class are strategically identical before the flop.

**After the flop: clusters of equity distributions.** All three streets cluster on the same quantity: the hand’s **river equity**, its chance of beating one uniformly random opponent hand on the completed board, with ties counting half and the opponent never holding a card already seen.

- **River:** the equity itself, clustered in one dimension into 1,000 buckets.
- **Turn:** a histogram, over the 46 possible river cards, of the river equity, in 50 equal bins from 0 to 1. Turn hands with the same average equity but different spreads, such as a made pair and a flush draw, land apart.
- **Flop:** the same histogram over all 1,081 turn-and-river runouts.
- Turn and flop histograms are clustered by k-means into 1,000 buckets each, on the histograms’ cumulative sums with the Euclidean distance. For one-dimensional histograms the earth mover’s distance is the L1 distance between cumulative sums, so this is a fast, close stand-in for it (Johanson et al., 2013, “distribution-aware” abstraction).
- **Potential-aware** flop clustering, on histograms over turn buckets instead of equity, is usually somewhat stronger and costs an optimal-transport distance in k-means. It is a candidate for a later abstraction version, to keep if P5.4 shows a gain.

**Suit isomorphism.** Hands that differ only by renaming suits are the same hand, so tables are computed and stored once per class. Here the board is a set: the order in which board cards arrived does not matter, which suits an abstraction with imperfect recall. The class counts below were computed by Burnside’s lemma for this page; the pre-flop 169 checks the method.

| Street | Hands (hole + board) | Classes | Boards | Board classes |
| --- | --- | --- | --- | --- |
| Pre-flop | 1,326 | 169 | — | — |
| Flop | 25,989,600 | 1,286,792 | 22,100 | 1,755 |
| Turn | 305,377,800 | 13,960,050 | 270,725 | 16,432 |
| River | 2,809,475,760 | 123,156,254 | 2,598,960 | 134,459 |

Clustering weights each class by the number of raw hands it stands for, so a class with all-distinct suits counts more than a monotone one.

**Reproducibility (P5.2).** Equities are computed exactly by enumeration, with no simulation. River equity ranks all 1,081 hole pairs on a board once, then removes the opponents that share a card by inclusion and exclusion. The turn and flop histograms read those river rows through the board index instead of evaluating again. K-means is RiverMind’s own weighted k-means++ and Lloyd’s iteration, seeded per street. Its centre updates add in a fixed order: scikit-learn’s parallel version gave slightly different centres from run to run. The river clusters the 1,981 possible equities with their weights. The flop and turn are fitted on 500,000 hands sampled without replacement (weighted by the raw hands each stands for), and then every hand goes to its nearest centre. Buckets are renumbered so that bucket 0 has the lowest mean equity. A table set is therefore a pure function of its settings and software, whatever the number of worker processes. Its manifest records the settings, seed, software versions, Git commit, build times, peak memory and the SHA-256 of every file.

**Storage and lookup.** For each street, an index array maps every board (by its combinatorial rank among 3-, 4- or 5-card sets) to its board class and the suit permutation that maps it there. A bucket array holds, for each board class, a `uint16` bucket for each of the 1,326 hole-card pairs (slots that collide with the board are unused). To look up a hand: rank the board, read its class and permutation, apply the permutation to the hole cards and read the bucket. The arrays are 357 MB for the river, 43.6 MB for the turn, 4.7 MB for the flop, and 15.6 MB of board indexes and class keys: 421 MB in all, as `.npy` files opened memory-mapped, so a server reads only the pages it uses and several processes share them. A lookup takes about 5 µs in Python. `rivermind-poker tables build`, `verify` and `bucket` build a set (by default in `artifacts/tables/hu-m1`), check it against its manifest and print one hand’s bucket; [the table sets](#table-sets) lists the one built.

## Info-set key

An info set is what the acting player knows, as the bot sees it: the abstraction, the depth class, the street, the player’s bucket and the abstract betting history. It has a text form for people and tests, and an integer form for storage.

**Text form:** `<abstraction>|<depth class>|<street>|<bucket>|<history>`

- `<street>` is `P`, `F`, `T` or `R`.
- `<history>` lists each street’s abstract actions, streets separated by `/`. Tokens: `k` check, `c` call, `b0`, `b1`, … bet and `r0`, `r1`, … raise (the index into that street and level’s row of the size table, before merging), `a` all-in. Folds never appear, since they end the hand. Blinds are implied.
- Example: `hu-m1|100|T|412|r0c/kb1c/k` is the small blind to act on the turn with bucket 412 at 100 big blinds. Pre-flop it opened to 2.5× and was called; on the flop the big blind checked, it bet ¾ pot and was called; on the turn the big blind checked.

**Integer form.** The tree for each depth class is compiled in a fixed depth-first order, children in action order, and each decision node gets an offset within its street. A node with *n* actions owns *n* consecutive slots, and a street’s width *W* is the total of its nodes’ actions. The slot of action *i* at node *v* for bucket *b* is `b × W(street) + offset(v) + i` within its depth class and street. Each depth class and street is a block of one flat array, starting at `base[depth class][street]`: one array of regrets and one of average-strategy sums, 43,937,574 slots each for `hu-m1`. Every info set that can occur has room from the start and nothing is hashed during training.

A checkpoint’s manifest records the SHA-256 of the compiled trees (each node’s history and actions), so a checkpoint can never be loaded against a tree that numbers its slots differently. It sits beside the card tables’ hashes (P5.3).

## What training and serving assume

Training is built (P5.3, [below](#training-p53)), and so is the serving code ([below](#serving-p4b6), P4B.6); serving a champion on the site is P5.7a. These choices are fixed enough here to make the estimates meaningful.

- **Trainer:** external-sampling Monte Carlo CFR on the compiled tree: one deal per iteration, every action of the updated player (seat *iteration* mod 2) explored, the opponent’s and chance’s sampled, and the opponent’s current strategy added to its average-strategy sums. It uses linear discounting early and negative-regret pruning later, with a floor on regrets, as in Pluribus. Regrets are `int32` and average-strategy sums `float64`; the sums live only in the main process, where `float32` would lose small additions to large totals.
- **Deals in batches:** cards and their eight bucket lookups (two seats, four streets) are drawn for a thousand iterations at once with NumPy, so a lookup costs about 0.15 µs, not a Python call per card.
- **Exact resume with several cores (RM-02, RM-04):** training runs in batches of chunks (64 chunks of 1,000 iterations by default). Every chunk of a batch starts from the same regrets, the snapshot left by the previous batch, sees its own changes as it goes, and returns them; everything random in a chunk comes from the seed and the chunk’s number. The main process adds the chunks’ changes in chunk order, applies any discount that is due, and may write a checkpoint. A run is then a pure function of its settings, trees and card tables, whatever the number of worker processes, and resumes exactly at any batch boundary.
- **Serving:** the bot plays the average strategy, with probabilities stored as `uint8` (multiples of 1/255, renormalized over legal actions). An info set never reached in training borrows the nearest bucket at the same node that has data; failing that, it checks or calls. P5.4 reports the share of decisions that found trained data, as RM-06 did (71.1% for the prototype).

## Estimates for heads-up on this Mac

Measured on 2026-11-19 on this Mac: an Apple M5 with 4 performance and 6 efficiency cores, 32 GB of memory and 204 GB of free disk, running Python 3.12.15, NumPy 2.5.5 and scikit-learn 1.9.1. The serving host, ubuntu-vm, has 6 vCPUs (Ryzen 7 5800H), 7 GB of memory and a service limit of 2 GB high and 3 GB maximum (`deploy/rivermind-poker.service`). The service was using 154 MB.

**How it was measured.** Throwaway scripts outside the repository did the following:

- built each candidate tree through the engine;
- compiled the tree into flat arrays, with terminal payoffs from the engine’s results;
- ran external-sampling MCCFR on it with `float32` regret and strategy arrays, regret matching and real showdowns from `evaluator.evaluate`;
- counted suit classes by Burnside’s lemma;
- timed the river-equity step on 2,000 random boards.

The bucket lookups were random stand-ins, since the P5.2 tables do not exist yet. The trainer had no pruning, no discounting and no batch merging. The figures below are planning numbers; P5.2 and P5.3 replace them with measured ones.

**Measured.**

- The engine-walking trainer managed about 1,900 iterations a second on one core for the medium tree, and the compiled tree 21,107 at 100 big blinds and 31,130 at 50, so training runs on the compiled tree.
- Ten processes, each with its own copy of the 100 big blind tables, reached 113,567 iterations a second in total: 5.4 times one core. Four processes reached 73,455, and eight 106,454. The six efficiency cores add about 55% to the four performance cores.
- An iteration updates 13.9 info sets of the traversing player at 100 big blinds and 10.8 at 50.
- Ranking all 1,081 hole-card pairs on a river board took 0.51 ms.

**Memory, `hu-m1` with 169, 1,000, 1,000 and 1,000 buckets.**

| Item | 100 bb | 50 bb | Total |
| --- | --- | --- | --- |
| Info sets | 11,671,436 | 5,438,760 | 17,110,196 |
| Info-set actions (table slots) | 30,185,801 | 13,751,773 | 43,937,574 |
| Training tables (regret + average, 8 bytes a slot) | 241 MB | 110 MB | 352 MB |
| Served strategy (`uint8`) | 30 MB | 14 MB | 44 MB |

Training memory is then about 0.35 GB of shared tables, plus 0.42 GB of memory-mapped card tables and about 150 MB per worker process: under 3 GB with ten workers, far inside 32 GB. The same tree with 4,000 buckets a street would need 1.4 GB of tables, and the large tree with 4,000 buckets 4.4 GB at 100 big blinds, so memory does not limit this Mac for heads-up. Serving needs about 44 MB of strategy plus the card tables’ pages in use, inside the unit’s 2 GB high mark. P5.7a measures peak memory on ubuntu-vm.

**Time.**

- **Card tables (P5.2, measured).** A full build takes 3 to 5 minutes and peaks at 2.3 to 3.2 GB summed over its processes, about a tenth of the hour estimated here before P5.2. From commit `401b49e` with ten workers it took 193 s and 3.2 GB: river equities 20 s, turn and flop histograms 5 and 6 s, turn k-means 93 s and flop k-means 66 s. With six workers it took 200 s and 2.3 GB, and a ten-worker build that shared the CPU with a test run took 289 s. The river equity step costs 0.62 ms a board. The histograms are cheap because they reuse the river rows; most of the time is k-means.
- **Training (P5.3).** As a planning rule, aim for an average of 1,000 updates per info set; P5.3 stops on measured progress, not on this number. That is 11,671,436 × 1,000 / 13.9 ≈ 840 million iterations at 100 big blinds and 5,438,760 × 1,000 / 10.8 ≈ 504 million at 50. At the prototype’s ten-process rate that is about 2.1 hours at 100 big blinds and 0.8 hours at 50 (whose iterations are about 1.5 times faster). Allowing three times for the real trainer’s lookups, batch merging, checkpoints and evaluation snapshots, the first heads-up blueprint is **about 9 hours of training: one overnight run**. Budget 24 hours of wall-clock time including restarts. P5.3 measured about twice the time per iteration once strategies are trained, and about 6 GB of memory with ten workers rather than 3 GB ([Training](#training-p53)).
- **Scaling up.** The large tree with 4,000 buckets a street has about 208 million info sets at 100 big blinds and updates 25.2 per iteration. That is about 8.2 billion iterations, around 5 days on this Mac by the same rule. It is a reasonable second run if the first champion leaves visible weaknesses. Neither run needs other machines (Q-5).

**What could make these wrong.** Real regrets concentrate on a few actions, so later iterations visit fewer nodes and run faster, and pruning speeds them up again. Batch merging and shared arrays add overhead that the prototype did not have. Turn and river nodes on rare lines get far fewer than the average number of updates. Each of these is measured at P5.3.

## Table sets

Built sets live under `artifacts/` (ignored by Git), so a checkpoint’s manifest names the set by these hashes. Build one with `uv run --locked rivermind-poker tables build` and check it with `rivermind-poker tables verify`.

| Set | Settings | Bucket files (SHA-256) |
| --- | --- | --- |
| `hu-m1`, seed 0 | 169, 1,000, 1,000 and 1,000 buckets; 50 bins; k-means fitted on 500,000 hands, at most 300 iterations; Python 3.12.15, NumPy 2.5.5 | `preflop.npy` `a0a6e5ed…8d8304c9`, `flop.npy` `947731ea…aea03bab`, `turn.npy` `cd14176b…aeb5bc3c`, `river.npy` `756d746b…84eb34ae` |

The full hashes of every file are in the set’s `manifest.json`. Three full builds (10 and 6 workers before commit `401b49e`, and 10 workers from it) gave byte-identical files.

## Training (P5.3)

[`rivermind/bots/blueprint`](../rivermind/bots/blueprint/) builds the [assumptions above](#what-training-and-serving-assume): `tree` compiles the trees from the engine, `deals` buckets whole batches of deals with a table set, `mccfr` runs a chunk of iterations, `train` runs the batches, discounts and checkpoints, and `Blueprint` reads a checkpoint. The commands are:

```sh
uv run --locked rivermind-poker blueprint tree                  # node counts and tree hashes
uv run --locked rivermind-poker blueprint train RUN --iterations N   # --resume to continue
uv run --locked rivermind-poker blueprint info RUN --verify
uv run --locked rivermind-poker blueprint strategy RUN AsAh     # or HOLE BOARD --history r0c/
```

**Trees.** The compiled trees match the P5.1 counts exactly: 11,708 decision nodes at 100 big blinds (44, 472, 2,372 and 8,820 by street, widths 129, 1,332, 6,256 and 22,576) and 5,472 at 50 (40, 296, 1,244 and 3,892). With the hu-m1 tables that is 17,110,196 info sets in 43,937,574 slots. Both trees compile in under a second. Their SHA-256s are `378a4e1d…b590613881` (50) and `220a7cab…a61f2287b` (100); every checkpoint records them in full.

**Settings** (the defaults of `blueprint train`). Batches of 64 chunks of 1,000 iterations; a linear-CFR discount every 1,000,000 iterations up to 40,000,000; pruning from 20,000,000 iterations in 95% of iterations, of the traverser’s actions with regret below −10,000,000 that neither end the hand nor lie on the river; a regret floor of −11,000,000. Depth classes are sampled in proportion to their info sets (68.2% at 100 big blinds).

**Pruning threshold.** Pluribus pruned below −300,000,000 with a floor of −310,000,000, on stacks of 10,000 chips at 50/100, as here. Its run was far longer, and this one’s regrets stay much smaller. A probe scaled the regrets of a checkpoint at 25,728,000 iterations by 50, about their size halfway through a 1.28-billion-iteration run once discounting has stopped, and timed chunks with pruning on. At −300,000,000 pruning skipped nothing (86.4 decision nodes per iteration either way); at −30,000,000 it cut that to 77.4, at −10,000,000 to 59.6 and at −3,000,000 to 38.9. The default is −10,000,000, with the floor 10% beyond it so that an action pruned in error can recover in the 5% of iterations that do not prune.

**Checkpoints.** A run directory holds `live/regrets.i32` (the regrets the workers read), `checkpoints/<iteration>/` and `latest`, which names the newest. A checkpoint has `regrets.npy` (`int32`), `strategy.npy` (`float64` average-strategy sums) and `manifest.json`: the format, the abstraction, the iteration and batch counts, the settings, the layout and each tree’s counts and SHA-256, the card table set’s path, seed and file hashes, the engine (package version and a hash of `rivermind/engine`’s source), the software (Python, NumPy, Git commit and whether the tree was dirty), training time and speed, the share of each street’s info sets updated, and each file’s SHA-256 and size. It is written to a `.partial` directory, hashed and renamed, and only then named in `latest`. Resuming checks every hash and refuses a checkpoint whose trees, layout or card tables differ; a lock keeps two trainers out of one run. Ctrl-C or SIGTERM stops at the end of the current batch and writes a checkpoint. A checkpoint is 527 MB and takes about half a second to write.

**Correctness.** On Kuhn poker, whose equilibrium is known, the trainer reaches an exploitability under 0.02 chips a hand (0.011 in the test) in 300,000 iterations, with or without pruning, and seat 0’s value is within 0.005 of −1/18. A run is byte-identical whatever the number of workers and wherever it is stopped and resumed: through the CLI on the hu-m1 tables, 768,000 iterations with discounts every 128,000 to 384,000 and pruning from 256,000 at −20,000 gave the same `regrets.npy` (`95c35ea3…`) and `strategy.npy` (`becfd950…`) from ten workers straight through as from six workers stopped by Ctrl-C at 448,000 and resumed on three.

**What batching costs.** Every chunk of a batch starts from the same regrets, so the number of batches, not of iterations, limits how far a strategy can move. On Kuhn poker, where every info set is reached many times in every chunk, 25 batches of 64,000 iterations left an exploitability of 0.078, against 0.011 for 750 batches of 400. Letting each chunk see its own updates as it goes helped a little (0.100 to 0.078) and cost no measurable speed. In `hu-m1` a batch reaches a first pre-flop decision a few hundred times per hand class, and nearly every post-flop info set less than once, so 20,000 batches of 64,000 is a long run in CFR terms; the batch is still large enough that merging (about 40 ms) and dispatch stay small beside the chunks’ work.

**Speed and memory on this Mac.**

- One process managed 13,000 to 17,000 iterations a second from uniform strategies, at 38 to 51 decision nodes an iteration; ten workers about 66,000 a second over the first 768,000 iterations and 71,000 at best.
- Trained strategies reach more of the tree: by 25.7 million iterations an iteration visited 86 decision nodes, not the 46 of uniform play, and ten workers slowed to 30,000 to 40,000 a second. The P5.1 estimate assumed the uniform rate, so a run takes about twice as long as estimated, before pruning wins some of that back.
- The Mac was shared with other work during these measurements (load averages up to 120), which cost another factor of two at times; the speeds above are from quieter moments.
- Memory: the main process holds about 0.8 GB and each worker about 0.5 GB (physical footprint), about 6 GB with ten workers. Summed resident sizes read 11 to 14 GB because they count the shared memory-mapped table pages once per process.

## Evaluation (P5.4)

[`rivermind/bots/match.py`](../rivermind/bots/match.py) plays **duplicate** heads-up matches on the engine. Each deal is one shuffled deck played twice, once with the candidate on the button and once with the opponent there, from fresh stacks each time. A deal’s value is the candidate’s mean winnings over its two hands, and the 95% interval is 1.96 standard errors over deals, which are independent, with both rotations of a deal kept together. Two calling stations score exactly zero. Decks come from the seed and the deal number, and each seat’s policy from its own generator seeded by the seed, the deal, the rotation and the seat. Deals go to workers in fixed blocks of 50 with fresh policies and are added in deal order, so a report is the same whatever the number of workers.

```sh
uv run --locked rivermind-poker blueprint evaluate RUN_OR_CHECKPOINT --name NAME   # writes docs/evaluations/NAME.{md,json}
```

The default plan plays 20,000 deals (40,000 hands) per matchup at 50/100: RiverMind Easy (`heuristic`), the calling station, random and the min-bet probe at 100 big blinds, and RiverMind Easy and the calling station, the two opponents of the P5.5 gate, at 40 and 150. `--against OPPONENT@STACK_BB` replaces the plan, and `blueprint:<checkpoint>` names an incumbent. The **min-bet probe** (`MinBetPolicy`) opens every street with the smallest legal bet or raise and otherwise checks or calls. Each report records the game, seed, deals, the candidate checkpoint’s file, tree and card hashes and the commit that trained it, each opponent’s source hash, the engine and software, every result with the candidate’s decision counts and the command that reproduces it. [docs/evaluations](evaluations/) holds the reports. `rivermind-poker blueprint gate REPORT.json` applies the P5.5 promotion gate to one: the lower bound of the 95% interval must be above zero against RiverMind Easy and the calling station at 100 big blinds, and, with `--incumbent blueprint:<checkpoint>`, against the champion it would replace, which the report must have played.

## Serving (P4B.6)

The Node server plays the bots in TypeScript ([`web/src/lib/server/bots`](../web/src/lib/server/bots/)): the random, calling-station and RiverMind Easy bots, the min-bet probe, and `BlueprintPolicy`, a line-for-line port of the [mapping](#mapping-real-actions-onto-the-tree). Since P5.7a it serves the registry's heads-up champion as RiverMind Hard, after checking the bundle against the registry ([CONTRIBUTING](../CONTRIBUTING.md#rivermind-hard-serving-a-champion-p57a)). The Python bots stay the reference. Bots draw from `PythonRandom`, a port of CPython’s `random.Random` (MT19937 with its seeding, `random`, `getrandbits`, `randint` and `choice`), so a bot seeded the same way makes the same draws in both languages; a live table seeds it from the operating system’s randomness, as `serve-nl` seeds its bots’ `random.Random` from `secrets.SystemRandom().getrandbits(64)` (D-8).

A trained blueprint reaches Node as a **serving bundle**, written by `rivermind-poker blueprint export CHECKPOINT --out DIR` ([`bundle.py`](../rivermind/bots/blueprint/bundle.py)):

- `strategy.u8`: the average strategy in the checkpoint’s slot layout, each info set rounded to multiples of 1/255 (half-even), so a bot divides each action’s byte by the node’s total; an info set training never reached stays all zero.
- `trees.json`: both depth classes’ compiled trees, with the measures and stack-to-pot ratios the mapping uses. Node recomputes each tree’s SHA-256 from it and compares it with the manifest’s.
- The card-table arrays a lookup needs, as flat little-endian files: `preflop.u16`, and for each post-flop street `<street>_board_class.i32`, `<street>_board_perm.u8` and `<street>.u16`.
- `manifest.json`: the checkpoint (path, iteration, its manifest’s and strategy’s SHA-256s, settings, engine), the game layout, the table set (path, seed, its files’ SHA-256s and `table_set`, one SHA-256 over them as sorted compact JSON), each array’s dtype and shape, and every file’s SHA-256 and size.

`loadBundle` reads every file into memory once, hashing it as it reads, and refuses a bundle with a missing, extra or changed file, a tree or layout that disagrees with the manifest, or, given `tableSet`, another card table set. Python reads a bundle back with `ServingBundle` and plays it with `BlueprintPolicy.from_bundle`, which is what the parity check compares against.

Serving fixed one mapping bug the evaluation could not show: the tree’s seat 0 is the button, but the policy compared the tree’s player with the real seat number, so a bot in seat 1 holding the button found no node and checked or called every decision. P5.4’s matches always put the button in seat 0, so its reports are unaffected; a live table alternates the button. The policy now maps the button to the tree’s seat 0, and measures stacks and the opponent’s bet over the two players dealt in, so a bigger table with empty seats plays the same.

`pnpm bots:parity` (from `web/`, also in CI) runs [`rivermind.bots.differential`](../rivermind/bots/differential.py) and checks, with the same deals and seeds, that the simple bots play 2,000 fuzz deals at 2 to 9 seats to byte-identical hand records, that the blueprint gives the same probabilities, statistics and hands over 2,000 decisions against each simple bot and itself, and that card buckets agree for every hole-card pair on 200 seeded boards a street. Without `--bundle` it checks a synthetic bundle: the real trees, random strategies with untrained info sets and nodes, and random card tables. `pnpm bots:bench -- --bundle DIR` times the blueprint’s decisions.

```sh
uv run --locked rivermind-poker blueprint export artifacts/blueprints/hu-m1-s0/checkpoints/000128000000 --out artifacts/bundles/hu-m1-s0-128m
cd web && pnpm bots:parity -- --hands 2500 --bundle ../artifacts/bundles/hu-m1-s0-128m --tables ../artifacts/tables/hu-m1 --decisions 100000 --boards 1000
cd web && pnpm bots:bench -- --bundle ../artifacts/bundles/hu-m1-s0-128m
```

On 2026-11-20, the 128-million-iteration checkpoint of `hu-m1-s0` exported in 12 s to a 450 MB bundle (`strategy.u8` `ec57ac6f…`, table set `4ff8b0ef…`). The long parity run above matched 20,000 simple-bot hands, all 100,002 blueprint decisions (identical probabilities, not merely within 1e-9; 99.9% trained, 630 re-entries, 48 lost) and the buckets on 1,000 boards a street against the original `.npy` tables, in 70 s. On this Mac (Node 26.13, load average about 40 from the training run) the bundle loads in 1 to 2 s and a blueprint decision takes 0.006 ms at the median, 0.04 ms at p95 and 0.46 ms at p99 over 20,003 decisions, with 443 MB of array buffers.

**On ubuntu-vm (P5.7a, 2026-11-21).** `pnpm bots:bench` on the champion `hu-m1-s0-1024m`, from `/srv/rivermind-poker/models/champions`, on the host that serves the site (6 CPUs, 7.4 GB, Node 26.13.1, load average 0.7): the bundle loaded and hashed in 0.8 s, and over 20,003 decisions, every one with trained data, a decision took 0.005 ms at the median, 0.014 ms at p95, 0.034 ms at p99 and 5.8 ms at most. That is four orders of magnitude inside the 200 ms budget, and it does not include the table's 0.6 s thinking delay, which is a presentation setting (`RIVERMIND_BOT_DELAY`). The process peaked at 603 MB resident, 442 MB of it the bundle's arrays; the live service was using 38 MB at the time, so with the champion it should sit near 0.6 GB of its 2 GB `MemoryHigh`. The service's own peak is read from `systemctl show rivermind-poker-web -p MemoryPeak` after the deploy that turns the champion on.

The P5.4 reports evaluate the `float64` checkpoint; the bundle serves its rounding, which moves each probability by about half a level (1/510) before renormalizing. The promotion gate is therefore applied to the bundle as well as the checkpoint ([below](#promotion-and-the-registry-p55)).

## Promotion and the registry (P5.5)

A **champion** is the bot the site serves for a format (heads-up now; 6-max and 9-max at P5.6). [docs/models.md](models.md) lists the champions and every run put to the gate, and [`models.json`](models.json) beside it is the registry that page is generated from ([`registry.py`](../rivermind/bots/registry.py)).

**The gate.** At 100 big blinds, the lower bound of the 95% interval must be above zero against each of RiverMind Easy and the calling station. A replacement must clear the same bound against the format’s champion, in the same report. The gate is applied twice, to the checkpoint and to the serving bundle exported from it, because the bundle’s rounded strategy is what people play. A run whose interval lies wholly below zero in any of those matches has **failed**; one whose interval spans zero is **inconclusive** and can be put to the gate again with more deals. Both are recorded and leave the champion as it was.

```sh
# 1. Evaluate the checkpoint. A replacement adds every default matchup and the champion, by its kept path:
uv run --locked rivermind-poker blueprint evaluate CHECKPOINT --name NAME \
  [--against heuristic@100 … --against blueprint:artifacts/models/CHAMPION/checkpoint@100]
# 2. Export the bundle and evaluate what the site would serve:
uv run --locked rivermind-poker blueprint export CHECKPOINT --out artifacts/bundles/NAME
uv run --locked rivermind-poker blueprint evaluate artifacts/bundles/NAME --name NAME-served [--against …]
# 3. Put both reports to the gate and record the decision:
uv run --locked rivermind-poker blueprint promote docs/evaluations/NAME.json --served docs/evaluations/NAME-served.json
uv run --locked rivermind-poker blueprint champions --verify artifacts/models
```

`blueprint evaluate` takes a bundle wherever it takes a checkpoint, and `bundle:<directory>` wherever it takes `blueprint:<checkpoint>`. A bundle plays through the same `BlueprintPolicy` on its own `uint8` strategy and its own card-table arrays, so its report measures exactly the files Node loads, and it records their SHA-256s.

`blueprint promote` checks before it records anything that every checkpoint file matches its manifest, that the report evaluated that checkpoint, that the bundle names that checkpoint and holds its card tables, that the bundle’s strategy is a fresh rounding of the checkpoint’s, and that the served report evaluated that bundle. It finds the champion in a report by its file hashes, not its path. It then appends the decision to `models.json`, rewrites the generated part of `models.md` and the site's extract of the registry ([`web/src/lib/champions.json`](../web/src/lib/champions.json), which the Node server checks a bundle against and the `/bots` page shows), and exits 1 unless the run was promoted. A report can be recorded once, and the registry holds each report’s SHA-256, so a recorded report is never edited. pytest replays every decision from its reports and fails if the page, the registry or a report disagree.

Commit code changes before evaluating: a report records the commit it ran at and whether `rivermind/` had local changes.

**The first two decisions** (2026-11-21, [docs/models.md](models.md)). `hu-m1-s0-128m` was promoted as the first heads-up champion: its served bundle won +60.74 big blinds per 100 hands (+50.53 to +70.96) against RiverMind Easy and +307.13 against the calling station, against +61.12 and +308.33 for the checkpoint, so rounding to 1/255 moved the results by 0.4 and 1.2, far inside their intervals. `hu-m1-s0-1024m`, the same run at 1.024 billion iterations, then replaced it: +21.38 (+10.71 to +32.05) head to head as checkpoints and +21.14 (+10.45 to +31.84) as bundles. It wins about the same from RiverMind Easy (+59.05) and less from the calling station (+226.66) and the min-bet probe (+267.08, down from +392.41) than the earlier checkpoint did. The gate measures play against these opponents, not exploitability, so the reports do not say why. Each evaluation took about three minutes on this Mac beside the training run. Running the served report of `hu-m1-s0-128m` twice, before and after the commit that added bundle candidates, gave the same JSON apart from the commit and the output directory.

**The end of the run** (2026-11-21). `hu-m1-s0` finished at 1.28 billion iterations, and its last checkpoint, `hu-m1-s0-1280m`, was put to the gate twice. Over the usual 20,000 deals (seed 0) it cleared the gate against both bots and won +7.21 big blinds per 100 hands from the champion as a checkpoint (-2.46 to +16.89) and +6.59 as a bundle (-3.08 to +16.27): inconclusive. One larger evaluation was planned before it ran, 80,000 deals with seed 1, so an independent sample at half the interval: +0.72 (-4.01 to +5.44) as a checkpoint and +1.65 (-3.07 to +6.37) as a bundle. Inconclusive again, and now narrowly: the last 256 million iterations changed head-to-head play by less than about 5 big blinds per 100 hands either way, where the 896 million before them were worth +21. The champion stays `hu-m1-s0-1024m`. More iterations of this abstraction with these settings are unlikely to pay; a stronger heads-up bot needs a finer abstraction, a different training schedule or search at play time, which is for P5.6 to P5.8 to weigh. The two samples also differ against RiverMind Easy (+57.21 with seed 0 and +49.19 with seed 1, whose intervals barely overlap), a reminder that a result against one fixed set of deals carries that set's luck. The 80,000-deal evaluations took under three minutes each with the Mac otherwise idle.

### Where models are kept

Artifacts never go into Git; the registry names them by SHA-256.

- **This Mac** trains and evaluates. A promoted run’s checkpoint and bundle are kept in `artifacts/models/<name>/checkpoint` and `artifacts/models/<name>/bundle`, hard-linked from the run by `blueprint promote`. A training run prunes its older checkpoints (`--keep`), and the links keep a champion’s files when that happens. The card tables are in `artifacts/tables/hu-m1`.
- **ubuntu-vm** holds the second copy, which is also what the site will serve from (P5.7a): `/srv/rivermind-poker/models/champions/<name>/` with the same two directories, and the card tables in `/srv/rivermind-poker/models/tables/hu-m1`. Everything there is owned by root and world-readable, so the sandboxed web service can read it and cannot change it.
- **Backup.** The two machines are each other’s backup. The host’s nightly `ubuntu-vm-backup` covers configuration and databases and does not include `/srv/rivermind-poker/models`: a Git repository is the wrong place for files of this size. Losing both copies costs compute, not the model: the card tables rebuild byte for byte from their seed in about four minutes, and a run is a function of its settings, trees and card tables, so retraining to the champion’s iteration gives the same checkpoint, which the registry’s hashes will confirm.

Copy a champion to the host and check it there (D-10; `COPYFILE_DISABLE=1` keeps macOS from adding `._*` files):

```sh
COPYFILE_DISABLE=1 rsync -a artifacts/models/NAME root@ubuntu-vm:/srv/rivermind-poker/models/champions/
ssh root@ubuntu-vm 'cd /srv/rivermind-poker/models/champions && chown -R root:root NAME && chmod -R u=rwX,go=rX NAME'
ssh root@ubuntu-vm 'cd /srv/rivermind-poker/models/champions/NAME && sha256sum checkpoint/* bundle/*'   # compare with models.json
```

Once the host’s checkout has the registry, `rivermind-poker blueprint champions --verify /srv/rivermind-poker/models/champions` does that comparison there.

## Difficulty levels (P5.7)

Each format serves three levels: **Easy** is the heuristic, **Hard** the format's champion, and **Medium** the two mixed. Medium ([`levels.py`](../rivermind/bots/levels.py), [`levels.ts`](../web/src/lib/server/bots/levels.ts)) plays each hand as one bot or the other: at its first decision in a hand it draws one number from the bot's generator and plays the whole hand as the champion's served bundle when the draw is below one half, and as RiverMind Easy otherwise. A hand is told from the next as `BlueprintPolicy` tells them, by the seat, its cards, the blinds, the starting stacks and the button, and by whether the actions seen so far still begin the view's actions.

**Why a hand at a time.** Mixing by decision would play lines neither bot would: the heuristic's open, then the champion's continuation from a history it never trained on. A hand played by one bot is always a line that bot plays, so the champion's mapping never has to account for actions of its own seat that it did not choose. Neither bot adapts to its opponent, so Medium's expected win rate against any fixed opponent is the same mix of the two bots' rates, halfway between them; its own evaluation measures that rather than assuming it.

**Its evaluation.** `blueprint evaluate <bundle> --level medium` plays Medium as the candidate, and `blueprint level <report.json>` records the report under the champion it was made from, after checking that its Medium is made from that champion's registered bundle, with the site's share, and that it played RiverMind Easy, the calling station and the champion itself at 100 big blinds. Medium is not put to a gate: it claims only what its report measured. A new champion has no Medium until its own is evaluated and recorded, and the site offers Medium only for a champion whose Medium is recorded (`MediumPolicy.recorded`).

**Parity.** `pnpm bots:parity` plays Medium made from the bundle in both languages, heads-up against the simple bots, the blueprint and itself, and compares which bot it chose at every decision, the blueprint's probabilities, the statistics and the hand records. On 2026-11-22 with the champion `hu-m1-s0-1024m`’s bundle (`--decisions 20000`): 20,001 Medium decisions in 9,137 hands, identical.

## 6-max and 9-max

Six seats first (P5.6). The heads-up pipeline carries over: trees compiled from the engine, the same card abstraction, external-sampling MCCFR in deterministic batches, duplicate matches and the promotion gate. Three things change. The betting tree becomes a graph of merged betting states, because six seats' histories are too many to hold; the card tables get 200 buckets a street; and the bot has to find its seat at a real table, which may have fewer than six players, short stacks and side pots. The code is built and tested, and the first six-seat run started on 2026-11-22; what follows is the design, what was measured in building it, and the estimates and settings for the run.

### The format: `6max-s1`

`6max-s1` (six seats, small action abstraction, version 1) is no-limit hold’em without an ante for six players with equal stacks, in the same two depth classes as `hu-m1`, 50 and 100 big blinds. Seat 0 is the button, seat 1 the small blind, seat 2 the big blind, and seats 3, 4 and 5 are under the gun, the hijack and the cutoff; seat 3 acts first before the flop and seat 1 first after it.

| Street | Level 0 | Level 1 | Level 2 | Level 3 and up |
| --- | --- | --- | --- | --- |
| Pre-flop (multiples of the bet faced) | 2.5× | 3× | 2.25× | all-in only |
| Flop, turn and river (fractions of the called pot) | ¾ | 1 | all-in only | all-in only |

Fold, check or call, and all-in are there as in `hu-m1`, with the same legality rules (a size under the minimum raises to the minimum, one leaving less than 20% of the called pot behind becomes all-in) and the same order. A raise is judged against one caller, the seat with the most in on the street. All-in stays available at every decision that allows a raise: without it an opponent’s shove would map to a small raise, and keeping it costs about a tenth of the graph.

**Why the states are merged.** Built the heads-up way, with a node for every history, even the smallest table of sizes is out of reach. Throwaway scripts counted the trees through the engine at 100 big blinds, for one size a level and all-in only when facing a raise:

| Seats | Decision nodes, every history its own node |
| --- | --- |
| 3 | 7,659 |
| 4 | 96,923 |
| 5 | 997,474 |
| 6 | 8,465,576 |

With 200 buckets a street that is 1.7 billion info sets and 42 GB of training tables at six seats, before a second size anywhere. Pluribus’s blueprint had 665 million action sequences and took 12,400 core-hours in C++; this trainer is Python on ten cores.

So a `merged` abstraction compiles a graph. Two histories are one node when they leave the same seats in the hand with the same chips in the pot, the same bets on the street, the same seat to act and the same rights to raise: the engine’s `acted_at` and `min_raise` (rules 7.4 and 8.1), the street’s level, and the pot, in which the chips of seats that folded count only as a total. Everything that decides the actions at a node and the chips at every terminal beneath it is in that key, so the merged graph plays exactly the lines of the unmerged tree (`test_merging_keeps_every_line_of_the_betting` walks both). What is lost is memory: on the flop the bot no longer knows who raised before it, only who is still in and what the pot is. The abstraction already has imperfect recall of cards; this gives it imperfect recall of betting, and with it no proof of convergence, as for Pluribus’s card abstraction. P5.4-style evaluation measures what it costs.

Because stacks start equal, a seat that is all-in has everything in, and so does anyone who calls it: every showdown is for one pot among seats that put in the same amount, and a terminal is four numbers (fold or showdown, what each remaining seat has in, the pot, and who remains).

**Candidates**, all merged, six seats, counted through the engine; info sets and memory are for 200 buckets a street after the flop:

| Candidate | Sizes | States at 100 bb | Info sets at 100 bb | Training tables, both depths |
| --- | --- | --- | --- | --- |
| A | pre-flop 2.5×, 3×; one ¾-pot bet, every raise all-in; all-in only against a raise | 210,155 | 41.6 million | 1.8 GB |
| A1 | A, with a pot-sized raise after the flop | 510,802 | 101.8 million | 3.8 GB |
| **`6max-s1`** | A1, with a 2.25× four-bet before the flop and all-in at every decision | **654,597** | **129.9 million** | **5.3 GB** |
| B2 | three pre-flop levels; two bet sizes on every street after the flop (½ and pot) and a pot-sized raise; all-in only against a raise | 1,394,401 | 277.9 million | 10.1 GB |

A cannot raise after the flop except by moving all-in, which is crude at 100 big blinds and looks it to anyone playing against it. B2 doubles the info sets for a second bet size. `6max-s1` is the middle: the bot can open, three-bet and four-bet before the flop, and bet, raise and re-raise all-in after it.

**The graphs as compiled** ([`tree.py`](../rivermind/bots/blueprint/tree.py), `rivermind-poker blueprint tree --abstraction 6max-s1`):

| Depth | Decision nodes | By street | Width by street | Terminals | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| 50 | 345,581 | 33,163, 68,927, 117,180, 126,311 | 79,677, 152,895, 254,203, 272,733 | 15,179 | `cc952203…c7383f59` |
| 100 | 654,597 | 33,163, 120,616, 234,861, 265,957 | 79,677, 273,876, 519,398, 584,447 | 29,103 | `2da67faf…4392b4e3` |

With the `c200` card tables that is 68,088,147 and 129,891,347 info sets, 197,979,494 in all, in 438,441,226 slots. The engine takes 30 s and 38 s to walk the two graphs, so `compile_tree` keeps each in `artifacts/trees/`, in a file named by a hash of the abstraction, the tree and abstraction modules and the engine’s source; a change to any of them compiles again. Reading one back takes half a second. A multiway tree’s SHA-256 covers each node’s seat, street, offset, actions, children, the acting seat’s chips in the pot and the seats still in, and each terminal; the `hu-m1` trees hash as they always did (`220a7cab…` and `378a4e1d…`).

A node’s **history** in an info-set key is the one the depth-first walk met first: `6max-s1|50|P|168|ffffc` is the big blind’s option after four folds and the small blind’s call. `Tree.node` finds a node from any of its histories by walking the tokens, and folds appear in them as `f`.

### Card tables: `c200`

The same pipeline as `hu-m1`’s tables ([card abstraction](#card-abstraction)) with 200 buckets on the flop, turn and river, as Pluribus used: 169 classes before the flop.

```sh
uv run --locked rivermind-poker tables build --out artifacts/tables/c200 --name c200 \
  --flop_buckets 200 --turn_buckets 200 --river_buckets 200
```

Built on 2026-11-22 from `3888572` (whose card code the build used unchanged) with ten workers in 181 s, with a peak of 3.1 GB summed over processes, at a load average near 30: 401 MB in 16 files. `preflop.npy` is `hu-m1`’s (`a0a6e5ed…`); `flop.npy` is `b245fe1e…916929ee`, `turn.npy` `2765327c…f2bfacee` and `river.npy` `2c89cf94…4f16ae3a`. A second build from `ca7965d` with six workers (218 s, 2.1 GB peak) gave byte-identical files on 2026-11-22.

### Training six seats

[`_run_chunk_multiway`](../rivermind/bots/blueprint/mccfr.py) is the heads-up walk with three changes. The traverser is seat *iteration* mod 6. Every other seat’s action is sampled and its current strategy added to its average-strategy sums, as the one opponent’s is heads-up. And the walk stops where the traverser folds: the hand goes on without it, but it can lose nothing more, so the fold is worth minus what it has put in. At a showdown the traverser wins the pot divided among the best hands still in, less its own chips; chips are not rounded as the engine rounds an odd chip. The dealer deals six hands and a board and ranks each hand once.

**Correctness.** On two seats and an unmerged tree the multiway walk makes the same draws and returns the same regret and strategy changes as the heads-up walk, slot for slot: with the `hu-m1` trees and tables, six chunks of 1,000 iterations with pruning on were identical, and the test repeats it on stand-in cards. A three-seat graph played to its terminals on the engine with real cards pays every seat what the graph says, to within the engine’s odd chip. A three-seat run is byte-identical on one worker and three, and stopped and resumed. Trained for 60,000 iterations on a game where each seat holds one of six strengths, the small blind folds its worst hand to an all-in more than 90% of the time and its best less than 5%.

**Measured on this Mac** (2026-11-22, one probe of 2,560,000 iterations through the CLI with ten workers, from uniform strategies, while other projects held the load average at 35 to 47):

- 23,000 to 24,000 iterations a second once running; the first batch took 34 s while ten workers started and read the graphs.
- About 23 decision nodes an iteration, 5 of them the traverser’s (the prototype’s count; heads-up visits 46 and updates 14).
- Memory: 14.4 GB summed over processes at the peak, which counts shared pages once a process. The arrays themselves are 1.75 GB of regrets and 3.5 GB of average-strategy sums, and a checkpoint is 5.3 GB.
- After those iterations 27% of the pre-flop info sets at 100 big blinds had been touched, 6.5% of the flop’s, 2.5% of the turn’s and 1.5% of the river’s.

**Estimate.** The first heads-up champion had about 90 updates an info set (128 million iterations, 13.9 updates each, 17 million info sets). The same average here is 198 million × 90 / 5 ≈ 3.6 billion iterations: **about 43 hours at the probe’s rate**, on a Mac shared as it was that day. An idle Mac should be faster, by how much is not measured; heads-up lost a factor of two to load and another once strategies were trained, and gained some back from pruning. The run can be put to the gate at any checkpoint on the way. If two days is too long, the 100 big blind class alone is two thirds of the work, and candidate A a fifth of it.

**Settings.** A run this long keeps Pluribus’s proportions as `hu-m1` did: a linear-CFR discount every 4,000,000 iterations until 160,000,000, and pruning from 80,000,000.

**The pruning threshold**, from a probe as for P5.3 (2026-11-22). A scratch run trained 24,000,000 iterations with the schedule above on eight workers (19,175 a second at a load average near 100, 12.9 GB peak summed over processes). Its regrets were then scaled to their size later in the run and 16,000 iterations were played with pruning in every one, at several thresholds. With a linear-CFR discount every *P* iterations, an action losing *r* chips an iteration has regret *rP·D*/2 after *D* discounts, so the checkpoint holds about 12 million *r*; at iteration *T* after the last discount it is 80 million *r* plus *r*(*T* − 160 million). That gives the scales 3.3 (80 million, where pruning starts), 27 (400 million), 143 (1.8 billion, mid-run) and 293 (3.6 billion). The probe’s regrets were already larger than expected: the most negative was −9.4 million, and 1% of negative slots were below −189,000, since six-seat pots are larger and every folded hand is a loss to someone. Decision nodes visited per iteration (39.6 unpruned):

| Threshold | at 80 million | 400 million | 1.8 billion | 3.6 billion |
| --- | --- | --- | --- | --- |
| −1,000,000 | 24.8 | 12.8 | 8.7 | 8.2 |
| −10,000,000 (`hu-m1`’s) | 38.0 | 26.3 | 16.0 | 12.5 |
| −30,000,000 | 39.0 | 32.6 | 22.8 | 18.3 |
| **−60,000,000** | **39.6** | **35.9** | **27.1** | **22.7** |
| −100,000,000 | 39.6 | 38.5 | 30.0 | 25.7 |
| −300,000,000 | 39.6 | 39.6 | 36.0 | 32.3 |

`hu-m1`’s threshold cut 31% of visits at its mid-run; −60,000,000 cuts 32% at this run’s, nothing where pruning starts and 43% by the end, so it is the choice, with the floor 10% beyond it as before. The probe’s scaling assumes a losing action keeps losing at the same rate, which pruning itself stops; it sets an order of magnitude, as P5.3’s did. Its script and output are kept in `artifacts/blueprints/` (`prune_probe.py`, `prune_probe.out`).

```sh
nice -n 19 uv run --locked rivermind-poker blueprint train artifacts/blueprints/6max-s1-s0 \
  --abstraction 6max-s1 --tables artifacts/tables/c200 --iterations 3600000000 \
  --discount_every 4000000 --discount_until 160000000 --prune_after 80000000 \
  --prune_threshold -60000000 --regret_floor -66000000 --checkpoint_every 100000000 --keep 4 --workers 8
```

The run `artifacts/blueprints/6max-s1-s0` started with that command on 2026-11-22 from `ca7965d`.

### Playing at a real table

[`MultiwayBlueprintPolicy`](../rivermind/bots/blueprint/policy.py) keeps the heads-up mapping (the pseudo-harmonic rule, remembered tokens, its own sizes from the real pot) and adds what a table needs.

- **Seats.** A real seat takes its tree seat by position: the button 0, the blinds 1 and 2, and the rest counting back from the button, so the seat before the button is always the cutoff.
- **Fewer than six dealt in.** The hand starts at the node where the tree’s first seats to act have folded: five players start after one fold, three after three. Folding in turn puts no chips in the pot, so this is the six-seat game with those hands gone. Two players are different: heads-up the button posts the small blind and acts last after the flop, which no six-seat hand does. The policy refuses a hand of two, and P5.7 gives those hands to the heads-up champion.
- **Depth class.** By the bot’s own stack, or the largest stack against it if that is smaller: under 71 big blinds the 50 tree.
- **Seats that cannot act.** Real stacks differ, so a player can be all-in at the table while the tree, where stacks are equal, waits for it. The tree checks or calls for that seat and moves on (`passed` in the statistics).
- **A raise the graph cannot hold.** The graph may have a seat all-in, or a street’s raises spent, where the real table goes on raising. Such a raise maps to the call at that node: the raiser has at least matched the bet (`capped`).
- **Re-entering the graph.** When a street’s real actions do not fit from the node the hand reached, the bot restarts the street at the node that opens it for exactly the seats still in, with the stack-to-pot ratio closest to the real one, and replays the street. Because states are merged, such a node is very nearly where the hand is.

Six blueprints playing each other with equal stacks at the depth class never leave the graph: every decision finds its own node with no mapping, re-entry or passed seat, at six, five, four and three dealt in (`test_blueprints_playing_each_other_stay_on_the_graph`). Against two random bots, the calling station and RiverMind Easy over 3,000 hands at three to six players with stacks from 7 to 150 big blinds, every action was legal and 97 of 5,661 decisions (1.7%) found no node and checked or called. Every one came after the graph’s hand had ended while the real one went on: a raise far over the largest size had mapped to all-in and been called. Before the rule for raises the graph cannot hold it was 142 of 5,679. Tables without a bot that raises a third of the time at any size should lose far fewer, and each evaluation reports its own share.

### Evaluating a full table

`blueprint evaluate` reads the table size from the candidate’s abstraction. At six seats a **deal** is one deck played six times: the candidate sits in each seat in turn against five copies of the opponent, the button staying in seat 0, from fresh stacks. The deal’s value is the candidate’s mean winnings over the six hands, and the interval is over deals, as heads-up. Five calling stations and a sixth score exactly zero. The report adds the candidate’s result in each position. The gate is unchanged: at 100 big blinds the lower bound of the 95% interval must be above zero against a table of RiverMind Easy and against a table of calling stations, for the checkpoint and for the bundle. A replacement plays alone against five copies of the champion.

One bot against five copies of another is the only arrangement measured. It answers “does this bot win at a table of those?”, which is what a guest sitting with bots meets; it does not rank two trained bots against a mixed field.

### Serving bundles for a graph

A multiway bundle is **format 2**. Its `strategy.u8` and card-table arrays are as before. Its `trees.json` stores each graph in columns, since a list per node would make Node hold a million small arrays: `player`, `street`, `offset`, `contribution` and `live` (a bit mask of seats) a node; `children` as one flat list, each node’s run following the last, with its length the size of the node’s token set; `tokens` and `measure` as indexes into `token_sets` (6 of them) and `measure_sets` (about 2,000); `spr`; the nodes that open each street; and the terminals’ kind, chips each, pot and seats. A reader rebuilds the graph’s SHA-256 from those columns alone, which `test_a_six_seat_bundle_is_format_two_and_plays` does.

**In TypeScript (P5.7).** [`loadBundle`](../web/src/lib/server/bots/bundle.ts) reads format 2 into typed arrays and checks each graph’s recomputed SHA-256 against the manifest, and [`MultiwayBlueprintPolicy`](../web/src/lib/server/bots/multiway.ts) is a port of the Python policy. [`compileGraph`](../web/src/lib/server/bots/tree.ts) compiles the graphs from the TypeScript engine, in 2.4 s and 5.8 s, to the same SHA-256s as Python: the two engines agree on every betting state of the six-seat game. `pnpm bots:parity` plays a format 2 bundle in both languages at tables of three to six with the blueprint in one or more seats, at random stacks and blinds; without `--multiway-bundle` it uses a synthetic bundle of the 50 big blind graph. On 2026-11-22, over 20,005 decisions in 4,357 hands, the probabilities, statistics and hand records were identical (`--multiway-decisions 20000`; 179 decisions lost, 0.9%). Serving a six-seat champion on the site, and giving a six-seat table’s two-player hands to the heads-up champion, wait for a champion.

The 6-max bundle will be about 0.9 GB: 438 MB of strategy, 400 MB of card tables and the graphs. With the heads-up champion’s 0.5 GB that is most of the web unit’s 2 GB `MemoryHigh`, so P5.7 measures it on ubuntu-vm before anything is served and raises the limit if it must; the host now has 15 GB.

### Nine seats

Not designed yet, and `6max-s1`’s sizes will not stretch to it. The merged graph grows by a factor of four to five a seat at 100 big blinds: 3,762 states at three seats, 28,964 at four, 152,981 at five and 654,597 at six. At seven seats it is 2,417,164: 479 million info sets with 200 buckets and 11.7 GB of training tables for the 100 big blind class alone, more than both of six seats’ classes together (one process, 148 s). The factor falls as seats are added (7.7, 5.3, 4.3, 3.7), and if it keeps falling that way nine seats is on the order of 20 to 25 million states: four to five billion info sets, over 100 GB of tables and a run some twenty-five times the six-seat one. That does not fit this Mac’s 32 GB, whatever the patience (Q-5).

So the nine-seat design has a real choice to make, and it is not made here. The options to weigh, each with a measurement to take first: (1) play the last six positions of a nine-seat hand on the six-seat blueprint, which is exact once the first three seats have folded, and train only a small pre-flop strategy for those three seats; (2) a coarser nine-seat graph of its own, with candidate A’s sizes and 50 buckets a street, which is about a tenth of the tables above and still far more than six seats; (3) merge further, treating seats that have only called as interchangeable. The first is the cheapest and reuses a champion that will already have passed its gate; its cost is every hand in which an early seat stays in. Nine seats stays open in P5.6 until six seats has a champion.

## References

- Ganzfried, S. and Sandholm, T. (2013). *Action translation in extensive-form games with large action spaces: axioms, paradoxes, and the pseudo-harmonic mapping.* IJCAI.
- Johanson, M., Burch, N., Valenzano, R. and Bowling, M. (2013). *Evaluating state-space abstractions in extensive-form games.* AAMAS.
- Lanctot, M., Waugh, K., Zinkevich, M. and Bowling, M. (2009). *Monte Carlo sampling for regret minimization in extensive games.* NeurIPS.
- Waugh, K. (2013). *A fast and optimal hand isomorphism algorithm.* AAAI Workshop on Computer Poker and Incomplete Information.
- Brown, N. and Sandholm, T. (2019). *Superhuman AI for multiplayer poker.* Science 365(6456). (Pluribus: linear CFR, pruning and imperfect-recall abstractions.)
