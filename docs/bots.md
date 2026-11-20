# RiverMind bot design

This is the design for RiverMind’s trained no-limit bots (P5.1). It fixes the game the first champion plays, its action and card abstractions, how real bets map onto them, the info-set key, and memory and time estimates for training it on this Mac (Q-5). Later steps build it: card tables at P5.2, training at P5.3, evaluation at P5.4, promotion at P5.5 and serving at P5.7a. They change this page when a measurement shows a choice was wrong, and say so in the handoff log. Estimates for 6-max and 9-max are added at P5.6.

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
- **Folds, checks and calls** need no mapping. A call of an off-tree bet is the call of the mapped bet.

**The bot’s own sizes.** The chosen abstract size is computed from the **real** pot, current bet and stacks with the size rules above, rounded to whole chips and clamped to the legal minimum and maximum (`LegalActions.min_to` and `max_to`). All-in is `max_to`.

**Re-entering the tree.** Mapping can leave the abstract history with no decision left while the real hand goes on, for example after a real raise mapped to an all-in that the bot called with chips behind. Then the bot restarts the current street at the abstract node with an empty history on that street whose ratio of stack to pot is closest to the real one (by the absolute difference of their logarithms) and continues from there. Its card bucket does not depend on the history, so nothing else changes.

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

**Integer form.** The tree for each depth class is compiled in a fixed depth-first order, children in action order, and each decision node gets an offset within its street. A node with *n* actions owns *n* consecutive slots, and a street’s width *W* is the total of its nodes’ actions. The slot of action *i* at node *v* for bucket *b* is `b × W(street) + offset(v) + i` in that street’s array. Regrets and average-strategy sums live in one array per depth class and street, so every info set that can occur has room from the start and nothing is hashed during training.

A checkpoint’s manifest records the SHA-256 of the compiled trees (each node’s history and actions), so a checkpoint can never be loaded against a tree that numbers its slots differently. It sits beside the card tables’ hashes (P5.3).

## What training and serving assume

These choices belong to P5.3 and P5.7a. They are fixed enough here to make the estimates meaningful.

- **Trainer:** external-sampling Monte Carlo CFR on the compiled tree: one deal per iteration, every action of the updated player explored, the opponent’s and chance’s sampled. It uses linear discounting early and negative-regret pruning later, with a floor on regrets, as in Pluribus. Regrets are `int32` and average-strategy sums `float32`.
- **Deals in batches:** cards and their six bucket lookups are drawn for thousands of iterations at once with NumPy, so a table lookup costs microseconds, not a Python call per card.
- **Exact resume with several cores (RM-02, RM-04):** workers run a batch of iterations against a read-only snapshot of the shared arrays, each from its own seeded generator. They return their regret and strategy changes, and the main process adds them in worker order before the next batch. A run is then a pure function of its settings and seed, resumes exactly at any batch boundary and checkpoints consistently. The price is that updates within a batch see slightly stale regrets. P5.3 measures what that costs in speed.
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

- **Card tables (P5.2, measured).** A full build takes 3 to 5 minutes and peaks at 2.3 to 3.1 GB summed over its processes, about a tenth of the hour estimated here before P5.2. With six workers it took 200 s and 2.3 GB: river equities 25 s, turn and flop histograms 5 and 7 s, turn k-means 91 s, flop k-means 70 s. With ten workers it took 289 s and 3.1 GB, while other tests ran. The river equity step costs 0.62 ms a board. The histograms are cheap because they reuse the river rows; most of the time is k-means.
- **Training (P5.3).** As a planning rule, aim for an average of 1,000 updates per info set; P5.3 stops on measured progress, not on this number. That is 11,671,436 × 1,000 / 13.9 ≈ 840 million iterations at 100 big blinds and 5,438,760 × 1,000 / 10.8 ≈ 504 million at 50. At the prototype’s ten-process rate that is about 2.1 hours at 100 big blinds and 0.8 hours at 50 (whose iterations are about 1.5 times faster). Allowing three times for the real trainer’s lookups, batch merging, checkpoints and evaluation snapshots, the first heads-up blueprint is **about 9 hours of training: one overnight run**. Budget 24 hours of wall-clock time including restarts.
- **Scaling up.** The large tree with 4,000 buckets a street has about 208 million info sets at 100 big blinds and updates 25.2 per iteration. That is about 8.2 billion iterations, around 5 days on this Mac by the same rule. It is a reasonable second run if the first champion leaves visible weaknesses. Neither run needs other machines (Q-5).

**What could make these wrong.** Real regrets concentrate on a few actions, so later iterations visit fewer nodes and run faster, and pruning speeds them up again. Batch merging and shared arrays add overhead that the prototype did not have. Turn and river nodes on rare lines get far fewer than the average number of updates. Each of these is measured at P5.3.

## Table sets

Built sets live under `artifacts/` (ignored by Git), so a checkpoint’s manifest names the set by these hashes. Build one with `uv run --locked rivermind-poker tables build` and check it with `rivermind-poker tables verify`.

| Set | Settings | Bucket files (SHA-256) |
| --- | --- | --- |
| `hu-m1`, seed 0 | 169, 1,000, 1,000 and 1,000 buckets; 50 bins; k-means fitted on 500,000 hands, at most 300 iterations; Python 3.12.15, NumPy 2.5.5 | `preflop.npy` `a0a6e5ed…8d8304c9`, `flop.npy` `947731ea…aea03bab`, `turn.npy` `cd14176b…aeb5bc3c`, `river.npy` `756d746b…84eb34ae` |

The full hashes of every file are in the set’s `manifest.json`. Two builds with 10 and 6 workers gave byte-identical files.

## 6-max and 9-max

Added at P5.6, after the heads-up pipeline has produced a champion. The same abstraction scheme extends to more seats, but the history grows with every player, and position needs a place in the key. P5.6 records the new tree sizes, estimates and results.

## References

- Ganzfried, S. and Sandholm, T. (2013). *Action translation in extensive-form games with large action spaces: axioms, paradoxes, and the pseudo-harmonic mapping.* IJCAI.
- Johanson, M., Burch, N., Valenzano, R. and Bowling, M. (2013). *Evaluating state-space abstractions in extensive-form games.* AAMAS.
- Lanctot, M., Waugh, K., Zinkevich, M. and Bowling, M. (2009). *Monte Carlo sampling for regret minimization in extensive games.* NeurIPS.
- Waugh, K. (2013). *A fast and optimal hand isomorphism algorithm.* AAAI Workshop on Computer Poker and Incomplete Information.
- Brown, N. and Sandholm, T. (2019). *Superhuman AI for multiplayer poker.* Science 365(6456). (Pluribus: linear CFR, pruning and imperfect-recall abstractions.)
