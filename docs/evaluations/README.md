# Bot evaluations

Each report here is written by `rivermind-poker blueprint evaluate` (P5.4) as a Markdown summary and a JSON file with every input and count. The method is in [docs/bots.md](../bots.md#evaluation-p54). Rerunning a report’s command on the same checkpoint and card tables reproduces its JSON exactly, whatever the number of workers. Checkpoints and tables stay under the ignored `artifacts/`, so the JSON names them by SHA-256.

Promotion decisions (P5.5) will cite these reports from `docs/models.md`, which lists each champion.
