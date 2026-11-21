# Models

The registry of RiverMind’s trained bots: which evaluated blueprint is the **champion** of each format, and every run that was put to the promotion gate (P5.5). A format is a table size: heads-up, then 6-max and 9-max (P5.6). The site serves only champions, and each strength claim it makes links to the evaluations listed here (D-7).

[`models.json`](models.json) is the registry itself. `rivermind-poker blueprint promote` writes it and the part of this page between the two markers; a test fails if the page, the registry or a recorded report disagree. [docs/bots.md](bots.md#promotion-and-the-registry-p55) describes the gate and the commands, and [where the files are kept](bots.md#where-models-are-kept) on this Mac and on ubuntu-vm.

**The gate.** A run is promoted when the lower bound of its 95% interval is above zero against **each** of RiverMind Easy and the calling station at 100 big blinds, and against the format’s champion when there is one. The gate must hold twice: for the checkpoint, and for the serving bundle exported from it, whose rounded strategy is what the site plays. A run **failed** when some interval lies wholly below zero. It is **inconclusive** when an interval spans zero, and it can be put to the gate again with more deals. Either way the format keeps the champion it had.

<!-- registry:start · generated from models.json by `rivermind-poker blueprint promote`; do not edit by hand -->

## Champions

No champion has been promoted yet.

## Decisions

No run has been put to the gate yet.

<!-- registry:end -->
