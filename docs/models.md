# Models

The registry of RiverMind’s trained bots: which evaluated blueprint is the **champion** of each format, and every run that was put to the promotion gate (P5.5). A format is a table size: heads-up, then 6-max and 9-max (P5.6). The site serves only champions, and each strength claim it makes links to the evaluations listed here (D-7).

[`models.json`](models.json) is the registry itself. `rivermind-poker blueprint promote` writes it and the part of this page between the two markers; a test fails if the page, the registry or a recorded report disagree. [docs/bots.md](bots.md#promotion-and-the-registry-p55) describes the gate and the commands, and [where the files are kept](bots.md#where-models-are-kept) on this Mac and on ubuntu-vm.

**The gate.** A run is promoted when the lower bound of its 95% interval is above zero against **each** of RiverMind Easy and the calling station at 100 big blinds, and against the format’s champion when there is one. The gate must hold twice: for the checkpoint, and for the serving bundle exported from it, whose rounded strategy is what the site plays. A run **failed** when some interval lies wholly below zero. It is **inconclusive** when an interval spans zero, and it can be put to the gate again with more deals. Either way the format keeps the champion it had.

<!-- registry:start · generated from models.json by `rivermind-poker blueprint promote`; do not edit by hand -->

## Champions

| Format | Champion | Abstraction | Training iterations | Promoted | Evaluations |
| --- | --- | --- | --- | --- | --- |
| Heads-up | `hu-m1-s0-1024m` | `hu-m1` | 1,024,000,000 | 2026-11-21 | [checkpoint](evaluations/hu-m1-s0-1024m.md), [served bundle](evaluations/hu-m1-s0-1024m-served.md) |

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

## Decisions

Every run put to the gate, newest first. Results are big blinds per 100 hands with 95% intervals.

| Date | Format | Candidate | Outcome | Checkpoint | Served bundle |
| --- | --- | --- | --- | --- | --- |
| 2026-11-21 | Heads-up | `hu-m1-s0-1024m`, 1,024,000,000 iterations | Promoted, replacing `hu-m1-s0-128m` | +59.05 (+50.41 to +67.70) against RiverMind Easy; +226.66 (+210.33 to +242.99) against the calling station; +21.38 (+10.71 to +32.05) against `hu-m1-s0-128m`, the champion at the time ([report](evaluations/hu-m1-s0-1024m.md)) | +58.79 (+50.09 to +67.48) against RiverMind Easy; +224.92 (+208.64 to +241.20) against the calling station; +21.14 (+10.45 to +31.84) against `hu-m1-s0-128m`, the champion at the time ([report](evaluations/hu-m1-s0-1024m-served.md)) |
| 2026-11-21 | Heads-up | `hu-m1-s0-128m`, 128,000,000 iterations | Promoted | +61.12 (+50.88 to +71.36) against RiverMind Easy; +308.33 (+289.35 to +327.30) against the calling station ([report](evaluations/hu-m1-s0-128m.md)) | +60.74 (+50.53 to +70.96) against RiverMind Easy; +307.13 (+288.19 to +326.07) against the calling station ([report](evaluations/hu-m1-s0-128m-served.md)) |

<!-- registry:end -->
