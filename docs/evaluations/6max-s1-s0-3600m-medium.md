# Evaluation: 6max-s1-s0-3600m-medium

Candidate: RiverMind Medium, which plays each hand as the serving bundle `artifacts/models/6max-s1-s0-3600m/bundle` (3,600,000,000 iterations, `strategy.u8` `32fdd163…`) with probability 0.5 and as RiverMind Easy (the heuristic) otherwise, drawn once a hand (`rivermind/bots/levels.py`). “Trained data” counts the model’s decisions only.
Game: no-limit Texas hold'em, 52-card deck, 6 seats, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played 6 times, the candidate once in every seat against 5 copies of the opponent, fresh stacks each hand.
Seed 0, 20,000 deals (120,000 hands) per matchup; evaluated at `6ad4fcb`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +9.64 | +5.61 to +13.66 | +34.12 | +4.91 | 99.9% |
| calling_station | 100 | +773.54 | +725.49 to +821.58 | +590.01 | +1453.77 | 82.7% |
| random | 100 | +338.77 | +311.71 to +365.83 | +326.54 | +490.03 | 91.9% |
| min_bettor | 100 | +269.01 | +232.35 to +305.68 | +331.50 | +203.66 | 90.3% |
| bundle:artifacts/models/6max-s1-s0-3600m/bundle | 100 | -5.30 | -9.87 to -0.74 | +26.22 | -61.90 | 100.0% |
| heuristic | 40 | +7.68 | +5.46 to +9.89 | +28.14 | +1.78 | 100.0% |
| heuristic | 150 | +11.01 | +5.66 to +16.35 | +36.85 | +10.50 | 99.9% |
| calling_station | 40 | +343.60 | +323.16 to +364.05 | +291.52 | +704.91 | 83.9% |
| calling_station | 150 | +1104.23 | +1032.82 to +1175.64 | +847.76 | +2043.65 | 82.7% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

The candidate’s result in each seat, in big blinds per 100 hands:

| Opponent | Stacks (bb) | button | small blind | big blind | utg | hijack | cutoff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +34.12 | -31.08 | +4.91 | +5.46 | +20.66 | +23.74 |
| calling_station | 100 | +590.01 | +676.56 | +1453.77 | +677.36 | +662.94 | +580.59 |
| random | 100 | +326.54 | +372.11 | +490.03 | +337.84 | +249.56 | +256.56 |
| min_bettor | 100 | +331.50 | +382.46 | +203.66 | +289.86 | +209.47 | +197.13 |
| bundle:artifacts/models/6max-s1-s0-3600m/bundle | 100 | +26.22 | -31.39 | -61.90 | +13.59 | +7.91 | +13.76 |
| heuristic | 40 | +28.14 | -27.15 | +1.78 | +8.09 | +17.56 | +17.64 |
| heuristic | 150 | +36.85 | -32.63 | +10.50 | +4.74 | +19.94 | +26.65 |
| calling_station | 40 | +291.52 | +226.81 | +704.91 | +303.17 | +293.73 | +241.48 |
| calling_station | 150 | +847.76 | +1012.56 | +2043.65 | +970.16 | +925.62 | +825.65 |

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/models/6max-s1-s0-3600m/bundle --name 6max-s1-s0-3600m-medium --out docs/evaluations --deals 20000 --seed 0 --against heuristic@100 --against calling_station@100 --against random@100 --against min_bettor@100 --against bundle:artifacts/models/6max-s1-s0-3600m/bundle@100 --against heuristic@40 --against heuristic@150 --against calling_station@40 --against calling_station@150 --level medium
```
