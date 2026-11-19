# From the terminal to rivermindpoker.com

The first browser milestone is one human completing a hand against two bots using play chips. Keeping the terminal game’s deck and betting rules for that first table lets both clients exercise the same engine.

| Milestone | Work | Completion check |
| --- | --- | --- |
| Establish a bot baseline | Run fixed-seed matches, rotate seats, and compare a versioned checkpoint with a uniform-random policy. Record chip results per hand and sampling uncertainty. | A second developer can repeat the evaluation with the same artifacts. |
| Separate decisions from rendering | Extract the random and checkpoint policies from the terminal loop. Give each bot the information available to its seat and the legal actions. | The terminal completes hands with either policy through the same interface. |
| Add a server-owned table | Manage the deck, turns, validated actions and payouts on the server. Return a seat-specific view containing the player’s cards, public board, stacks, pot and available actions. | Tests cover duplicate actions, out-of-turn moves, hidden opponent cards, showdown and reconnecting mid-hand. |
| Build the browser table | Display the current hand, let the player choose a legal action and show bot actions and the result. | A visitor can play consecutive hands on desktop and mobile with random or trained opponents. |
| Self-host the free game | Package the service for the existing server and route the domain to it over HTTPS. Keep offline training separate from serving a pinned bot checkpoint. | A fresh browser can play through rivermindpoker.com and the service recovers after a restart. |

The browser client, hosted service and production deployment are future work. Choose their frameworks when implementing the table API. A change to full-deck or no-limit rules will also need new action representations, training data and evaluation coverage.

## Training issues resolved before benchmarking

These issues blocked a trustworthy baseline. BUILD.md records the evidence for each fix.

- RM-01 corrected the reversed win and loss rates in river hand-strength labels. [Clustering utility](../poker_ai/clustering/game_utility.py)
- RM-02 made `train resume` keep a single-process run’s mode and continue its saved iteration, regrets and update counts. [Resume command](../poker_ai/ai/runner.py)
- RM-03 made discounting apply at the intended iterations in both training modes. [Checkpoint writer and discounting](../poker_ai/ai/ai.py)
- RM-04 takes multiprocess checkpoints between iterations and writes them atomically and in order. [Worker scheduling](../poker_ai/ai/multiprocess/server.py)
