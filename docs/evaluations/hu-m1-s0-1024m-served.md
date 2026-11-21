# Evaluation: hu-m1-s0-1024m-served

Candidate: the serving bundle `artifacts/bundles/hu-m1-s0-1024m`, 1,024,000,000 iterations: the strategy the site serves, rounded to multiples of 1/255 (`strategy.u8` `31a782ea…`), on the bundle’s own card tables (table set `4ff8b0ef…`).
Game: no-limit Texas hold'em, 52-card deck, heads-up, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played twice with the seats swapped, fresh stacks each hand.
Seed 0, 20,000 deals (40,000 hands) per matchup; evaluated at `2ea0f41`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +58.79 | +50.09 to +67.48 | +69.02 | +48.55 | 100.0% |
| calling_station | 100 | +224.92 | +208.64 to +241.20 | +245.73 | +204.10 | 100.0% |
| random | 100 | +209.67 | +188.65 to +230.68 | +223.41 | +195.92 | 100.0% |
| min_bettor | 100 | +268.94 | +244.13 to +293.76 | +261.19 | +276.69 | 100.0% |
| heuristic | 40 | +41.91 | +36.65 to +47.17 | +43.38 | +40.44 | 100.0% |
| heuristic | 150 | +70.27 | +58.72 to +81.83 | +84.26 | +56.29 | 100.0% |
| calling_station | 40 | +173.79 | +163.27 to +184.31 | +178.58 | +169.00 | 100.0% |
| calling_station | 150 | +265.92 | +243.48 to +288.35 | +294.98 | +236.85 | 100.0% |
| bundle:artifacts/models/hu-m1-s0-128m/bundle | 100 | +21.14 | +10.45 to +31.84 | +26.59 | +15.70 | 100.0% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/bundles/hu-m1-s0-1024m --name hu-m1-s0-1024m-served --out docs/evaluations --deals 20000 --seed 0 --against heuristic@100 --against calling_station@100 --against random@100 --against min_bettor@100 --against heuristic@40 --against heuristic@150 --against calling_station@40 --against calling_station@150 --against bundle:artifacts/models/hu-m1-s0-128m/bundle@100
```
