# Evaluation: 6max-s1-s0-3600m-served

Candidate: the serving bundle `artifacts/bundles/6max-s1-s0-3600m`, 3,600,000,000 iterations: the strategy the site serves, rounded to multiples of 1/255 (`strategy.u8` `32fdd163…`), on the bundle’s own card tables (table set `085cfca5…`).
Game: no-limit Texas hold'em, 52-card deck, 6 seats, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played 6 times, the candidate once in every seat against 5 copies of the opponent, fresh stacks each hand.
Seed 0, 20,000 deals (120,000 hands) per matchup; evaluated at `e9562af`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +20.30 | +15.02 to +25.59 | +68.17 | +7.12 | 99.9% |
| calling_station | 100 | +596.27 | +540.14 to +652.41 | +564.14 | +587.00 | 82.6% |
| random | 100 | +514.65 | +479.88 to +549.41 | +517.14 | +701.17 | 92.1% |
| min_bettor | 100 | +353.99 | +306.63 to +401.34 | +439.19 | +268.25 | 90.3% |
| heuristic | 40 | +14.60 | +11.54 to +17.67 | +45.35 | -5.03 | 100.0% |
| heuristic | 150 | +27.60 | +20.60 to +34.59 | +76.81 | +18.52 | 99.9% |
| calling_station | 40 | +240.55 | +217.22 to +263.89 | +231.80 | +190.99 | 83.7% |
| calling_station | 150 | +891.23 | +806.89 to +975.57 | +839.14 | +898.88 | 82.6% |
| bundle:artifacts/models/6max-s1-s0-1000m/bundle | 100 | +7.35 | +2.34 to +12.37 | +49.13 | -39.25 | 100.0% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

The candidate’s result in each seat, in big blinds per 100 hands:

| Opponent | Stacks (bb) | button | small blind | big blind | utg | hijack | cutoff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +68.17 | -7.45 | +7.12 | +14.86 | +14.65 | +24.48 |
| calling_station | 100 | +564.14 | +723.25 | +587.00 | +737.21 | +610.83 | +355.22 |
| random | 100 | +517.14 | +653.50 | +701.17 | +473.15 | +353.01 | +389.92 |
| min_bettor | 100 | +439.19 | +589.24 | +268.25 | +360.66 | +251.08 | +215.50 |
| heuristic | 40 | +45.35 | -8.56 | -5.03 | +12.97 | +20.65 | +22.24 |
| heuristic | 150 | +76.81 | -0.79 | +18.52 | +20.49 | +20.13 | +30.42 |
| calling_station | 40 | +231.80 | +236.54 | +190.99 | +352.56 | +273.13 | +158.30 |
| calling_station | 150 | +839.14 | +1100.62 | +898.88 | +1091.46 | +899.08 | +518.22 |
| bundle:artifacts/models/6max-s1-s0-1000m/bundle | 100 | +49.13 | -16.94 | -39.25 | +9.24 | +17.33 | +24.62 |

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/bundles/6max-s1-s0-3600m --name 6max-s1-s0-3600m-served --out docs/evaluations --deals 20000 --seed 0 --against heuristic@100 --against calling_station@100 --against random@100 --against min_bettor@100 --against heuristic@40 --against heuristic@150 --against calling_station@40 --against calling_station@150 --against bundle:artifacts/models/6max-s1-s0-1000m/bundle@100
```
