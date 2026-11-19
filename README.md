# RiverMind Poker

RiverMind Poker is an independent poker AI project. The current game is a three-seat table where you play two bots using a 20-card deck, tens through aces, with fixed-size raises. Play it at https://rivermindpoker.com, or run it yourself in the browser or the terminal. The goal is a free, self-hosted browser table at `rivermindpoker.com`.

## Play a hand

From this checkout, run the following with [uv](https://docs.astral.sh/uv/getting-started/installation/). The project uses Python 3.12 for development.

```sh
uv sync --locked
uv run rivermind-poker play --agent random
```

Use the left and right arrows to choose an action, Enter to confirm, and Q to leave on your turn. Random opponents work immediately. To play against a learned strategy, supply its checkpoint and matching card tables.

```sh
uv run rivermind-poker play --agent offline \
  --lut_path artifacts/tables --strategy_path artifacts/my-run/agent.joblib
```

Those paths are examples for locally generated files. The terminal records completed hands in `~/.poker/results.yaml`.

### In the browser

```sh
uv run rivermind-poker serve
```

Open http://127.0.0.1:8000, choose opponents and sit down. It works on desktop and mobile browsers. Pass the same `--strategy_path` and `--lut_path` to `serve` to offer trained RiverMind opponents next to the random ones. The server keeps tables in memory. A reload or dropped connection rejoins your seat, while a server restart closes the tables.

## Develop the bot

| Area | Start here |
| --- | --- |
| Cards, betting, pots and payouts | [Poker engine](poker_ai/poker/) |
| Rules and legal actions for the training game | [Short-deck state](poker_ai/games/short_deck/state.py) |
| Card abstraction and lookup tables | [Clustering](poker_ai/clustering/) |
| Monte Carlo counterfactual regret minimization (MCCFR) and checkpoints | [Training](poker_ai/ai/) |
| Bot decisions from one seat’s information | [Policies](poker_ai/policies.py) |
| Fixed-seed matches against random bots | [Benchmark](poker_ai/benchmark.py) |
| Server-owned table for networked clients | [Table](poker_ai/table.py) |
| Browser client and WebSocket server | [Web](poker_ai/web/) |
| Playable client | [Terminal](poker_ai/terminal/) |
| Tests | [Unit and functional tests](test/) |

Run `uv run pytest` for the development suite. The installed command is `rivermind-poker`. The Python namespace and legacy command `poker_ai` remain available for existing scripts and serialized artifacts.

[Development and training](CONTRIBUTING.md) · [Roadmap to the browser table](docs/roadmap.md)

## Origins and license

RiverMind started with a copy of Keith Lee’s Pluribus-inspired repository, which builds on the Poker AI implementation by Leon Fedden, Colin Manko and contributors. These projects implement published research ideas independently. The hand evaluator derives from Will Drevo’s Deuces. [Starting source](https://github.com/keithlee96/pluribus-poker-AI/tree/73fb394b26623c897459ffa3e66d7a5cb47e9962) · [Original Poker AI project](https://github.com/fedden/poker_ai) · [Deuces](https://github.com/worldveil/deuces)

On November 18, 2026, RiverMind introduced its own packaging, command-line entry point and training fixes. RiverMind Poker uses the same GNU General Public License, version 3 or later. The evaluator retains its MIT notice. [GPL license](LICENSE) · [Deuces notice](licenses/Deuces.txt)
