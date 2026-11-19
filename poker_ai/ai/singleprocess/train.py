"""Single-process MCCFR training loop."""
from __future__ import annotations

import logging
import os
import random
from pathlib import Path
from typing import Any, Dict, Optional, Union

import numpy as np
from tqdm import tqdm, trange

from poker_ai.ai.agent import Agent
from poker_ai.ai import ai
from poker_ai import utils
from poker_ai.games.short_deck.state import new_game, ShortDeckPokerState

log = logging.getLogger("poker_ai.ai.singleprocess.train")


def print_strategy(strategy: Dict[str, Dict[str, int]]):
    """
    Print strategy.

    ...

    Parameters
    ----------
    strategy : Dict[str, Dict[str, int]]
        The preflop strategy for our agent.
    """
    for info_set, action_to_probabilities in sorted(strategy.items()):
        norm = sum(list(action_to_probabilities.values()))
        tqdm.write(f"{info_set}")
        for action, probability in action_to_probabilities.items():
            tqdm.write(f"  - {action}: {probability / norm:.2f}")


def _rng_state() -> Dict[str, Any]:
    """Capture the generators used by dealing and CFR sampling."""
    return {"python": random.getstate(), "numpy": np.random.get_state()}


def _restore_rng(rng_state: Dict[str, Any]):
    random.setstate(rng_state["python"])
    np.random.set_state(rng_state["numpy"])


def simple_search(
    save_path: Union[str, Path],
    lut_path: Union[str, Path],
    pickle_dir: bool,
    strategy_interval: int,
    n_iterations: int,
    lcfr_threshold: int,
    discount_interval: int,
    prune_threshold: int,
    c: int,
    n_players: int,
    dump_iteration: int,
    update_threshold: int,
    agent_path: Optional[Union[str, Path]] = None,
    start_timestep: int = 1,
    rng_state: Optional[Dict[str, Any]] = None,
) -> Agent:
    """
    Train agent in this process, optionally continuing a saved run.

    ...

    Parameters
    ----------
    save_path : str
        Path to save to.
    lut_path : str
        Directory containing the card lookup table.
    pickle_dir : bool
        Whether the lookup table uses the deprecated pickle layout.
    strategy_interval : int
        Iteration at which to update strategy.
    n_iterations : int
        Number of iterations.
    lcfr_threshold : int
        Discount only at iterations before this one.
    discount_interval : int
        Iteration at which to discount strategy and regret.
    prune_threshold : int
        Iteration at which to begin pruning.
    c : int
        Floor for regret at which we do not search a node.
    n_players : int
        Number of players.
    dump_iteration : int
        Iteration at which we begin serialization.
    update_threshold : int
        Iteration at which we begin updating strategy.
    agent_path : str, optional
        Checkpoint whose regret and strategy counts to continue from.
    start_timestep : int
        First iteration to run.
    rng_state : dict, optional
        Generator state saved with the checkpoint. With it, a resumed run
        repeats the uninterrupted run exactly.
    """
    save_path = Path(os.path.abspath(str(save_path)))
    if lut_path:
        lut_path = os.path.abspath(str(lut_path))
    if rng_state is not None:
        _restore_rng(rng_state)
    elif start_timestep == 1:
        utils.random.seed(42)
    else:
        # Checkpoints written before RNG state was saved cannot continue the
        # original stream; avoid replaying the first iteration's deals.
        log.warning(
            "Checkpoint has no RNG state; seeding with 42 + start_timestep."
        )
        utils.random.seed(42 + start_timestep)
    agent = Agent(agent_path, use_manager=False)
    card_info_lut = {}
    for t in trange(start_timestep, n_iterations + 1, desc="train iter"):
        if t == start_timestep + 1:
            logging.disable(logging.DEBUG)
        for i in range(n_players):  # fixed position i
            # Create a new state.
            state: ShortDeckPokerState = new_game(
                n_players,
                card_info_lut,
                lut_path=lut_path,
                pickle_dir=pickle_dir
            )
            card_info_lut = state.card_info_lut
            if t > update_threshold and t % strategy_interval == 0:
                ai.update_strategy(agent=agent, state=state, i=i, t=t)
            if t > prune_threshold:
                if random.uniform(0, 1) < 0.05:
                    ai.cfr(agent=agent, state=state, i=i, t=t)
                else:
                    ai.cfrp(agent=agent, state=state, i=i, t=t, c=c)
            else:
                ai.cfr(agent=agent, state=state, i=i, t=t)
        if ai.should_discount(t, lcfr_threshold, discount_interval):
            ai.discount(agent, t, discount_interval)
        if t > update_threshold and t % dump_iteration == 0:
            # dump the current strategy (sigma) throughout training and then
            # take an average. This allows for estimation of expected value in
            # leaf nodes later on using modified versions of the blueprint
            # strategy.
            server_state = dict(
                single_process=True,
                strategy_interval=strategy_interval,
                n_iterations=n_iterations,
                lcfr_threshold=lcfr_threshold,
                discount_interval=discount_interval,
                prune_threshold=prune_threshold,
                c=c,
                n_players=n_players,
                dump_iteration=dump_iteration,
                update_threshold=update_threshold,
                save_path=str(save_path),
                lut_path=lut_path,
                pickle_dir=pickle_dir,
                rng_state=_rng_state(),
            )
            ai.serialise(
                agent=agent, save_path=save_path, t=t, server_state=server_state,
            )

    print_strategy(agent.strategy)
    return agent
