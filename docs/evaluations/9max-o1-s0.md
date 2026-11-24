# Evaluation: 9max-o1-s0

Candidate: the nine-seat model `artifacts/nine/9max-o1-s0` (9max-o1, checkpoint, 30,000,000 deals of training): its early-seat table, its average strategy, on the six-seat serving bundle `artifacts/models/6max-s1-s0-3600m/bundle` (3,600,000,000 iterations, `strategy.u8` `32fdd163…`).
Game: no-limit Texas hold'em, 52-card deck, 9 seats, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played 9 times, the candidate once in every seat against 8 copies of the opponent, fresh stacks each hand.
Seed 0, 20,000 deals (180,000 hands) per matchup; evaluated at `ba1bba9`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +6.71 | +2.39 to +11.02 | +36.87 | -35.92 | 99.9% |
| calling_station | 100 | +1254.81 | +1207.56 to +1302.06 | +1048.89 | +2741.63 | 25.9% |
| random | 100 | +122.25 | +92.26 to +152.23 | +128.02 | +154.71 | 70.0% |
| min_bettor | 100 | +421.86 | +385.08 to +458.64 | +271.75 | +100.20 | 37.5% |
| heuristic | 40 | +7.52 | +5.07 to +9.97 | +29.44 | -32.61 | 99.9% |
| heuristic | 150 | +12.58 | +6.86 to +18.30 | +50.77 | -27.40 | 99.9% |
| calling_station | 40 | +560.86 | +540.81 to +580.92 | +468.27 | +1344.02 | 26.5% |
| calling_station | 150 | +1706.05 | +1638.00 to +1774.09 | +1421.64 | +3503.62 | 25.8% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

The candidate’s result in each seat, in big blinds per 100 hands:

| Opponent | Stacks (bb) | button | small blind | big blind | utg | utg+1 | utg+2 | lojack | hijack | cutoff |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +36.87 | -8.61 | -35.92 | +14.80 | +9.13 | -3.95 | +16.91 | +13.16 | +17.96 |
| calling_station | 100 | +1048.89 | +933.53 | +2741.63 | +1144.04 | +1305.69 | +1488.14 | +766.47 | +822.59 | +1042.33 |
| random | 100 | +128.02 | +76.61 | +154.71 | +429.72 | +364.39 | +116.50 | -132.57 | -55.39 | +18.23 |
| min_bettor | 100 | +271.75 | +315.83 | +100.20 | +520.64 | +815.82 | +752.11 | +595.66 | +189.59 | +235.12 |
| heuristic | 40 | +29.44 | -12.87 | -32.61 | +14.40 | +10.39 | +5.24 | +12.82 | +17.32 | +23.52 |
| heuristic | 150 | +50.77 | +0.49 | -27.40 | +18.99 | +12.92 | -6.78 | +24.29 | +15.83 | +24.14 |
| calling_station | 40 | +468.27 | +374.31 | +1344.02 | +490.36 | +593.41 | +523.92 | +385.66 | +388.06 | +479.77 |
| calling_station | 150 | +1421.64 | +1277.65 | +3503.62 | +1584.24 | +1833.64 | +2072.72 | +1073.87 | +1146.59 | +1440.45 |

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/nine/9max-o1-s0 --name 9max-o1-s0 --out docs/evaluations --deals 20000 --seed 0
```
