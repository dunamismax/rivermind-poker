# Models

The registry of RiverMind’s trained bots: which evaluated blueprint is the **champion** of each format, and every run that was put to the promotion gate (P5.5). A format is a table size: heads-up, then 6-max and 9-max (P5.6). The site serves only champions, and each strength claim it makes links to the evaluations listed here (D-7).

[`models.json`](models.json) is the registry itself. `rivermind-poker blueprint promote` writes it and the part of this page between the two markers; a test fails if the page, the registry or a recorded report disagree. [docs/bots.md](bots.md#promotion-and-the-registry-p55) describes the gate and the commands, and [where the files are kept](bots.md#where-models-are-kept) on this Mac and on ubuntu-vm.

**The gate.** A run is promoted when the lower bound of its 95% interval is above zero against **each** of RiverMind Easy and the calling station at 100 big blinds, and against the format’s champion when there is one. The gate must hold twice: for the checkpoint, and for the serving bundle exported from it, whose rounded strategy is what the site plays. A run **failed** when some interval lies wholly below zero. It is **inconclusive** when an interval spans zero, and it can be put to the gate again with more deals. Either way the format keeps the champion it had.

<!-- registry:start · generated from models.json by `rivermind-poker blueprint promote`; do not edit by hand -->

## Champions

| Format | Champion | Abstraction | Training iterations | Promoted | Evaluations |
| --- | --- | --- | --- | --- | --- |
| Heads-up | `hu-m1-s0-1024m` | `hu-m1` | 1,024,000,000 | 2026-11-21 | [checkpoint](evaluations/hu-m1-s0-1024m.md), [served bundle](evaluations/hu-m1-s0-1024m-served.md) |
| 6-max | `6max-s1-s0-3600m` | `6max-s1` | 3,600,000,000 | 2026-11-23 | [checkpoint](evaluations/6max-s1-s0-3600m.md), [served bundle](evaluations/6max-s1-s0-3600m-served.md) |
| 9-max | `9max-o1-s0` | `9max-o1` | 30,000,000 | 2026-11-24 | [checkpoint](evaluations/9max-o1-s0.md), [served bundle](evaluations/9max-o1-s0-served.md) |

### Heads-up: `hu-m1-s0-1024m`

Promoted on 2026-11-21, replacing `hu-m1-s0-128m`. Against the simple bots it wins less than `hu-m1-s0-128m` did (+226.66 against +308.33 from the calling station at 100 big blinds). The gate asks that it beats them and the champion, and it beats the champion head to head.

- **Gate, the checkpoint:** +59.05 (+50.41 to +67.70) against RiverMind Easy; +226.66 (+210.33 to +242.99) against the calling station; +21.38 (+10.71 to +32.05) against `hu-m1-s0-128m`, the champion at the time, in big blinds per 100 hands with 95% intervals, over 20,000 duplicate deals each at 100 big blinds, seed 0 ([report](evaluations/hu-m1-s0-1024m.md)).
- **Gate, the served bundle:** +58.79 (+50.09 to +67.48) against RiverMind Easy; +224.92 (+208.64 to +241.20) against the calling station; +21.14 (+10.45 to +31.84) against `hu-m1-s0-128m`, the champion at the time, in big blinds per 100 hands with 95% intervals, over 20,000 duplicate deals each at 100 big blinds, seed 0 ([report](evaluations/hu-m1-s0-1024m-served.md)).
- **Checkpoint:** 1,024,000,000 iterations of `hu-m1`, written at commit `06d0627`. `manifest.json` `8094730cf402da90be6b186deeb0ccdb238b16f68618cc2f7411a1aa3c4a52d0`, `regrets.npy` `e98f198c360c047d345ee3937076f186f54cbc843e2db7bb21080ab96b203b84`, `strategy.npy` `8fe97f5b4e253c8e678da38a76cef9769b4306fcb0d1f8e68a8cfa4945c88839`.
- **Trees:** 50 big blinds `378a4e1da9cb5cba898f76c8e4f2dcf90f589b855a87f914d50d68b590613881`, 100 big blinds `220a7cab487c973ba65fa3deee6e562804cba0a3474df52c086d483a61f2287b`.
- **Card tables:** seed 0, table set `4ff8b0efe6ceae251843a229c5c0c42b255a42cf543ebaafc56d1d702ffca06a` (one SHA-256 over its files’ hashes). Bucket files: `preflop.npy` `a0a6e5edcc3d3a55fb6acff95b5dbe38615f9687cf56b4d5ca3a6b7f8d8304c9`, `flop.npy` `947731ea66128594522a01031aaad4ad7da71ca82cd322108d6f39e7aea03bab`, `turn.npy` `cd14176b9acd407d5f7f8fb122e888ba7935911835f25bb942665236aeb5bc3c`, `river.npy` `756d746b6c09c612c7eaad9600dd8c6e04b054ed24d5cc54b58b9d4584eb34ae`. `models.json` has all 16 files.
- **Training settings:** `abstraction` hu-m1, `depths` [50, 100], `seed` 0, `chunk_size` 1,000, `chunks_per_batch` 64, `discount_every` 1,000,000, `discount_until` 40,000,000, `prune_after` 20,000,000, `prune_probability` 0.95, `prune_threshold` -10,000,000, `regret_floor` -11,000,000.
- **Serving bundle:** `strategy.u8` `31a782ea5d70fb72f363c685e31c8d0c70b05938d295b96b9face1fdc340fc8b`, probabilities in multiples of 1/255. `models.json` has all 12 files.
- **Kept in:** `artifacts/models/hu-m1-s0-1024m/` (`checkpoint/` and `bundle/`).
- **RiverMind Medium:** each hand played as this served bundle with probability 0.5 and as RiverMind Easy otherwise; +26.51 (+20.27 to +32.75) against RiverMind Easy; +261.93 (+246.94 to +276.92) against the calling station; -38.36 (-48.14 to -28.58) against RiverMind Hard, the champion itself at 100 big blinds, over 20,000 duplicate deals each, seed 0 ([report](evaluations/hu-m1-s0-1024m-medium.md); recorded 2026-11-22).

### 6-max: `6max-s1-s0-3600m`

Promoted on 2026-11-23, replacing `6max-s1-s0-1000m`.

- **Gate, the checkpoint:** +20.21 (+14.92 to +25.50) against RiverMind Easy; +594.45 (+538.32 to +650.57) against the calling station; +7.29 (+2.27 to +12.30) against `6max-s1-s0-1000m`, the champion at the time, in big blinds per 100 hands with 95% intervals, over 20,000 duplicate deals each at 100 big blinds, seed 0 ([report](evaluations/6max-s1-s0-3600m.md)).
- **Gate, the served bundle:** +20.30 (+15.02 to +25.59) against RiverMind Easy; +596.27 (+540.14 to +652.41) against the calling station; +7.35 (+2.34 to +12.37) against `6max-s1-s0-1000m`, the champion at the time, in big blinds per 100 hands with 95% intervals, over 20,000 duplicate deals each at 100 big blinds, seed 0 ([report](evaluations/6max-s1-s0-3600m-served.md)).
- **Checkpoint:** 3,600,000,000 iterations of `6max-s1`, written at commit `ca7965d`. `manifest.json` `38c69109d70c2f58fa0b1563870671cf47fa172c1fdc7ac7c983b04940616d84`, `regrets.npy` `60133bee656fcb2d5d1e98487555d7a9574b77ca3825fbeccedc85fa5b6388b6`, `strategy.npy` `8eec4e434766dc3806b6d0dc7463620a746eb39b8aa6498440edc734b413ff7a`.
- **Trees:** 50 big blinds `cc952203fb974367c81d7a97ce840458e279c1edb10ac75318b8a015c7383f59`, 100 big blinds `2da67fafbe203a63044e0aa754c02ffdd3c6cf54a106e33449de8e344392b4e3`.
- **Card tables:** seed 0, table set `085cfca5ce89a7363be57d1bcf04cd89d599cc55faba669a0bd2b2606279e3e9` (one SHA-256 over its files’ hashes). Bucket files: `preflop.npy` `a0a6e5edcc3d3a55fb6acff95b5dbe38615f9687cf56b4d5ca3a6b7f8d8304c9`, `flop.npy` `b245fe1e208d80fc27b8aa3b0dad7259d060969a3838f95d02ca0205916929ee`, `turn.npy` `2765327cc21b4e56fb2a4b160b98de37fb2ef1165bb60a4978a1a296f2bfacee`, `river.npy` `2c89cf9411af82885c48ebc27ccde1526fddfd6d39aa08272c3664534f16ae3a`. `models.json` has all 16 files.
- **Training settings:** `abstraction` 6max-s1, `depths` [50, 100], `seed` 0, `chunk_size` 1,000, `chunks_per_batch` 64, `discount_every` 4,000,000, `discount_until` 160,000,000, `prune_after` 80,000,000, `prune_probability` 0.95, `prune_threshold` -60,000,000, `regret_floor` -66,000,000.
- **Serving bundle:** `strategy.u8` `32fdd163adb8ca9625d3d4524bfefefe1a8f0d540b32524867f78bb566d73154`, probabilities in multiples of 1/255. `models.json` has all 12 files.
- **Kept in:** `artifacts/models/6max-s1-s0-3600m/` (`checkpoint/` and `bundle/`).
- **RiverMind Medium:** each hand played as this served bundle with probability 0.5 and as RiverMind Easy otherwise; +9.64 (+5.61 to +13.66) against RiverMind Easy; +773.54 (+725.49 to +821.58) against the calling station; -5.30 (-9.87 to -0.74) against RiverMind Hard, the champion itself at 100 big blinds, over 20,000 duplicate deals each, seed 0 ([report](evaluations/6max-s1-s0-3600m-medium.md); recorded 2026-11-23).

### 9-max: `9max-o1-s0`

Promoted on 2026-11-24, as the first 9-max champion.

- **Gate, the checkpoint:** +6.71 (+2.39 to +11.02) against RiverMind Easy; +1254.81 (+1207.56 to +1302.06) against the calling station, in big blinds per 100 hands with 95% intervals, over 20,000 duplicate deals each at 100 big blinds, seed 0 ([report](evaluations/9max-o1-s0.md)).
- **Gate, the served bundle:** +6.48 (+2.16 to +10.81) against RiverMind Easy; +1254.71 (+1207.46 to +1301.95) against the calling station, in big blinds per 100 hands with 95% intervals, over 20,000 duplicate deals each at 100 big blinds, seed 0 ([report](evaluations/9max-o1-s0-served.md)).
- **Checkpoint:** 30,000,000 iterations of `9max-o1`, written at commit `233b9c6`. `manifest.json` `1c4170ae9d7620ad57b2eba4a12c5d29e6d81bb2966e74dd5efbd131ba4c0688`, `regrets.npy` `a9af3142403bb905a735404c94bc24949f2bec05b112af62327e571922bb8211`, `strategy.npy` `e12605696bc00b2411229858e5600495c8df33e1a16b3b7c95c116d27222d106`, `visits.npy` `4e34d1a6d649a140a5939df3e6f8afb2fcb364c9d69f376e61b872c29f154ea2`.
- **Builds on:** the six-seat champion `6max-s1-s0-3600m`, whose served bundle plays every decision but the early seats' first (table set `085cfca5ce89a7363be57d1bcf04cd89d599cc55faba669a0bd2b2606279e3e9`).
- **Training settings:** `batches` 15,000, `chunks` 16, `per_chunk` 125, `seed` 0.
- **Serving bundle:** `early.u8` `4b12d5a5a612a0e1188ac0566f1ed6caa9fe42cbf9abce8b7eb254b419d8c094`, probabilities in multiples of 1/255. `models.json` has all 1 files.
- **Kept in:** `artifacts/models/9max-o1-s0/` (`checkpoint/` and `bundle/`).
- **RiverMind Medium:** each hand played as this model with probability 0.5 and as RiverMind Easy otherwise; +4.78 (+1.49 to +8.07) against RiverMind Easy; +1125.80 (+1082.70 to +1168.91) against the calling station; -3.12 (-9.61 to +3.38) against RiverMind Hard, the champion itself at 100 big blinds, over 20,000 duplicate deals each, seed 0 ([report](evaluations/9max-o1-s0-medium.md); recorded 2026-11-24).

## Decisions

Every run put to the gate, newest first. Results are big blinds per 100 hands with 95% intervals.

| Date | Format | Candidate | Outcome | Checkpoint | Served bundle |
| --- | --- | --- | --- | --- | --- |
| 2026-11-24 | 9-max | `9max-o1-s0`, 30,000,000 iterations | Promoted | +6.71 (+2.39 to +11.02) against RiverMind Easy; +1254.81 (+1207.56 to +1302.06) against the calling station ([report](evaluations/9max-o1-s0.md)) | +6.48 (+2.16 to +10.81) against RiverMind Easy; +1254.71 (+1207.46 to +1301.95) against the calling station ([report](evaluations/9max-o1-s0-served.md)) |
| 2026-11-23 | 6-max | `6max-s1-s0-3600m`, 3,600,000,000 iterations | Promoted, replacing `6max-s1-s0-1000m` | +20.21 (+14.92 to +25.50) against RiverMind Easy; +594.45 (+538.32 to +650.57) against the calling station; +7.29 (+2.27 to +12.30) against `6max-s1-s0-1000m`, the champion at the time ([report](evaluations/6max-s1-s0-3600m.md)) | +20.30 (+15.02 to +25.59) against RiverMind Easy; +596.27 (+540.14 to +652.41) against the calling station; +7.35 (+2.34 to +12.37) against `6max-s1-s0-1000m`, the champion at the time ([report](evaluations/6max-s1-s0-3600m-served.md)) |
| 2026-11-23 | 6-max | `6max-s1-s0-1000m`, 1,000,000,000 iterations | Promoted, replacing `6max-s1-s0-100m` | +17.86 (+12.43 to +23.30) against RiverMind Easy; +567.54 (+510.73 to +624.34) against the calling station; +16.79 (+9.21 to +24.38) against `6max-s1-s0-100m`, the champion at the time ([report](evaluations/6max-s1-s0-1000m.md)) | +18.08 (+12.66 to +23.51) against RiverMind Easy; +567.65 (+510.86 to +624.44) against the calling station; +16.37 (+8.78 to +23.96) against `6max-s1-s0-100m`, the champion at the time ([report](evaluations/6max-s1-s0-1000m-served.md)) |
| 2026-11-22 | 6-max | `6max-s1-s0-100m`, 100,032,000 iterations | Promoted | +20.56 (+14.87 to +26.25) against RiverMind Easy; +509.48 (+451.59 to +567.38) against the calling station ([report](evaluations/6max-s1-s0-100m.md)) | +21.14 (+15.46 to +26.83) against RiverMind Easy; +510.84 (+452.95 to +568.73) against the calling station ([report](evaluations/6max-s1-s0-100m-served.md)) |
| 2026-11-21 | Heads-up | `hu-m1-s0-1280m-80k`, 1,280,000,000 iterations | Inconclusive | +49.19 (+45.03 to +53.35) against RiverMind Easy; +221.36 (+213.27 to +229.45) against the calling station; +0.72 (-4.01 to +5.44) against `hu-m1-s0-1024m`, the champion at the time ([report](evaluations/hu-m1-s0-1280m-80k.md)) | +49.16 (+45.00 to +53.31) against RiverMind Easy; +220.20 (+212.13 to +228.27) against the calling station; +1.65 (-3.07 to +6.37) against `hu-m1-s0-1024m`, the champion at the time ([report](evaluations/hu-m1-s0-1280m-80k-served.md)) |
| 2026-11-21 | Heads-up | `hu-m1-s0-1280m`, 1,280,000,000 iterations | Inconclusive | +57.21 (+48.61 to +65.81) against RiverMind Easy; +224.44 (+208.43 to +240.44) against the calling station; +7.21 (-2.46 to +16.89) against `hu-m1-s0-1024m`, the champion at the time ([report](evaluations/hu-m1-s0-1280m.md)) | +57.14 (+48.56 to +65.73) against RiverMind Easy; +223.64 (+207.67 to +239.61) against the calling station; +6.59 (-3.08 to +16.27) against `hu-m1-s0-1024m`, the champion at the time ([report](evaluations/hu-m1-s0-1280m-served.md)) |
| 2026-11-21 | Heads-up | `hu-m1-s0-1024m`, 1,024,000,000 iterations | Promoted, replacing `hu-m1-s0-128m` | +59.05 (+50.41 to +67.70) against RiverMind Easy; +226.66 (+210.33 to +242.99) against the calling station; +21.38 (+10.71 to +32.05) against `hu-m1-s0-128m`, the champion at the time ([report](evaluations/hu-m1-s0-1024m.md)) | +58.79 (+50.09 to +67.48) against RiverMind Easy; +224.92 (+208.64 to +241.20) against the calling station; +21.14 (+10.45 to +31.84) against `hu-m1-s0-128m`, the champion at the time ([report](evaluations/hu-m1-s0-1024m-served.md)) |
| 2026-11-21 | Heads-up | `hu-m1-s0-128m`, 128,000,000 iterations | Promoted | +61.12 (+50.88 to +71.36) against RiverMind Easy; +308.33 (+289.35 to +327.30) against the calling station ([report](evaluations/hu-m1-s0-128m.md)) | +60.74 (+50.53 to +70.96) against RiverMind Easy; +307.13 (+288.19 to +326.07) against the calling station ([report](evaluations/hu-m1-s0-128m-served.md)) |

<!-- registry:end -->
