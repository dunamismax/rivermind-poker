# Evaluation: 9max-o1-s0-served

Candidate: the nine-seat model `artifacts/bundles/9max-o1-s0` (9max-o1, bundle, 30,000,000 deals of training): its early-seat table, its strategy rounded to multiples of 1/255, as the site serves it, on the six-seat serving bundle `artifacts/models/6max-s1-s0-3600m/bundle` (3,600,000,000 iterations, `strategy.u8` `32fdd163…`).
Game: no-limit Texas hold'em, 52-card deck, 9 seats, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played 9 times, the candidate once in every seat against 8 copies of the opponent, fresh stacks each hand.
Seed 0, 20,000 deals (180,000 hands) per matchup; evaluated at `ba1bba9`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +6.48 | +2.16 to +10.81 | +36.87 | -35.92 | 99.9% |
| calling_station | 100 | +1254.71 | +1207.46 to +1301.95 | +1048.89 | +2741.63 | 25.9% |
| random | 100 | +123.13 | +93.18 to +153.08 | +128.02 | +154.71 | 70.0% |
| min_bettor | 100 | +420.82 | +384.06 to +457.58 | +271.75 | +100.20 | 37.5% |
| heuristic | 40 | +7.43 | +4.98 to +9.88 | +29.44 | -32.61 | 99.9% |
| heuristic | 150 | +12.25 | +6.52 to +17.99 | +50.77 | -27.40 | 99.9% |
| calling_station | 40 | +561.26 | +541.20 to +581.32 | +468.27 | +1344.02 | 26.5% |
| calling_station | 150 | +1705.97 | +1637.93 to +1774.02 | +1421.64 | +3503.62 | 25.8% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

The candidate’s result in each seat, in big blinds per 100 hands:

| Opponent | Stacks (bb) | button | small blind | big blind | utg | utg+1 | utg+2 | lojack | hijack | cutoff |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +36.87 | -8.61 | -35.92 | +14.33 | +7.62 | -3.98 | +16.91 | +13.16 | +17.96 |
| calling_station | 100 | +1048.89 | +933.53 | +2741.63 | +1143.05 | +1306.66 | +1487.21 | +766.47 | +822.59 | +1042.33 |
| random | 100 | +128.02 | +76.61 | +154.71 | +430.97 | +367.29 | +120.29 | -132.57 | -55.39 | +18.23 |
| min_bettor | 100 | +271.75 | +315.83 | +100.20 | +521.81 | +811.61 | +745.77 | +595.66 | +189.59 | +235.12 |
| heuristic | 40 | +29.44 | -12.87 | -32.61 | +13.93 | +10.33 | +4.99 | +12.82 | +17.32 | +23.52 |
| heuristic | 150 | +50.77 | +0.49 | -27.40 | +18.70 | +10.29 | -6.82 | +24.29 | +15.83 | +24.14 |
| calling_station | 40 | +468.27 | +374.31 | +1344.02 | +488.97 | +598.75 | +523.52 | +385.66 | +388.06 | +479.77 |
| calling_station | 150 | +1421.64 | +1277.65 | +3503.62 | +1582.65 | +1835.11 | +2072.17 | +1073.87 | +1146.59 | +1440.45 |

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/bundles/9max-o1-s0 --name 9max-o1-s0-served --out docs/evaluations --deals 20000 --seed 0
```
