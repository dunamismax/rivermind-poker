# Evaluation: hu-m1-s0-1280m-served

Candidate: the serving bundle `artifacts/bundles/hu-m1-s0-1280m`, 1,280,000,000 iterations: the strategy the site serves, rounded to multiples of 1/255 (`strategy.u8` `e5c6feca…`), on the bundle’s own card tables (table set `4ff8b0ef…`).
Game: no-limit Texas hold'em, 52-card deck, heads-up, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played twice with the seats swapped, fresh stacks each hand.
Seed 0, 20,000 deals (40,000 hands) per matchup; evaluated at `c4333af`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +57.14 | +48.56 to +65.73 | +64.83 | +49.46 | 100.0% |
| calling_station | 100 | +223.64 | +207.67 to +239.61 | +246.97 | +200.31 | 100.0% |
| random | 100 | +210.78 | +189.83 to +231.73 | +222.42 | +199.14 | 100.0% |
| min_bettor | 100 | +259.35 | +234.79 to +283.92 | +241.90 | +276.81 | 100.0% |
| heuristic | 40 | +43.24 | +37.99 to +48.49 | +46.38 | +40.09 | 100.0% |
| heuristic | 150 | +68.05 | +56.68 to +79.42 | +78.58 | +57.51 | 100.0% |
| calling_station | 40 | +171.58 | +161.12 to +182.04 | +176.91 | +166.25 | 100.0% |
| calling_station | 150 | +264.89 | +242.98 to +286.80 | +298.72 | +231.06 | 100.0% |
| bundle:artifacts/models/hu-m1-s0-1024m/bundle | 100 | +6.59 | -3.08 to +16.27 | +12.68 | +0.51 | 100.0% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/bundles/hu-m1-s0-1280m --name hu-m1-s0-1280m-served --out docs/evaluations --deals 20000 --seed 0 --against heuristic@100 --against calling_station@100 --against random@100 --against min_bettor@100 --against heuristic@40 --against heuristic@150 --against calling_station@40 --against calling_station@150 --against bundle:artifacts/models/hu-m1-s0-1024m/bundle@100
```
