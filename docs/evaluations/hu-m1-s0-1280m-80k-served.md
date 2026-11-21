# Evaluation: hu-m1-s0-1280m-80k-served

Candidate: the serving bundle `artifacts/bundles/hu-m1-s0-1280m`, 1,280,000,000 iterations: the strategy the site serves, rounded to multiples of 1/255 (`strategy.u8` `e5c6feca…`), on the bundle’s own card tables (table set `4ff8b0ef…`).
Game: no-limit Texas hold'em, 52-card deck, heads-up, no ante (docs/rules.md); blinds 50/100; duplicate: each deal played twice with the seats swapped, fresh stacks each hand.
Seed 1, 80,000 deals (160,000 hands) per matchup; evaluated at `23264fd`.

| Opponent | Stacks (bb) | bb/100 | 95% interval | On the button | In the big blind | Trained data |
| --- | --- | --- | --- | --- | --- | --- |
| heuristic | 100 | +49.16 | +45.00 to +53.31 | +64.59 | +33.72 | 100.0% |
| calling_station | 100 | +220.20 | +212.13 to +228.27 | +248.43 | +191.97 | 100.0% |
| random | 100 | +207.64 | +197.17 to +218.12 | +215.96 | +199.33 | 100.0% |
| min_bettor | 100 | +254.67 | +242.31 to +267.03 | +254.34 | +254.99 | 100.0% |
| heuristic | 40 | +41.97 | +39.42 to +44.52 | +50.50 | +33.44 | 100.0% |
| heuristic | 150 | +56.94 | +51.37 to +62.50 | +78.15 | +35.73 | 100.0% |
| calling_station | 40 | +172.92 | +167.72 to +178.13 | +182.37 | +163.48 | 100.0% |
| calling_station | 150 | +262.20 | +251.06 to +273.34 | +300.62 | +223.78 | 100.0% |
| bundle:artifacts/models/hu-m1-s0-1024m/bundle | 100 | +1.65 | -3.07 to +6.37 | +13.94 | -10.64 | 100.0% |

“Trained data” is the share of the candidate’s decisions whose own info set had average-strategy data; the rest borrowed the nearest bucket, or checked or called (docs/bots.md). The JSON beside this file has every count, the checkpoint’s and opponents’ hashes and the decision statistics.

Reproduce with:

```sh
uv run --locked rivermind-poker blueprint evaluate artifacts/bundles/hu-m1-s0-1280m --name hu-m1-s0-1280m-80k-served --out docs/evaluations --deals 80000 --seed 1 --against heuristic@100 --against calling_station@100 --against random@100 --against min_bettor@100 --against heuristic@40 --against heuristic@150 --against calling_station@40 --against calling_station@150 --against bundle:artifacts/models/hu-m1-s0-1024m/bundle@100
```
