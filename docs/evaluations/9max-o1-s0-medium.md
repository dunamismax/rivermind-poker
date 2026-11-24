# Evaluation: 9max-o1-s0-medium

Candidate: RiverMind Medium, which plays each hand as the model below with probability 0.5 and as RiverMind Easy (the heuristic) otherwise, drawn once a hand (`rivermind/bots/levels.py`). The nine-seat model `artifacts/models/9max-o1-s0/bundle` (9max-o1, bundle, 30,000,000 deals of training): its early-seat table, its strategy rounded to multiples of 1/255, as the site serves it, on the six-seat serving bundle `artifacts/models/6max-s1-s0-3600m/bundle` (3,600,000,000 iterations, `strategy.u8` `32fdd163…`).
Game: no-limit Texas hold'em, 52-card deck, 9 seats, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played 9 times, the candidate once in every seat against 8 copies of the opponent, fresh stacks each hand.
Seed 0, 20,000 deals (180,000 hands) per matchup; evaluated at `e5e7353`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +4.78 | +1.49 to +8.07 | +26.82 | -32.41 | 99.9% |
| calling_station | 100 | +1125.80 | +1082.70 to +1168.91 | +1048.89 | +2741.63 | 25.9% |
| random | 100 | +101.49 | +78.43 to +124.55 | +105.63 | +125.88 | 69.9% |
| min_bettor | 100 | +331.55 | +301.41 to +361.70 | +271.75 | +100.20 | 37.6% |
| nine:artifacts/models/9max-o1-s0/bundle | 100 | -3.12 | -9.61 to +3.38 | +22.75 | -81.66 | 99.8% |
| heuristic | 40 | +5.18 | +3.36 to +7.00 | +25.55 | -28.28 | 99.9% |
| heuristic | 150 | +7.51 | +3.04 to +11.98 | +34.18 | -30.36 | 99.9% |
| calling_station | 40 | +503.23 | +484.44 to +522.02 | +468.27 | +1344.02 | 26.5% |
| calling_station | 150 | +1530.68 | +1469.20 to +1592.17 | +1421.64 | +3503.62 | 25.9% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

The candidate’s result in each seat, in big blinds per 100 hands:

| Opponent | Stacks (bb) | button | small blind | big blind | utg | utg+1 | utg+2 | lojack | hijack | cutoff |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +26.82 | -24.89 | -32.41 | +13.38 | +19.23 | -4.43 | +14.87 | +15.49 | +15.00 |
| calling_station | 100 | +1048.89 | +933.53 | +2741.63 | +811.71 | +995.16 | +1087.64 | +648.75 | +822.59 | +1042.33 |
| random | 100 | +105.63 | +45.69 | +125.88 | +299.52 | +203.26 | +98.85 | -48.06 | +14.05 | +68.60 |
| min_bettor | 100 | +271.75 | +315.83 | +100.20 | +424.50 | +590.78 | +480.23 | +375.94 | +189.59 | +235.12 |
| nine:artifacts/models/9max-o1-s0/bundle | 100 | +22.75 | -29.76 | -81.66 | +40.35 | -0.21 | -25.78 | +12.67 | +15.88 | +17.73 |
| heuristic | 40 | +25.55 | -28.30 | -28.28 | +16.28 | +15.56 | +3.81 | +9.45 | +15.90 | +16.64 |
| heuristic | 150 | +34.18 | -23.73 | -30.36 | +16.49 | +19.83 | -6.80 | +19.65 | +17.51 | +20.85 |
| calling_station | 40 | +468.27 | +374.31 | +1344.02 | +344.70 | +410.88 | +404.80 | +314.27 | +388.06 | +479.77 |
| calling_station | 150 | +1421.64 | +1277.65 | +3503.62 | +1130.97 | +1420.09 | +1530.14 | +905.00 | +1146.59 | +1440.45 |

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/models/9max-o1-s0/bundle --name 9max-o1-s0-medium --out docs/evaluations --deals 20000 --seed 0 --against heuristic@100 --against calling_station@100 --against random@100 --against min_bettor@100 --against nine:artifacts/models/9max-o1-s0/bundle@100 --against heuristic@40 --against heuristic@150 --against calling_station@40 --against calling_station@150 --level medium
```
