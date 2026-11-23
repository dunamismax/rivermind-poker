# Evaluation: 6max-s1-s0-100m-medium

Candidate: RiverMind Medium, which plays each hand as the serving bundle `artifacts/models/6max-s1-s0-100m/bundle` (100,032,000 iterations, `strategy.u8` `0f1790c3…`) with probability 0.5 and as RiverMind Easy (the heuristic) otherwise, drawn once a hand (`rivermind/bots/levels.py`). “Trained data” counts the model’s decisions only.
Game: no-limit Texas hold'em, 52-card deck, 6 seats, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played 6 times, the candidate once in every seat against 5 copies of the opponent, fresh stacks each hand.
Seed 0, 20,000 deals (120,000 hands) per matchup; evaluated at `8eb1988`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +11.27 | +6.97 to +15.58 | +44.74 | +1.59 | 99.9% |
| calling_station | 100 | +668.49 | +619.11 to +717.88 | +636.45 | +1274.65 | 76.2% |
| random | 100 | +432.42 | +402.43 to +462.42 | +422.36 | +632.58 | 88.4% |
| min_bettor | 100 | +240.57 | +198.98 to +282.16 | +143.28 | +249.46 | 81.3% |
| bundle:artifacts/models/6max-s1-s0-100m/bundle | 100 | -10.68 | -18.22 to -3.14 | +26.51 | -94.47 | 100.0% |
| heuristic | 40 | +5.82 | +3.56 to +8.08 | +26.39 | -6.01 | 99.8% |
| heuristic | 150 | +14.58 | +8.68 to +20.48 | +53.19 | +6.76 | 99.9% |
| calling_station | 40 | +320.22 | +299.42 to +341.02 | +276.89 | +657.54 | 76.1% |
| calling_station | 150 | +945.56 | +872.00 to +1019.12 | +921.20 | +1768.27 | 76.2% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

The candidate’s result in each seat, in big blinds per 100 hands:

| Opponent | Stacks (bb) | button | small blind | big blind | utg | hijack | cutoff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +44.74 | -23.40 | +1.59 | +7.33 | +11.35 | +26.03 |
| calling_station | 100 | +636.45 | +474.81 | +1274.65 | +518.63 | +536.34 | +570.08 |
| random | 100 | +422.36 | +486.97 | +632.58 | +402.63 | +339.53 | +310.47 |
| min_bettor | 100 | +143.28 | +278.49 | +249.46 | +276.66 | +205.69 | +289.82 |
| bundle:artifacts/models/6max-s1-s0-100m/bundle | 100 | +26.51 | -48.13 | -94.47 | +1.74 | +33.76 | +16.50 |
| heuristic | 40 | +26.39 | -26.72 | -6.01 | +8.18 | +14.63 | +18.43 |
| heuristic | 150 | +53.19 | -21.77 | +6.76 | +5.00 | +11.57 | +32.75 |
| calling_station | 40 | +276.89 | +191.59 | +657.54 | +249.68 | +277.10 | +268.50 |
| calling_station | 150 | +921.20 | +708.56 | +1768.27 | +726.68 | +739.51 | +809.14 |

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/models/6max-s1-s0-100m/bundle --name 6max-s1-s0-100m-medium --out docs/evaluations --deals 20000 --seed 0 --against heuristic@100 --against calling_station@100 --against random@100 --against min_bettor@100 --against bundle:artifacts/models/6max-s1-s0-100m/bundle@100 --against heuristic@40 --against heuristic@150 --against calling_station@40 --against calling_station@150 --level medium
```
