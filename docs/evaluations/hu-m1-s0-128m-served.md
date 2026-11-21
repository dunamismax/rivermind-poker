# Evaluation: hu-m1-s0-128m-served

Candidate: the serving bundle `artifacts/bundles/hu-m1-s0-128m`, 128,000,000 iterations: the strategy the site serves, rounded to multiples of 1/255 (`strategy.u8` `ec57ac6f…`), on the bundle’s own card tables (table set `4ff8b0ef…`).
Game: no-limit Texas hold'em, 52-card deck, heads-up, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played twice with the seats swapped, fresh stacks each hand.
Seed 0, 20,000 deals (40,000 hands) per matchup; evaluated at `2ea0f41`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +60.74 | +50.53 to +70.96 | +71.89 | +49.60 | 100.0% |
| calling_station | 100 | +307.13 | +288.19 to +326.07 | +365.31 | +248.96 | 100.0% |
| random | 100 | +240.07 | +218.03 to +262.11 | +261.63 | +218.52 | 100.0% |
| min_bettor | 100 | +389.48 | +361.84 to +417.12 | +404.80 | +374.16 | 100.0% |
| heuristic | 40 | +43.79 | +38.05 to +49.54 | +48.49 | +39.10 | 100.0% |
| heuristic | 150 | +73.36 | +59.37 to +87.36 | +89.97 | +56.76 | 100.0% |
| calling_station | 40 | +210.10 | +198.92 to +221.28 | +226.39 | +193.80 | 100.0% |
| calling_station | 150 | +385.13 | +358.39 to +411.87 | +476.31 | +293.96 | 100.0% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/bundles/hu-m1-s0-128m --name hu-m1-s0-128m-served --out docs/evaluations --deals 20000 --seed 0
```
