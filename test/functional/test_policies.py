"""RM-05: random and checkpoint bot policies shared between clients."""
import copy
import random
from collections import defaultdict

import joblib
import pytest
import yaml
from blessed import Terminal
from blessed.keyboard import Keystroke
from click.testing import CliRunner

from poker_ai import utils
from poker_ai.cli.runner import cli
from poker_ai.games.short_deck.state import new_game
from poker_ai.policies import CheckpointPolicy, RandomPolicy, SeatView, seat_view
from poker_ai.terminal import runner as terminal_runner
from test.functional.training_helpers import STAGES, write_single_bucket_lut

LUT = {stage: defaultdict(int) for stage in STAGES}


def _state(seed=7, lut=LUT):
    utils.random.seed(seed)
    return new_game(3, lut)


def _swap_opponent_hands(state):
    """Same public state and acting hand; opponents hold each other's cards."""
    other = copy.deepcopy(state)
    a, b = [p for i, p in enumerate(other.players) if i != other.player_i]
    a.cards, b.cards = b.cards, a.cards
    return other


def test_seat_view_contains_only_the_acting_seats_cards():
    state = _state()
    view = seat_view(state)
    acting = state.current_player
    assert view.seat == state.player_i
    assert view.hole_cards == tuple(acting.cards)
    assert view.legal_actions == ("fold", "call", "raise")
    hidden = {c for p in state.players if p is not acting for c in p.cards}
    shown = set(view.hole_cards) | set(view.community_cards)
    assert not hidden & shown
    assert view == seat_view(_swap_opponent_hands(state))


def test_seat_view_rejects_terminal_state():
    state = _state()
    while not state.is_terminal:
        state = state.apply_action("fold")
    with pytest.raises(ValueError):
        seat_view(state)


@pytest.mark.parametrize("make_policy", [
    lambda rng: RandomPolicy(rng),
    lambda rng: CheckpointPolicy({}, rng),
], ids=["random", "checkpoint"])
def test_policies_choose_legal_actions_from_the_seat_view(make_policy):
    """Play hands through the policy alone; decisions ignore hidden cards."""
    for seed in range(20):
        state = _state(seed)
        while not state.is_terminal:
            view = seat_view(state)
            twin = seat_view(_swap_opponent_hands(state))
            action = make_policy(random.Random(seed)).choose(view)
            assert action == make_policy(random.Random(seed)).choose(twin)
            assert action in view.legal_actions
            state = state.apply_action(action)


def _view(info_set, legal=("fold", "call", "raise")):
    return SeatView(
        seat=0, hole_cards=(), community_cards=(), betting_stage="pre_flop",
        history=(), legal_actions=legal, pot=150, stacks=(), bets=(),
        info_set=info_set,
    )


def test_checkpoint_policy_weights_and_fallbacks():
    policy = CheckpointPolicy({
        "seen": {"fold": 1.0, "call": 3.0, "raise": 0.0},
        "raise_heavy": {"fold": 1.0, "call": 1.0, "raise": 2.0},
        "zero": {"fold": 0.0, "call": 0.0},
    })
    assert policy.action_probabilities(_view("seen")) == {
        "fold": 0.25, "call": 0.75, "raise": 0.0}
    # Weights on actions that are not legal here are dropped.
    assert policy.action_probabilities(_view("raise_heavy", ("fold", "call"))) == {
        "fold": 0.5, "call": 0.5}
    uniform = {a: 1 / 3 for a in ("fold", "call", "raise")}
    assert not policy.has_info_set(_view("unseen"))
    assert policy.action_probabilities(_view("unseen")) == uniform
    assert policy.action_probabilities(_view("zero")) == uniform
    with pytest.raises(ValueError):
        policy.action_probabilities(_view(None))


def test_checkpoint_policy_samples_by_weight():
    policy = CheckpointPolicy({"seen": {"fold": 0.0, "call": 1.0, "raise": 0.0}},
                              rng=random.Random(0))
    assert {policy.choose(_view("seen")) for _ in range(50)} == {"call"}
    unseen = {policy.choose(_view("unseen")) for _ in range(200)}
    assert unseen == {"fold", "call", "raise"}


def test_checkpoint_policy_loads_agent_checkpoint(tmp_path):
    joblib.dump({"strategy": {"seen": {"call": 2.0}}, "regret": {}},
                tmp_path / "agent.joblib")
    policy = CheckpointPolicy.from_checkpoint(tmp_path / "agent.joblib")
    assert policy.choose(_view("seen", ("fold", "call"))) == "call"


@pytest.fixture
def terminal(tmp_path, monkeypatch):
    """Run the terminal client headless: Enter on every human prompt."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(terminal_runner, "BOT_DELAY_SECONDS", 0)
    monkeypatch.setattr(Terminal, "inkey",
                        lambda self, timeout=None: Keystroke("\n", 343, "KEY_ENTER"))
    calls = []
    original = terminal_runner.make_policy

    def recording_policy(agent, strategy_path=""):
        policy = original(agent, strategy_path)
        choose = policy.choose

        def record(view):
            action = choose(view)
            calls.append((view, action))
            return action
        policy.choose = record
        return policy
    monkeypatch.setattr(terminal_runner, "make_policy", recording_policy)
    return calls


@pytest.mark.parametrize("agent", ["random", "offline"])
def test_terminal_completes_a_hand_with_each_policy(tmp_path, terminal, agent):
    args = ["play", "--agent", agent]
    if agent == "offline":
        write_single_bucket_lut(tmp_path)
        joblib.dump({"strategy": {}}, tmp_path / "agent.joblib")
        args += ["--lut_path", str(tmp_path),
                 "--strategy_path", str(tmp_path / "agent.joblib")]
    result = CliRunner().invoke(cli, args, catch_exceptions=False)
    assert result.exit_code == 0, result.output
    # The human folds at its first prompt, the bots finish the hand, and
    # Enter on "quit" records the result.
    assert terminal, "no bot acted"
    for view, action in terminal:
        assert isinstance(view, SeatView)
        assert action in view.legal_actions
        assert (view.info_set is not None) == (agent == "offline")
    with open(tmp_path / ".poker" / "results.yaml") as f:
        results = yaml.safe_load(f)
    assert len(results["results"]) == 1
    assert results["results"][0]["ai_key"].startswith(agent)
    assert sum(p["args"]["value"] for p in results["results"][0]["players"]) == 0
