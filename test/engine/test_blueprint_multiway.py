"""Trees, training and play for tables of more than two (P5.6, ``docs/bots.md``)."""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

import numpy as np
import pytest

from rivermind.bots import CallingStationPolicy, HeuristicPolicy, RandomPolicy
from rivermind.bots.blueprint import Game, Settings, Trainer, compile_tree, info_set_key, latest_checkpoint, read_manifest
from rivermind.bots.blueprint.abstraction import ABSTRACTIONS, abstract_actions, street_level
from rivermind.bots.blueprint.bundle import BundleError, ServingBundle, synthetic_bundle
from rivermind.bots.blueprint.mccfr import Chunk, run_chunk
from rivermind.bots.blueprint.policy import BlueprintPolicy, MultiwayBlueprintPolicy, policy_for
from rivermind.bots.blueprint.tree import FOLD, SHOWDOWN, Tree, tree_cache
from rivermind.bots.match import Matchup, deck_for, position_names, run_matchup
from rivermind.engine import Action, HandConfig, apply, legal_actions, start_hand
from rivermind.engine.view import seat_view

from .multiway_helpers import HU_TWIN, SIX, STRENGTHS, TINY, TINY_UNMERGED, StrengthDealer, tiny_game, tiny_tree

SIX_MAX = {
    50: (345_581, (79_677, 152_895, 254_203, 272_733), 15_179, "cc952203fb974367c81d7a97ce840458e279c1edb10ac75318b8a015c7383f59"),
    100: (654_597, (79_677, 273_876, 519_398, 584_447), 29_103, "2da67fafbe203a63044e0aa754c02ffdd3c6cf54a106e33449de8e344392b4e3"),
}
"""The ``6max-s1`` graphs of the design: decision nodes, widths, terminals and SHA-256."""


@pytest.fixture(scope="module")
def six() -> Tree:
    """The 50 big blind ``6max-s1`` graph: half a minute to compile where no cache file holds it."""
    return compile_tree(50, SIX)


def settings(**changes: object) -> Settings:
    base = dict(
        abstraction=TINY.name,
        depths=(20,),
        chunk_size=100,
        chunks_per_batch=4,
        discount_every=2_000,
        discount_until=8_000,
        prune_after=10**9,
        prune_threshold=-200_000,
        regret_floor=-220_000,
    )
    base.update(changes)
    return Settings(**base)  # type: ignore[arg-type]


def trainer(run: Path, s: Settings | None = None, workers: int = 1) -> Trainer:
    return Trainer(run, s or settings(), StrengthDealer(), game=tiny_game(), workers=workers)


def arrays(t: Trainer) -> tuple[bytes, bytes]:
    return np.asarray(t.regrets).tobytes(), t.strategy.tobytes()


# Trees


def test_the_six_seat_graph_matches_the_design(six: Tree) -> None:
    nodes, widths, terminals, sha = SIX_MAX[50]
    assert (len(six), six.width, len(six.terminal_kind), six.sha256) == (nodes, widths, terminals, sha)
    assert six.seats == 6 and six.merged and six.multiway
    assert [len(s) for s in six.starts] == [1, 1_936, 5_163, 6_172]
    # Seat 3 opens: it may fold, call the big blind, raise to 2.5 big blinds or move all-in.
    assert six.player[0] == 3 and six.tokens[0] == ("f", "c", "r0", "a")
    assert six.contribution[0] == 0 and six.live[0] == 0b111111
    # Folded round to the small blind, who completes; the big blind may check.
    v = six.node("ffffc")
    assert six.player[six.node("fff")] == 0 and six.player[six.node("ffff")] == 1
    assert six.player[v] == 2 and six.tokens[v][0] == "k"
    assert six.live[v] == 0b000110 and six.history_of(v) == "ffffc"


def test_the_deeper_six_seat_graph_matches_the_design() -> None:
    path = tree_cache(100, SIX)
    if path is None or not path.exists():
        pytest.skip("the 100 big blind graph is not cached; `rivermind-poker blueprint tree --abstraction 6max-s1` compiles it")
    tree = compile_tree(100, SIX)
    nodes, widths, terminals, sha = SIX_MAX[100]
    assert (len(tree), tree.width, len(tree.terminal_kind), tree.sha256) == (nodes, widths, terminals, sha)


def test_a_two_seat_tree_compiled_the_multiway_way_is_the_heads_up_tree() -> None:
    hu = compile_tree(50)
    twin = tiny_tree(HU_TWIN, 50)
    assert (twin.player, twin.street, twin.offset, twin.tokens, twin.width) == (hu.player, hu.street, hu.offset, hu.tokens, hu.width)
    assert [twin.history_of(v) for v in range(len(twin))] == hu.history
    for kids, others in zip(twin.children, hu.children):
        for c, o in zip(kids, others):
            assert (c < 0) == (o < 0)
            if c >= 0:
                assert c == o
                continue
            t, u = ~c, ~o
            each, pot, live = twin.terminal_value[t], twin.terminal_pot[t], twin.terminal_live[t]
            if hu.terminal_kind[u] == SHOWDOWN:
                assert twin.terminal_kind[t] == SHOWDOWN and each == hu.terminal_value[u] and pot == 2 * each and live == (0, 1)
            else:
                assert twin.terminal_kind[t] == FOLD and len(live) == 1
                assert (pot - each) * (1 if live[0] == 0 else -1) == hu.terminal_value[u]
    assert twin.sha256 != hu.sha256  # a multiway tree hashes different fields


def test_merging_keeps_every_line_of_the_betting() -> None:
    tree, graph = tiny_tree(TINY_UNMERGED), tiny_tree()
    assert len(graph) < len(tree) / 2 and not tree.merged and graph.merged

    def terminal(t: Tree, c: int) -> tuple[object, ...]:
        return (t.terminal_kind[~c], t.terminal_value[~c], t.terminal_pot[~c], t.terminal_live[~c])

    seen = 0
    stack = [(0, 0)]
    while stack:
        v, g = stack.pop()
        seen += 1
        fields = ("player", "street", "tokens", "contribution", "live", "folds", "measure", "spr")
        assert all(getattr(tree, f)[v] == getattr(graph, f)[g] for f in fields)
        assert graph.node(tree.history_of(v)) == g
        for c, k in zip(tree.children[v], graph.children[g]):
            if c < 0:
                assert k < 0 and terminal(tree, c) == terminal(graph, k)
            else:
                stack.append((c, k))
    assert seen == len(tree)
    assert info_set_key(graph, graph.node("r0fc/k"), 4) == f"test-3max|20|F|4|{graph.history_of(graph.node('r0fc/k'))}"
    with pytest.raises(KeyError):
        graph.node("r0x")


def test_the_graph_pays_what_the_engine_pays() -> None:
    """Random lines through the graph, played on the engine with real cards: every seat's result agrees."""
    graph = tiny_tree()
    stack = graph.stack
    rng = random.Random(11)
    showdowns = folds = 0
    for deal in range(400):
        state = start_hand(HandConfig(50, 100), [stack] * 3, 0, deck=deck_for(3, deal))
        v = 0
        lost_at_fold: dict[int, int] = {}
        while True:
            assert not state.is_over and state.to_act == graph.player[v]
            legal = legal_actions(state)
            options = abstract_actions(
                legal,
                street=state.street,
                level=street_level(state.actions, state.street),
                pot=state.pot,
                current_bet=state.current_bet,
                street_bets=state.street_bets,
                abstraction=TINY,
            )
            assert tuple(o.token for o in options) == graph.tokens[v]
            i = rng.randrange(len(options))
            if options[i].token == "f":
                lost_at_fold[graph.player[v]] = graph.contribution[v]
            state = apply(state, options[i].action)
            v = graph.children[v][i]
            if v < 0:
                break
        assert state.is_over and state.result is not None
        t = ~v
        won = [(f or 0) - stack for f in state.final_stacks]
        each, pot, live = graph.terminal_value[t], graph.terminal_pot[t], graph.terminal_live[t]
        assert pot == sum(state.contributions) and set(live) == {s for s in range(3) if not state.folded[s]}
        for seat, lost in lost_at_fold.items():
            assert won[seat] == -lost
        if graph.terminal_kind[t] == FOLD:
            folds += 1
            assert won[live[0]] == pot - each
        else:
            showdowns += 1
            winners = [s for s in live if won[s] > -each]
            for s in live:
                expected = pot / len(winners) - each if s in winners else -each
                assert abs(won[s] - expected) < 1  # the engine gives an odd chip to one seat
    assert showdowns > 50 and folds > 50


# Training


class TwinDealer(StrengthDealer):
    buckets = (STRENGTHS, 3, 3, 3)

    def deal_seats(self, rng: np.random.Generator, n: int, seats: int) -> tuple[np.ndarray, np.ndarray]:
        buckets = np.stack([rng.integers(0, b, (n, seats)) for b in self.buckets], axis=2).astype(np.int64)
        return buckets, rng.integers(0, 4, (n, seats)).astype(np.int64)


def test_the_multiway_walk_makes_the_heads_up_walks_updates() -> None:
    """On two seats and an unmerged tree, the same draws, regrets and sums as the heads-up walk."""
    dealer = TwinDealer()
    hu = Game((compile_tree(50),), dealer.buckets)
    twin = Game((tiny_tree(HU_TWIN, 50),), dealer.buckets)
    assert hu.size == twin.size and twin.trees[0].multiway and not hu.trees[0].multiway
    regrets = np.zeros(hu.size, dtype=np.int32)
    for k in range(5):
        chunk = Chunk(index=k, first=k * 300, size=300, seed=4, prune_after=600, prune_probability=0.9, prune_threshold=-3_000)
        a = run_chunk(hu, regrets, dealer, chunk)
        b = run_chunk(twin, regrets, dealer, chunk)
        for name in ("regret_slots", "regret_deltas", "strategy_slots", "strategy_deltas"):
            assert np.array_equal(getattr(a, name), getattr(b, name)), (k, name)
        assert a.nodes == b.nodes and len(a.regret_slots) > 1_000
        regrets[a.regret_slots] = np.clip(regrets[a.regret_slots] + 30 * a.regret_deltas, -10**6, 10**6).astype(np.int32)
    assert int(regrets.min()) < -3_000  # so the later chunks pruned


def test_a_multiway_run_does_not_depend_on_the_number_of_workers(tmp_path: Path) -> None:
    s = settings(prune_after=2_000, discount_every=800, discount_until=2_400, prune_threshold=-20_000, regret_floor=-22_000)
    with trainer(tmp_path / "one", s) as one:
        one.train(4_000)
    with trainer(tmp_path / "three", s, workers=3) as three:
        three.train(4_000)
    assert arrays(one) == arrays(three)
    a = read_manifest(latest_checkpoint(tmp_path / "one"))  # type: ignore[arg-type]
    b = read_manifest(latest_checkpoint(tmp_path / "three"))  # type: ignore[arg-type]
    assert a["files"] == b["files"] and a["game"]["trees"][0]["sha256"] == tiny_tree().sha256


def test_resuming_a_multiway_run_reproduces_an_uninterrupted_one(tmp_path: Path) -> None:
    s = settings(prune_after=2_000, discount_every=800, discount_until=2_400, prune_threshold=-20_000, regret_floor=-22_000)
    with trainer(tmp_path / "straight", s) as straight:
        straight.train(4_000)
    with trainer(tmp_path / "split", s) as first:
        first.train(1_500, checkpoint_every=800)
    with Trainer.resume(tmp_path / "split", StrengthDealer(), game=tiny_game(), workers=2) as resumed:
        assert resumed.iteration == 1_600
        resumed.train(4_000)
    assert arrays(resumed) == arrays(straight)


def test_multiway_training_learns_to_fold_weak_hands_and_keep_strong_ones(tmp_path: Path) -> None:
    with trainer(tmp_path / "run") as t:
        t.train(60_000)
        game = t.game
        tree = game.trees[0]

        def average(history: str, bucket: int) -> dict[str, float]:
            node = tree.node(history)
            slot = game.slot(0, node, bucket)
            sums = t.strategy[slot : slot + len(tree.tokens[node])]
            assert sums.sum() > 0
            return dict(zip(tree.tokens[node], (sums / sums.sum()).tolist()))

        # The button opens for 20 big blinds; the small blind folds its worst hands and never its best.
        assert average("a", 0)["f"] > 0.9 and average("a", STRENGTHS - 1)["f"] < 0.05
        # Facing nothing but the blinds, the best hand does not fold either.
        assert average("", STRENGTHS - 1)["f"] < 0.05
        touched = (np.asarray(t.regrets) != 0) | (t.strategy != 0)
        assert touched.mean() > 0.5


# Play


class FakeBlueprint:
    """A tree with one bucket a street and a strategy the test writes; uniform where it writes nothing."""

    def __init__(self, tree: Tree, name: str) -> None:
        self.game = Game((tree,), (1, 1, 1, 1))
        self.strategy = np.ones(self.game.size)
        self.manifest = {"cards": {"sha256": {"fake": "0"}}, "abstraction": name}

    def always(self, history: str, token: str) -> None:
        tree = self.game.trees[0]
        node = tree.node(history)
        slot = self.game.slot(0, node, 0)
        self.strategy[slot : slot + len(tree.tokens[node])] = 0
        self.strategy[slot + tree.tokens[node].index(token)] = 1


class FakeTables:
    sha256 = {"fake": "0"}

    def bucket(self, hole: object, board: object = ()) -> int:
        return 0


def six_policy(tree: Tree) -> MultiwayBlueprintPolicy:
    policy = policy_for(FakeBlueprint(tree, SIX.name), FakeTables())  # type: ignore[arg-type]
    assert isinstance(policy, MultiwayBlueprintPolicy)
    return policy


def play(policies: dict[int, object], stacks: list[int | None], button: int, deck: list[int], seed: int) -> None:
    """Play a hand to the end; the engine raises on an illegal action."""
    state = start_hand(HandConfig(50, 100), stacks, button, deck=deck)
    rngs = {s: random.Random(seed * 100 + s) for s in policies}
    for policy in policies.values():
        if hasattr(policy, "new_hand"):
            policy.new_hand()
    while not state.is_over:
        seat = state.to_act
        assert seat is not None
        state = apply(state, policies[seat].act(seat_view(state, seat), rngs[seat]))  # type: ignore[attr-defined]


def test_the_policy_classes_follow_the_table_size(six: Tree) -> None:
    assert type(six_policy(six)) is MultiwayBlueprintPolicy
    hu = policy_for(FakeBlueprint(compile_tree(50), "hu-m1"), FakeTables())  # type: ignore[arg-type]
    assert type(hu) is BlueprintPolicy
    assert set(ABSTRACTIONS) == {"hu-m1", "6max-s1"}


def test_real_seats_take_tree_seats_by_position(six: Tree) -> None:
    bot = six_policy(six)

    def seats(stacks: list[int | None], button: int) -> dict[int, int]:
        return bot.tree_seats(seat_view(start_hand(HandConfig(50, 100), stacks, button, deck=deck_for(0, 0)), button))

    full = [5_000] * 6
    assert seats(full, 0) == {0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5}
    assert seats(full, 4) == {4: 0, 5: 1, 0: 2, 1: 3, 2: 4, 3: 5}
    # Four dealt in at a table of six are the cutoff, the button and the blinds; three are the button and the blinds.
    assert seats([5_000, None, 5_000, 5_000, None, 5_000], 2) == {2: 0, 3: 1, 5: 2, 0: 5}
    assert seats([None, 5_000, None, 5_000, 5_000, None], 3) == {3: 0, 4: 1, 1: 2}
    five = seats([5_000, 5_000, None, 5_000, 5_000, 5_000], 0)
    assert five == {0: 0, 1: 1, 3: 2, 4: 4, 5: 5}
    with pytest.raises(ValueError, match="three to 6"):
        state = start_hand(HandConfig(50, 100), [5_000, None, None, 5_000, None, None], 0, deck=deck_for(0, 0))
        bot.act(seat_view(state, state.to_act), random.Random(0))  # type: ignore[arg-type]


def test_its_own_sizes_come_from_the_real_pot(six: Tree) -> None:
    bp = FakeBlueprint(six, SIX.name)
    bp.always("", "r0")
    bp.always("r0", "r0")
    bot = policy_for(bp, FakeTables())  # type: ignore[arg-type]
    state = start_hand(HandConfig(50, 100), [5_000] * 6, 0, deck=deck_for(0, 0))
    assert bot.act(seat_view(state, 3), random.Random(0)) == Action.raise_to(250)
    state = apply(state, Action.raise_to(250))
    assert bot.act(seat_view(state, 4), random.Random(0)) == Action.raise_to(750)
    # Other stakes, and three dealt in: the button opens from the node where three tree seats have folded.
    bp.always("fff", "r0")
    state = start_hand(HandConfig(10, 20), [None, 1_000, None, 1_000, None, 1_000], 3, deck=deck_for(0, 0))
    assert state.to_act == 3 and bot.act(seat_view(state, 3), random.Random(0)) == Action.raise_to(50)
    assert bot.stats["lost"] == 0 and bot.stats["trained"] == 3


@pytest.mark.parametrize("dealt", [6, 5, 4, 3])
def test_blueprints_playing_each_other_stay_on_the_graph(six: Tree, dealt: int) -> None:
    """With equal stacks at the depth class and nobody off the tree, every decision finds its node without mapping."""
    stacks: list[int | None] = [5_000] * dealt + [None] * (6 - dealt)
    bots = {s: six_policy(six) for s in range(dealt)}
    for hand in range(60):
        order = list(stacks)
        random.Random(hand).shuffle(order)
        seats = [s for s, x in enumerate(order) if x is not None]
        play({s: bots[i] for i, s in enumerate(seats)}, order, seats[hand % dealt], deck_for(dealt, hand), hand)
    for bot in bots.values():
        assert bot.stats["decisions"] > 60
        assert bot.stats["trained"] == bot.stats["decisions"]
        assert not any(bot.stats[k] for k in ("lost", "reentries", "off_tree", "below_smallest", "resized", "passed"))


def test_the_policy_keeps_its_place_among_other_players_and_stacks(six: Tree) -> None:
    """Against bots that bet any amount, with short and deep stacks: always a legal action, and rarely lost."""
    bot = six_policy(six)
    others = [RandomPolicy(), CallingStationPolicy(), HeuristicPolicy(), RandomPolicy(), HeuristicPolicy()]
    stack_rng = random.Random(5)
    for hand in range(300):
        dealt = 3 + hand % 4
        stacks: list[int | None] = [stack_rng.choice([700, 2_000, 4_000, 5_000, 10_000, 15_000]) for _ in range(dealt)] + [None] * (6 - dealt)
        stack_rng.shuffle(stacks)
        seats = [s for s, x in enumerate(stacks) if x is not None]
        policies: dict[int, object] = {s: others[i - 1] for i, s in enumerate(seats) if i}
        policies[seats[0]] = bot
        play(policies, stacks, seats[hand % dealt], deck_for(9, hand), hand)
    stats = bot.stats
    assert stats["decisions"] > 400 and stats["off_tree"] > 50 and stats["reentries"] > 20 and stats["passed"] > 0
    assert stats["trained"] + stats["lost"] == stats["decisions"]
    assert stats["lost"] / stats["decisions"] < 0.02


# Serving bundles


def test_a_six_seat_bundle_is_format_two_and_plays(six: Tree, tmp_path: Path) -> None:
    manifest = synthetic_bundle(tmp_path / "bundle", seed=3, abstraction=SIX.name, depths=(50,))
    assert manifest["format"] == 2 and manifest["abstraction"] == SIX.name
    assert [t["sha256"] for t in manifest["game"]["trees"]] == [six.sha256]
    bundle = ServingBundle(tmp_path / "bundle")
    assert bundle.game.seats == 6 and bundle.game.size == manifest["game"]["size"]
    # The columns of trees.json hold the whole graph: a reader rebuilds it and its SHA-256 from them alone.
    (doc,) = json.loads((tmp_path / "bundle" / "trees.json").read_text())
    counts = [len(doc["token_sets"][i]) for i in doc["tokens"]]
    assert sum(counts) == len(doc["children"]) == sum(len(c) for c in six.children)
    digest = hashlib.sha256()
    head = {k: doc[k] for k in ("abstraction", "depth")} | {"blinds": [doc["small_blind"], doc["big_blind"]]}
    head |= {"seats": doc["seats"], "merged": doc["merged"], "width": doc["width"]}
    digest.update(json.dumps(head, separators=(",", ":")).encode())
    at = 0
    for v, n in enumerate(counts):
        row = [doc["player"][v], doc["street"][v], doc["offset"][v], doc["token_sets"][doc["tokens"][v]]]
        row += [doc["children"][at : at + n], doc["contribution"][v], doc["live"][v]]
        digest.update(json.dumps(row, separators=(",", ":")).encode())
        at += n
    for kind, each, pot, live in zip(doc["terminal_kind"], doc["terminal_value"], doc["terminal_pot"], doc["terminal_live"]):
        seats = [seat for seat in range(6) if live >> seat & 1]
        digest.update(json.dumps([kind, each, pot, seats], separators=(",", ":")).encode())
    assert digest.hexdigest() == six.sha256 == doc["sha256"]
    assert [doc["measure_sets"][i] for i in doc["measure"][:50]] == [list(m) for m in six.measure[:50]]
    assert doc["spr"][:50] == six.spr[:50] and [tuple(x) for x in doc["starts"]] == list(six.starts)

    bot = bundle.policy()
    assert isinstance(bot, MultiwayBlueprintPolicy)
    others = [RandomPolicy(), HeuristicPolicy(), CallingStationPolicy(), HeuristicPolicy(), RandomPolicy()]
    for hand in range(40):
        play({0: bot, **{s: others[s - 1] for s in range(1, 6)}}, [5_000] * 6, hand % 6, deck_for(4, hand), hand)
    assert bot.stats["decisions"] > 60 and bot.stats["untrained_node"] + bot.stats["borrowed"] > 0

    damaged = json.loads((tmp_path / "bundle" / "manifest.json").read_text())
    damaged["format"] = 1
    (tmp_path / "bundle" / "manifest.json").write_text(json.dumps(damaged))
    with pytest.raises(BundleError, match="format does not suit"):
        ServingBundle(tmp_path / "bundle")


# The harness


def test_position_names() -> None:
    assert position_names(2) == ["button", "big_blind"]
    assert position_names(6) == ["button", "small_blind", "big_blind", "utg", "hijack", "cutoff"]
    assert position_names(9)[3:] == ["utg", "utg+1", "utg+2", "lojack", "hijack", "cutoff"]


def test_a_full_table_of_one_bot_scores_zero() -> None:
    result = run_matchup(Matchup("calling_station", "calling_station", deals=30, seats=6))
    summary = result.summary()
    assert summary["bb_per_100"] == 0 and summary["ci95_bb_per_100"] == [0, 0]
    assert summary["hands"] == 180 and summary["showdown_share"] == 1
    assert set(summary["position_bb_per_100"]) == set(position_names(6))


def test_a_full_table_match_is_reproducible_and_rotates_every_seat() -> None:
    matchup = Matchup("heuristic", "random", deals=120, seed=2, seats=6)
    one = run_matchup(matchup, workers=1)
    two = run_matchup(matchup, workers=3)
    assert one.summary() == two.summary()
    summary = one.summary()
    by_seat = summary["position_bb_per_100"]
    assert summary["bb_per_100"] == pytest.approx(sum(by_seat.values()) / 6, abs=0.02)
    assert summary["button_bb_per_100"] == by_seat["button"] and summary["big_blind_bb_per_100"] == by_seat["big_blind"]
    assert run_matchup(Matchup("heuristic", "random", deals=120, seed=3, seats=6)).summary() != summary
