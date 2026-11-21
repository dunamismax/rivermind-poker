# Bot evaluations

Each report here is written by `rivermind-poker blueprint evaluate` (P5.4) as a Markdown summary and a JSON file with every input and count. The method is in [docs/bots.md](../bots.md#evaluation-p54). Rerunning a report’s command on the same checkpoint and card tables reproduces its JSON exactly, whatever the number of workers. Checkpoints and tables stay under the ignored `artifacts/`, so the JSON names them by SHA-256.

A report named `…-served` evaluates a serving bundle: the rounded strategy and card-table arrays the site loads, not the checkpoint they were exported from.

Promotion decisions (P5.5) cite these reports from [docs/models.md](../models.md), which lists each champion and every run put to the gate. The registry records each cited report’s SHA-256, so a report is never edited once it is recorded.
