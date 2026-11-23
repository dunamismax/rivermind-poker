# Evaluation: 6max-s1-s0-1000m-served

Candidate: the serving bundle `artifacts/bundles/6max-s1-s0-1000m`, 1,000,000,000 iterations: the strategy the site serves, rounded to multiples of 1/255 (`strategy.u8` `3bb9da18…`), on the bundle’s own card tables (table set `085cfca5…`).
Game: no-limit Texas hold'em, 52-card deck, 6 seats, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played 6 times, the candidate once in every seat against 5 copies of the opponent, fresh stacks each hand.
Seed 0, 20,000 deals (120,000 hands) per matchup; evaluated at `99c0a23`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +18.08 | +12.66 to +23.51 | +63.42 | +2.54 | 99.9% |
| calling_station | 100 | +567.65 | +510.86 to +624.44 | +770.73 | +402.68 | 80.5% |
| random | 100 | +558.02 | +522.11 to +593.93 | +598.57 | +709.59 | 91.0% |
| min_bettor | 100 | +355.06 | +305.70 to +404.42 | +481.92 | +280.92 | 87.5% |
| heuristic | 40 | +14.27 | +11.16 to +17.38 | +45.05 | -2.44 | 99.9% |
| heuristic | 150 | +25.34 | +18.04 to +32.65 | +72.97 | +14.78 | 99.9% |
| calling_station | 40 | +225.31 | +201.76 to +248.86 | +260.67 | +139.77 | 80.7% |
| calling_station | 150 | +847.94 | +762.59 to +933.29 | +1153.98 | +618.56 | 80.5% |
| bundle:artifacts/models/6max-s1-s0-100m/bundle | 100 | +16.37 | +8.78 to +23.96 | +65.73 | -27.68 | 100.0% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

The candidate’s result in each seat, in big blinds per 100 hands:

| Opponent | Stacks (bb) | button | small blind | big blind | utg | hijack | cutoff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +63.42 | -7.34 | +2.54 | +10.12 | +19.73 | +20.04 |
| calling_station | 100 | +770.73 | +703.70 | +402.68 | +737.48 | +508.86 | +282.45 |
| random | 100 | +598.57 | +660.54 | +709.59 | +561.89 | +390.90 | +426.61 |
| min_bettor | 100 | +481.92 | +462.49 | +280.92 | +416.92 | +244.24 | +243.88 |
| heuristic | 40 | +45.05 | -8.71 | -2.44 | +12.94 | +20.08 | +18.69 |
| heuristic | 150 | +72.97 | -0.34 | +14.78 | +13.09 | +25.65 | +25.90 |
| calling_station | 40 | +260.67 | +236.28 | +139.77 | +345.49 | +221.17 | +148.50 |
| calling_station | 150 | +1153.98 | +1075.32 | +618.56 | +1088.48 | +745.36 | +405.95 |
| bundle:artifacts/models/6max-s1-s0-100m/bundle | 100 | +65.73 | -2.38 | -27.68 | +32.09 | +21.43 | +9.05 |

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/bundles/6max-s1-s0-1000m --name 6max-s1-s0-1000m-served --out docs/evaluations --deals 20000 --seed 0 --against heuristic@100 --against calling_station@100 --against random@100 --against min_bettor@100 --against heuristic@40 --against heuristic@150 --against calling_station@40 --against calling_station@150 --against bundle:artifacts/models/6max-s1-s0-100m/bundle@100
```
