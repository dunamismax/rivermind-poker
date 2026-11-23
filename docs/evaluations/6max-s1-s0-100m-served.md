# Evaluation: 6max-s1-s0-100m-served

Candidate: the serving bundle `artifacts/bundles/6max-s1-s0-100m`, 100,032,000 iterations: the strategy the site serves, rounded to multiples of 1/255 (`strategy.u8` `0f1790c3…`), on the bundle’s own card tables (table set `085cfca5…`).
Game: no-limit Texas hold'em, 52-card deck, 6 seats, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played 6 times, the candidate once in every seat against 5 copies of the opponent, fresh stacks each hand.
Seed 0, 20,000 deals (120,000 hands) per matchup; evaluated at `6d93580`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +21.14 | +15.46 to +26.83 | +65.76 | +9.50 | 99.9% |
| calling_station | 100 | +510.84 | +452.95 to +568.73 | +675.60 | +222.26 | 75.9% |
| random | 100 | +669.38 | +630.48 to +708.28 | +723.61 | +882.29 | 88.3% |
| min_bettor | 100 | +354.63 | +301.10 to +408.17 | +347.37 | +111.42 | 81.5% |
| heuristic | 40 | +12.45 | +9.39 to +15.51 | +32.92 | -4.02 | 99.8% |
| heuristic | 150 | +26.33 | +18.42 to +34.24 | +72.26 | +14.42 | 99.9% |
| calling_station | 40 | +210.98 | +187.46 to +234.50 | +211.22 | +108.29 | 75.9% |
| calling_station | 150 | +764.19 | +677.09 to +851.30 | +1009.60 | +340.63 | 75.9% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

The candidate’s result in each seat, in big blinds per 100 hands:

| Opponent | Stacks (bb) | button | small blind | big blind | utg | hijack | cutoff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +65.76 | -13.48 | +9.50 | +14.12 | +22.16 | +28.78 |
| calling_station | 100 | +675.60 | +738.08 | +222.26 | +623.46 | +390.82 | +414.81 |
| random | 100 | +723.61 | +794.07 | +882.29 | +585.70 | +509.49 | +521.13 |
| min_bettor | 100 | +347.37 | +461.71 | +111.42 | +381.82 | +335.08 | +490.40 |
| heuristic | 40 | +32.92 | -7.30 | -4.02 | +15.33 | +21.01 | +16.77 |
| heuristic | 150 | +72.26 | -11.94 | +14.42 | +21.32 | +29.63 | +32.28 |
| calling_station | 40 | +211.22 | +165.33 | +108.29 | +296.12 | +254.55 | +230.38 |
| calling_station | 150 | +1009.60 | +1127.08 | +340.63 | +917.46 | +574.82 | +615.56 |

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/bundles/6max-s1-s0-100m --name 6max-s1-s0-100m-served --out docs/evaluations --deals 20000 --seed 0
```
