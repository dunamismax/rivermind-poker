"""Self-play fuzzing: random legal play with random stacks, checking invariants.

Run ``python -m rivermind.engine.fuzz --hands 100000`` for the long run (P2.4).
The tests run a short version. Each hand checks after every action that:

- chips are conserved and no stack, bet or contribution goes negative;
- the chosen legal action applies, and nearby illegal actions are rejected;
- the hand ends within a bounded number of actions;
- once the hand is over, the pots and returned bet equal what was put in,
  and every final stack equals its start minus what it put in plus what it won.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import Counter
from collections.abc import Callable, Sequence

from .state import (
    Action,
    ActionKind,
    HandConfig,
    HandState,
    IllegalActionError,
    LegalActions,
    apply,
    legal_actions,
    start_hand,
)

MAX_ACTIONS = 4_000


class InvariantError(AssertionError):
    """An engine invariant failed."""


def random_config(rng: random.Random) -> HandConfig:
    if rng.random() < 0.5:
        return HandConfig(50, 100, ante=rng.choice((0, 0, 10, 25)))
    small = rng.randint(1, 50)
    big = rng.randint(small, 2 * small)
    return HandConfig(small, big, ante=rng.choice((0, 0, 0, rng.randint(1, big))))


def random_stacks(num_seats: int, config: HandConfig, rng: random.Random) -> list[int | None]:
    """Mostly deep stacks, with empty seats and short stacks mixed in."""
    while True:
        stacks: list[int | None] = []
        for _ in range(num_seats):
            roll = rng.random()
            if roll < 0.15:
                stacks.append(None)
            elif roll < 0.35:
                stacks.append(rng.randint(1, 3 * config.big_blind))
            else:
                stacks.append(rng.randint(config.big_blind, 300 * config.big_blind))
        if sum(1 for s in stacks if s) >= 2:
            return stacks


def random_action(state: HandState, legal: LegalActions, rng: random.Random) -> Action:
    """A random legal action, with bet sizes spread across the legal range."""
    choices: list[Action] = []
    if legal.can_fold:
        choices.append(Action.fold())
    choices.append(Action.check() if legal.can_check else Action.call())
    if legal.raise_kind is not None:
        lo, hi = legal.min_to, legal.max_to
        pot_to = state.current_bet + state.pot + (state.current_bet - state.street_bets[legal.seat])
        sizes = {
            lo,
            hi,
            rng.randint(lo, hi),
            min(max(lo, pot_to // 2), hi),
            min(max(lo, pot_to), hi),
        }
        choices.extend(Action(legal.raise_kind, size) for size in sorted(sizes))
    return rng.choice(choices)


def illegal_near(state: HandState, legal: LegalActions) -> list[Action]:
    """Actions just outside the legal set, all of which must be rejected."""
    bad: list[Action] = []
    if not legal.can_fold:
        bad.append(Action.fold())
    if not legal.can_check:
        bad.append(Action.check())
    if not legal.call:
        bad.append(Action.call())
    if legal.raise_kind is None:
        bad.append(Action.bet(state.current_bet + state.config.big_blind))
        bad.append(Action.raise_to(state.current_bet + state.config.big_blind))
    else:
        other = ActionKind.RAISE if legal.raise_kind is ActionKind.BET else ActionKind.BET
        bad.append(Action(other, legal.min_to))
        bad.append(Action(legal.raise_kind, legal.min_to - 1))
        bad.append(Action(legal.raise_kind, legal.max_to + 1))
        bad.append(Action(legal.raise_kind, None))
    bad.append(Action(ActionKind.CALL, legal.call))
    return bad


def check_state(state: HandState, total: int) -> None:
    """Invariants that hold at every point of a hand."""
    stacks = state.stacks
    if min(stacks) < 0 or min(state.contributions) < 0 or min(state.street_bets) < 0:
        raise InvariantError("a stack, bet or contribution went negative")
    if sum(stacks) + (0 if state.is_over else state.pot) != total:
        raise InvariantError("chips were not conserved")
    for seat, bet in enumerate(state.street_bets):
        if bet > state.contributions[seat] and not state.is_over:
            raise InvariantError("street bet exceeds contribution")
        if not state.dealt_in[seat] and (stacks[seat] or state.contributions[seat]):
            raise InvariantError("a seat not dealt in holds chips")
    if not state.is_over:
        seat = state.to_act
        if seat is None or not state.dealt_in[seat] or state.folded[seat] or stacks[seat] == 0:
            raise InvariantError("the player to act cannot act")
        return
    result = state.result
    assert result is not None
    if state.to_act is not None:
        raise InvariantError("a finished hand has a player to act")
    put_in = sum(state.contributions)
    if sum(p.amount for p in result.pots) != put_in:
        raise InvariantError("pots do not equal what was put in")
    if sum(result.winnings) != put_in:
        raise InvariantError("winnings do not equal the pots")
    returned = [0] * len(stacks)
    if result.uncalled is not None:
        returned[result.uncalled[0]] = result.uncalled[1]
    for seat, start in enumerate(state.starting_stacks):
        if not state.dealt_in[seat]:
            continue
        assert start is not None
        if stacks[seat] != start - state.contributions[seat] + result.winnings[seat]:
            raise InvariantError("a final stack does not match its payouts")
        if returned[seat] < 0:
            raise InvariantError("negative uncalled bet")
    live = [s for s in range(len(stacks)) if state.dealt_in[s] and not state.folded[s]]
    if result.showdown:
        if len(state.board) != 5 or len(live) < 2:
            raise InvariantError("a showdown needs a full board and two players")
        if sorted(result.shown + result.mucked) != live:
            raise InvariantError("every player at showdown shows or mucks")
    elif len(live) != 1:
        raise InvariantError("a hand without showdown has one player left")


def play_random_hand(
    num_seats: int,
    rng: random.Random,
    *,
    choose: Callable[[HandState, LegalActions, random.Random], Action] = random_action,
    check_illegal: bool = True,
) -> HandState:
    """Play one random hand, checking invariants after every action."""
    config = random_config(rng)
    stacks = random_stacks(num_seats, config, rng)
    dealt = [seat for seat, stack in enumerate(stacks) if stack]
    state = start_hand(config, stacks, rng.choice(dealt), rng=rng)
    total = sum(s or 0 for s in stacks)
    check_state(state, total)
    steps = 0
    while not state.is_over:
        legal = legal_actions(state)
        if check_illegal:
            for bad in illegal_near(state, legal):
                try:
                    apply(state, bad)
                except IllegalActionError:
                    pass
                else:
                    raise InvariantError(f"illegal action accepted: {bad!r}")
        action = choose(state, legal, rng)
        if not legal.allows(action):
            raise InvariantError(f"chooser picked an illegal action: {action!r}")
        state = apply(state, action)
        check_state(state, total)
        steps += 1
        if steps > MAX_ACTIONS:
            raise InvariantError("the hand did not end")
    return state


def run(hands: int, seat_counts: Sequence[int], seed: int) -> dict[str, object]:
    """Fuzz ``hands`` hands at each seat count and summarize them."""
    report: dict[str, object] = {"hands_per_seat_count": hands, "seed": seed, "seat_counts": {}}
    started = time.perf_counter()
    for num_seats in seat_counts:
        rng = random.Random(f"{seed}:{num_seats}")
        counts: Counter[str] = Counter(dict.fromkeys(("showdown", "fold_out", "tabled", "side_pots", "uncalled_returned", "actions"), 0))
        longest = 0
        for _ in range(hands):
            state = play_random_hand(num_seats, rng)
            result = state.result
            assert result is not None
            counts["showdown" if result.showdown else "fold_out"] += 1
            counts["tabled"] += result.tabled
            counts["side_pots"] += len(result.pots) > 1
            counts["uncalled_returned"] += result.uncalled is not None
            counts["actions"] += len(state.actions)
            longest = max(longest, len(state.actions))
        report["seat_counts"][str(num_seats)] = {**counts, "longest_hand": longest}  # type: ignore[index]
    report["seconds"] = round(time.perf_counter() - started, 1)
    report["failures"] = 0
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--hands", type=int, default=1_000, help="hands per seat count")
    parser.add_argument("--seats", default="2-9", help="seat counts, such as 2-9 or 2,6,9")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)
    if "-" in args.seats:
        lo, hi = (int(x) for x in args.seats.split("-"))
        seat_counts = list(range(lo, hi + 1))
    else:
        seat_counts = [int(x) for x in args.seats.split(",")]
    json.dump(run(args.hands, seat_counts, args.seed), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
