from __future__ import annotations

import logging
import multiprocessing as mp
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple, Union

import joblib
import numpy as np

from poker_ai.ai.agent import Agent
from poker_ai.games.short_deck.state import ShortDeckPokerState


log = logging.getLogger("sync.ai")
# Read once at import: os.umask can only be read by setting it.
_UMASK = os.umask(0)
os.umask(_UMASK)


def calculate_strategy(this_info_sets_regret: Dict[str, float]) -> Dict[str, float]:
    """
    Calculate the strategy based on the current information sets regret.

    ...

    Parameters
    ----------
    this_info_sets_regret : Dict[str, float]
        Regret for each action at this info set.

    Returns
    -------
    strategy : Dict[str, float]
        Strategy as a probability over actions.
    """
    # TODO: Could we instanciate a state object from an info set?
    actions = this_info_sets_regret.keys()
    regret_sum = sum([max(regret, 0) for regret in this_info_sets_regret.values()])
    if regret_sum > 0:
        strategy: Dict[str, float] = {
            action: max(this_info_sets_regret[action], 0) / regret_sum
            for action in actions
        }
    else:
        default_probability = 1 / len(actions)
        strategy: Dict[str, float] = {action: default_probability for action in actions}
    return strategy


def update_strategy(
    agent: Agent,
    state: ShortDeckPokerState,
    i: int,
    t: int,
    locks: Dict[str, mp.synchronize.Lock] = {},
):
    """
    Update pre flop strategy using a more theoretically sound approach.

    ...

    Parameters
    ----------
    agent : Agent
        Agent being trained.
    state : ShortDeckPokerState
        Current game state.
    i : int
        The Player.
    t : int
        The iteration.
    locks : Dict[str, mp.synchronize.Lock]
        The locks for multiprocessing
    """
    ph = state.player_i  # this is always the case no matter what i is

    player_not_in_hand = not state.players[i].is_active
    if state.is_terminal or player_not_in_hand or state.betting_round > 0:
        return

    # NOTE(fedden): According to Algorithm 1 in the supplementary material,
    #               we would add in the following bit of logic. However we
    #               already have the game logic embedded in the state class,
    #               and this accounts for the chance samplings. In other words,
    #               it makes sure that chance actions such as dealing cards
    #               happen at the appropriate times.
    # elif h is chance_node:
    #   sample action from strategy for h
    #   update_strategy(rs, h + a, i, t)

    elif ph == i:
        # calculate regret
        this_info_sets_regret = agent.regret.get(state.info_set, state.initial_regret)
        sigma = calculate_strategy(this_info_sets_regret)
        log.debug(f"Calculated Strategy for {state.info_set}: {sigma}")
        # choose an action based of sigma
        available_actions: List[str] = list(sigma.keys())
        action_probabilities: np.ndarray = np.array(list(sigma.values()))
        action: str = np.random.choice(available_actions, p=action_probabilities)
        log.debug(f"ACTION SAMPLED: ph {state.player_i} ACTION: {action}")
        # Increment the action counter.
        if locks:
            locks["strategy"].acquire()
        this_states_strategy = agent.strategy.get(
            state.info_set, state.initial_strategy
        )
        this_states_strategy[action] += 1
        # Update the master strategy by assigning.
        agent.strategy[state.info_set] = this_states_strategy
        if locks:
            locks["strategy"].release()
        new_state: ShortDeckPokerState = state.apply_action(action)
        update_strategy(agent, new_state, i, t, locks)
    else:
        # Traverse each action.
        for action in state.legal_actions:
            log.debug(f"Going to Traverse {action} for opponent")
            new_state: ShortDeckPokerState = state.apply_action(action)
            update_strategy(agent, new_state, i, t, locks)


def cfr(
    agent: Agent,
    state: ShortDeckPokerState,
    i: int,
    t: int,
    locks: Dict[str, mp.synchronize.Lock] = {},
) -> float:
    """
    Regular counter factual regret minimization algorithm.

    ...

    Parameters
    ----------
    agent : Agent
        Agent being trained.
    state : ShortDeckPokerState
        Current game state.
    i : int
        The Player.
    t : int
        The iteration.
    locks : Dict[str, mp.synchronize.Lock]
        The locks for multiprocessing
    """
    log.debug("CFR")
    log.debug("########")
    log.debug(f"Iteration: {t}")
    log.debug(f"Player Set to Update Regret: {i}")
    log.debug(f"P(h): {state.player_i}")
    log.debug(f"P(h) Updating Regret? {state.player_i == i}")
    log.debug(f"Betting Round {state._betting_stage}")
    log.debug(f"Community Cards {state._table.community_cards}")
    for seat, player in enumerate(state.players):
        log.debug(f"Player {seat} hole cards: {player.cards}")
    try:
        log.debug(f"I(h): {state.info_set}")
    except KeyError:
        pass
    log.debug(f"Betting Action Correct?: {state.players}")

    ph = state.player_i

    player_not_in_hand = not state.players[i].is_active
    if state.is_terminal or player_not_in_hand:
        return state.payout[i]

    # NOTE(fedden): The logic in Algorithm 1 in the supplementary material
    #               instructs the following lines of logic, but state class
    #               will already skip to the next in-hand player.
    # elif p_i not in hand:
    #   cfr()
    # NOTE(fedden): According to Algorithm 1 in the supplementary material,
    #               we would add in the following bit of logic. However we
    #               already have the game logic embedded in the state class,
    #               and this accounts for the chance samplings. In other words,
    #               it makes sure that chance actions such as dealing cards
    #               happen at the appropriate times.
    # elif h is chance_node:
    #   sample action from strategy for h
    #   cfr()

    elif ph == i:
        # calculate strategy
        this_info_sets_regret = agent.regret.get(state.info_set, state.initial_regret)
        sigma = calculate_strategy(this_info_sets_regret)
        log.debug(f"Calculated Strategy for {state.info_set}: {sigma}")

        vo = 0.0
        voa: Dict[str, float] = {}
        for action in state.legal_actions:
            log.debug(
                f"ACTION TRAVERSED FOR REGRET: ph {state.player_i} ACTION: {action}"
            )
            new_state: ShortDeckPokerState = state.apply_action(action)
            voa[action] = cfr(agent, new_state, i, t, locks)
            log.debug(f"Got EV for {action}: {voa[action]}")
            vo += sigma[action] * voa[action]
            log.debug(
                f"Added to Node EV for ACTION: {action} INFOSET: {state.info_set}\n"
                f"STRATEGY: {sigma[action]}: {sigma[action] * voa[action]}"
            )
        log.debug(f"Updated EV at {state.info_set}: {vo}")
        if locks:
            locks["regret"].acquire()
        this_info_sets_regret = agent.regret.get(state.info_set, state.initial_regret)
        for action in state.legal_actions:
            this_info_sets_regret[action] += voa[action] - vo
        # Assign regret back to the shared memory.
        agent.regret[state.info_set] = this_info_sets_regret
        if locks:
            locks["regret"].release()
        return vo
    else:
        this_info_sets_regret = agent.regret.get(state.info_set, state.initial_regret)
        sigma = calculate_strategy(this_info_sets_regret)
        log.debug(f"Calculated Strategy for {state.info_set}: {sigma}")
        available_actions: List[str] = list(sigma.keys())
        action_probabilities: List[float] = list(sigma.values())
        action: str = np.random.choice(available_actions, p=action_probabilities)
        log.debug(f"ACTION SAMPLED: ph {state.player_i} ACTION: {action}")
        new_state: ShortDeckPokerState = state.apply_action(action)
        return cfr(agent, new_state, i, t, locks)


def cfrp(
    agent: Agent,
    state: ShortDeckPokerState,
    i: int,
    t: int,
    c: int,
    locks: Dict[str, mp.synchronize.Lock] = {},
):
    """
    Counter factual regret minimazation with pruning.

    ...

    Parameters
    ----------
    agent : Agent
        Agent being trained.
    state : ShortDeckPokerState
        Current game state.
    i : int
        The Player.
    t : int
        The iteration.
    locks : Dict[str, mp.synchronize.Lock]
        The locks for multiprocessing
    """
    ph = state.player_i

    player_not_in_hand = not state.players[i].is_active
    if state.is_terminal or player_not_in_hand:
        return state.payout[i]
    # NOTE(fedden): The logic in Algorithm 1 in the supplementary material
    #               instructs the following lines of logic, but state class
    #               will already skip to the next in-hand player.
    # elif p_i not in hand:
    #   cfr()
    # NOTE(fedden): According to Algorithm 1 in the supplementary material,
    #               we would add in the following bit of logic. However we
    #               already have the game logic embedded in the state class,
    #               and this accounts for the chance samplings. In other words,
    #               it makes sure that chance actions such as dealing cards
    #               happen at the appropriate times.
    # elif h is chance_node:
    #   sample action from strategy for h
    #   cfr()
    elif ph == i:
        # calculate strategy
        this_info_sets_regret = agent.regret.get(state.info_set, state.initial_regret)
        sigma = calculate_strategy(this_info_sets_regret)
        # TODO: Does updating sigma here (as opposed to after regret) miss out
        #       on any updates? If so, is there any benefit to having it up
        #       here?
        vo = 0.0
        voa: Dict[str, float] = dict()
        # Explored dictionary to keep track of regret updates that can be
        # skipped.
        explored: Dict[str, bool] = {action: False for action in state.legal_actions}
        # Get the regret for this state.
        this_info_sets_regret = agent.regret.get(state.info_set, state.initial_regret)
        for action in state.legal_actions:
            if this_info_sets_regret[action] > c:
                new_state: ShortDeckPokerState = state.apply_action(action)
                voa[action] = cfrp(agent, new_state, i, t, c, locks)
                explored[action] = True
                vo += sigma[action] * voa[action]
        if locks:
            locks["regret"].acquire()
        # Get the regret for this state again, incase any other process updated
        # it whilst we were doing `cfrp`.
        this_info_sets_regret = agent.regret.get(state.info_set, state.initial_regret)
        for action in state.legal_actions:
            if explored[action]:
                this_info_sets_regret[action] += voa[action] - vo
        # Update the master copy of the regret.
        agent.regret[state.info_set] = this_info_sets_regret
        if locks:
            locks["regret"].release()
        return vo
    else:
        this_info_sets_regret = agent.regret.get(state.info_set, state.initial_regret)
        sigma = calculate_strategy(this_info_sets_regret)
        available_actions: List[str] = list(sigma.keys())
        action_probabilities: List[float] = list(sigma.values())
        action: str = np.random.choice(available_actions, p=action_probabilities)
        new_state: ShortDeckPokerState = state.apply_action(action)
        return cfrp(agent, new_state, i, t, c, locks)


CheckpointState = Dict[str, Union[str, float, int, None]]


def should_discount(t: int, lcfr_threshold: int, discount_interval: int) -> bool:
    """Return whether linear-CFR discounting applies after iteration `t`.

    Following Algorithm 1 of the Pluribus supplement, discounting happens
    whenever `t` is a multiple of `discount_interval` strictly before
    `lcfr_threshold`.
    """
    return t < lcfr_threshold and t % discount_interval == 0


def discount_factor(t: int, discount_interval: int) -> float:
    """Return the linear-CFR discount factor for iteration `t`."""
    n_intervals = t / discount_interval
    return n_intervals / (n_intervals + 1)


def discount(
    agent: Agent,
    t: int,
    discount_interval: int,
    locks: Dict[str, mp.synchronize.Lock] = {},
) -> float:
    """
    Multiply every stored regret and strategy value by the discount factor.

    Each information set is reassigned, so the update reaches both plain
    dicts and multiprocessing manager proxies (indexing a proxy returns a
    copy of the inner dict). Returns the factor applied.
    """
    d = discount_factor(t, discount_interval)
    for table, lock_name in ((agent.regret, "regret"), (agent.strategy, "strategy")):
        if locks:
            locks[lock_name].acquire()
        try:
            for info_set in list(table.keys()):
                table[info_set] = {
                    action: value * d for action, value in table[info_set].items()
                }
        finally:
            if locks:
                locks[lock_name].release()
    return d


def snapshot(
    agent: Agent, locks: Dict[str, mp.synchronize.Lock] = {}
) -> Tuple[Dict[str, Dict[str, float]], Dict[str, Dict[str, float]]]:
    """Copy the agent's regret and strategy into plain, independent dicts."""
    tables = []
    for table, lock_name in ((agent.regret, "regret"), (agent.strategy, "strategy")):
        if locks:
            locks[lock_name].acquire()
        try:
            tables.append({k: dict(v) for k, v in table.items()})
        finally:
            if locks:
                locks[lock_name].release()
    return tables[0], tables[1]


def _atomic_dump(value: Any, path: Path):
    """Write `value` with joblib so that `path` is either old or complete."""
    path = Path(path)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    os.close(fd)
    try:
        # mkstemp creates owner-only files; give the checkpoint the mode a
        # plain open() would have.
        os.chmod(tmp_name, 0o666 & ~_UMASK)
        joblib.dump(value, tmp_name)
        os.replace(tmp_name, path)
    except BaseException:
        if os.path.exists(tmp_name):
            os.remove(tmp_name)
        raise


def write_checkpoint(
    regret: Dict[str, Dict[str, float]],
    strategy: Dict[str, Dict[str, float]],
    save_path: Path,
    t: int,
    server_state: CheckpointState,
) -> CheckpointState:
    """
    Publish the checkpoint for completed iteration `t` from a snapshot.

    `agent.joblib` accumulates the regret-matched strategy of every dump in
    `strategy`, keeps the live `regret` and update counts
    (`pre_flop_strategy`), records `timestep` and embeds the resume state.
    `server.gz` then receives the same resume state. Both files are replaced
    atomically, agent first, so an interrupted write leaves the previous
    checkpoint usable, and `resume` can detect an agent newer than
    `server.gz` from the embedded state.
    """
    save_path = Path(save_path)
    agent_path = os.path.abspath(str(save_path / "agent.joblib"))
    if os.path.isfile(agent_path):
        offline_agent = joblib.load(agent_path)
    else:
        offline_agent = {"regret": {}, "timestep": t, "strategy": {}}
    # Accumulate the regret-matched strategy for each info set.
    accumulated = offline_agent["strategy"]
    for info_set, this_info_sets_regret in sorted(regret.items()):
        sigma = calculate_strategy(this_info_sets_regret)
        if info_set not in accumulated:
            accumulated[info_set] = dict(sigma)
        else:
            for action, probability in sigma.items():
                accumulated[info_set][action] += probability
    # Update the resume state so the next run starts after this iteration.
    resume_state = dict(server_state)
    resume_state["agent_path"] = agent_path
    resume_state["start_timestep"] = t + 1
    offline_agent["regret"] = regret
    offline_agent["pre_flop_strategy"] = strategy
    offline_agent["timestep"] = t
    offline_agent["resume_state"] = resume_state
    _atomic_dump(offline_agent, Path(agent_path))
    _atomic_dump(resume_state, save_path / "server.gz")
    return resume_state


def serialise(
    agent: Agent,
    save_path: Path,
    t: int,
    server_state: CheckpointState,
    locks: Dict[str, mp.synchronize.Lock] = {},
) -> CheckpointState:
    """
    Write progress of optimising agent (and server state) to file.

    ...

    Parameters
    ----------
    agent : Agent
        Agent being trained.
    save_path : Path
        Directory of the training run.
    t : int
        The completed iteration.
    server_state : Dict[str, Union[str, float, int, None]]
        All the variables required to resume training.
    locks : Dict[str, mp.synchronize.Lock]
        The locks for multiprocessing
    """
    regret, strategy = snapshot(agent, locks)
    return write_checkpoint(regret, strategy, save_path, t, server_state)
