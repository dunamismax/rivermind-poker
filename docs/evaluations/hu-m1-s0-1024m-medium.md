# Evaluation: hu-m1-s0-1024m-medium

Candidate: RiverMind Medium, which plays each hand as the serving bundle `artifacts/models/hu-m1-s0-1024m/bundle` (1,024,000,000 iterations, `strategy.u8` `31a782ea…`) with probability 0.5 and as RiverMind Easy (the heuristic) otherwise, drawn once a hand (`rivermind/bots/levels.py`). “Trained data” counts the model’s decisions only.
Game: no-limit Texas hold'em, 52-card deck, heads-up, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played twice with the seats swapped, fresh stacks each hand.
Seed 0, 20,000 deals (40,000 hands) per matchup; evaluated at `5a93b0c`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +26.51 | +20.27 to +32.75 | +11.65 | +41.37 | 100.0% |
| calling_station | 100 | +261.93 | +246.94 to +276.92 | +191.84 | +332.02 | 100.0% |
| random | 100 | +188.95 | +170.11 to +207.79 | +146.07 | +231.83 | 100.0% |
| min_bettor | 100 | +167.94 | +148.19 to +187.69 | +176.95 | +158.93 | 100.0% |
| bundle:artifacts/models/hu-m1-s0-1024m/bundle | 100 | -38.36 | -48.14 to -28.58 | -34.07 | -42.65 | 100.0% |
| heuristic | 40 | +21.04 | +17.25 to +24.83 | +2.95 | +39.13 | 100.0% |
| heuristic | 150 | +30.07 | +21.67 to +38.47 | +16.75 | +43.39 | 100.0% |
| calling_station | 40 | +201.80 | +191.90 to +211.71 | +130.91 | +272.70 | 100.0% |
| calling_station | 150 | +282.68 | +263.93 to +301.43 | +217.84 | +347.52 | 100.0% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/models/hu-m1-s0-1024m/bundle --name hu-m1-s0-1024m-medium --out docs/evaluations --deals 20000 --seed 0 --against heuristic@100 --against calling_station@100 --against random@100 --against min_bettor@100 --against bundle:artifacts/models/hu-m1-s0-1024m/bundle@100 --against heuristic@40 --against heuristic@150 --against calling_station@40 --against calling_station@150 --level medium
```
