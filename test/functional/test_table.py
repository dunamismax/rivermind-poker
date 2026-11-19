"""RM-07: a server-owned play-chip table."""
import copy
import json
import random

import pytest

from poker_ai.poker.card import Card
from poker_ai.poker.evaluation import Evaluator
from poker_ai.policies import RandomPolicy
from poker_ai.table import POSITIONS, SeatConfig, Table, TableError


class Always:
    """Bot that takes one action whenever it is legal, else calls."""

    def __init__(self, action):
        self.name = action
        self._action = action

    def choose(self, view):
        return self._action if self._action in view.legal_actions else "call"


def _two_humans(bot=None, seed=1):
    table = Table(
        [SeatConfig("Ann"), SeatConfig("Bob"), SeatConfig("Bot", bot or Always("call"))],
        seed=seed,
    )
    return table, table.tokens[0], table.tokens[1]


def _acting(table, tokens):
    for token in tokens:
        view = table.view(token)
        if view["your_turn"]:
            return token, view
    raise AssertionError("no human to act")


def _cards(view, seat):
    return view["seats"][seat]["cards"]


def test_rejects_duplicate_stale_and_out_of_turn_actions():
    table, ann, bob = _two_humans()
    actor, view = _acting(table, [ann, bob])
    waiter = bob if actor == ann else ann
    applied = 0
    for token, action, seq, code in [
        (waiter, "call", view["seq"], "not_your_turn"),
        (actor, "check", view["seq"], "illegal_action"),
        (actor, "call", view["seq"] - 1, "stale"),
        ("not-a-token", "call", view["seq"], "unknown_seat"),
        (actor, "call", view["seq"], None),
        (actor, "call", view["seq"], "stale"),  # the same request again
    ]:
        snapshot = [copy.deepcopy(table.view(t)) for t in (ann, bob)]
        if code is None:
            after = table.act(token, action, seq)
            assert after["seq"] > seq
            assert after["events"][len(snapshot[0]["events"])] == {
                "seat": snapshot[0]["seats"].index(
                    next(x for x in snapshot[0]["seats"] if x["is_turn"])),
                "action": "call", "stage": "pre_flop",
                "chips": snapshot[0]["action_amounts"].get("call")
                if snapshot[0]["your_turn"] else snapshot[1]["action_amounts"]["call"],
                "facing": snapshot[0]["action_amounts"].get("call")
                if snapshot[0]["your_turn"] else snapshot[1]["action_amounts"]["call"]}
            applied += 1
            continue
        with pytest.raises(TableError) as error:
            table.act(token, action, seq)
        assert error.value.code == code
        # A rejected request leaves every seat's view unchanged.
        assert [table.view(t) for t in (ann, bob)] == snapshot
    assert applied == 1


def test_each_seat_sees_only_its_own_cards_mid_hand_and_after_reconnect():
    table, ann, bob = _two_humans(seed=3)
    actor, view = _acting(table, [ann, bob])
    table.act(actor, "call", view["seq"])
    views = {0: table.view(ann), 1: table.view(bob)}
    assert views[0]["result"] is None
    for seat, view in views.items():
        other = 1 - seat
        assert view["seat"] == seat
        assert len(_cards(view, seat)) == 2
        assert _cards(view, other) is None and _cards(view, 2) is None
        hidden = {json.dumps(c, sort_keys=True)
                  for c in _cards(views[other], other)}
        assert not any(json.dumps(c, sort_keys=True) in hidden
                       for c in _cards(view, seat) + view["board"])
        assert view["legal_actions"] == (
            ["fold", "call", "raise"] if view["your_turn"] else [])
    public = ["hand", "seq", "stage", "board", "pot", "events"]
    assert {k: views[0][k] for k in public} == {k: views[1][k] for k in public}
    strip = [{k: v for k, v in s.items() if k != "cards"} for s in views[0]["seats"]]
    assert strip == [{k: v for k, v in s.items() if k != "cards"}
                     for s in views[1]["seats"]]
    # A reconnecting client only has its token and gets the same view back.
    assert table.view(ann) == views[0] and table.view(bob) == views[1]
    assert sum(v["your_turn"] for v in views.values()) <= 1


def _play_out(table, tokens, action="call"):
    while True:
        view = table.view(tokens[0])
        if view["result"] is not None:
            return view
        actor, view = _acting(table, tokens)
        table.act(actor, action if action in view["legal_actions"] else "call",
                  view["seq"])


def test_showdown_discloses_active_hands_and_pays_the_best():
    table, ann, bob = _two_humans(seed=5)
    final = _play_out(table, [ann, bob])
    assert final["stage"] == "show_down" and final["result"]["showdown"]
    assert len(final["board"]) == 5
    bob_view = table.view(bob)
    for view in (final, bob_view):
        assert all(len(s["cards"]) == 2 for s in view["seats"])
    payouts = {int(k): v for k, v in final["result"]["payouts"].items()}
    assert sum(payouts.values()) == 0
    evaluator = Evaluator()
    board = [Card.from_dict(c).eval_card for c in final["board"]]
    ranks = {s["seat"]: evaluator.evaluate(
        board, [Card.from_dict(c).eval_card for c in s["cards"]])
        for s in final["seats"]}
    best = min(ranks.values())
    for seat, rank in ranks.items():
        assert (payouts[seat] > 0) == (rank == best)
    assert [s["balance"] for s in final["seats"]] == [payouts[i] for i in range(3)]
    assert final["legal_actions"] == []
    with pytest.raises(TableError) as error:
        table.act(ann, "call", final["seq"])
    assert error.value.code == "hand_over"


def test_fold_out_reveals_no_cards_and_hides_the_undealt_flop():
    table = Table([SeatConfig("Ann"), SeatConfig("Bot 1", Always("fold")),
                   SeatConfig("Bot 2", Always("fold"))], seed=2)
    ann = table.tokens[0]
    final = _play_out(table, [ann], action="raise")
    assert final["result"] == {"payouts": final["result"]["payouts"],
                               "showdown": False}
    assert final["stage"] == "terminal"
    assert final["board"] == []
    assert _cards(final, 1) is None and _cards(final, 2) is None
    assert final["result"]["payouts"][0] > 0
    assert sum(final["result"]["payouts"].values()) == 0
    assert [e["action"] for e in final["events"]].count("fold") == 2


def test_next_hand_rotates_positions_and_keeps_balances():
    table = Table([SeatConfig("Ann"), SeatConfig("Bot 1", RandomPolicy(random.Random(1))),
                   SeatConfig("Bot 2", RandomPolicy(random.Random(2)))], seed=9)
    ann = table.tokens[0]
    view = table.view(ann)
    with pytest.raises(TableError) as error:
        table.next_hand(ann, view["seq"])
    assert error.value.code == "hand_in_progress"
    balances = [0, 0, 0]
    positions = []
    for hand in range(1, 7):
        final = _play_out(table, [ann])
        assert final["hand"] == hand
        positions.append(final["seats"][0]["position"])
        for seat in range(3):
            balances[seat] += final["result"]["payouts"][seat]
        assert [s["balance"] for s in final["seats"]] == balances
        nxt = table.next_hand(ann, final["seq"])
        assert nxt["hand"] == hand + 1
        with pytest.raises(TableError):
            table.next_hand(ann, final["seq"])  # duplicate request
    # The button moves one seat each hand, so a seat goes SB, button, BB.
    assert positions == ["small_blind", "button", "big_blind"] * 2
    assert sorted(positions[:3]) == sorted(POSITIONS)
    assert sum(balances) == 0


def test_action_amounts_follow_fixed_limit_sizes():
    table = Table([SeatConfig("Ann"), SeatConfig("Bot 1", Always("call")),
                   SeatConfig("Bot 2", Always("call"))], seed=4)
    ann = table.tokens[0]
    seen = set()
    while True:
        view = table.view(ann)
        if view["result"] is not None:
            break
        assert view["your_turn"]
        me = view["seats"][0]
        to_call = max(s["bet"] for s in view["seats"]) - me["bet"]
        bet = 200 if view["stage"] in {"turn", "river"} else 100
        assert view["action_amounts"] == {
            "fold": 0, "call": to_call, "raise": to_call + bet}
        seen.add(view["stage"])
        table.act(ann, "call", view["seq"])
    assert {"pre_flop", "flop", "turn", "river"} <= seen
    assert table.view(ann)["action_amounts"] == {}


def test_events_record_chips_and_final_pot():
    table = Table([SeatConfig("Ann"), SeatConfig("Bot 1", Always("call")),
                   SeatConfig("Bot 2", Always("call"))], seed=4)
    final = _play_out(table, [table.tokens[0]])
    # Everyone calls to showdown: preflop the blinds complete, later streets
    # are checks (calls of zero chips).
    later = [e for e in final["events"] if e["stage"] != "pre_flop"]
    assert later and all(e["chips"] == 0 and e["facing"] == 0 for e in later)
    pre = [e for e in final["events"] if e["stage"] == "pre_flop"]
    assert sum(e["chips"] for e in pre) + 150 == final["pot"] == 300
    payouts = final["result"]["payouts"]
    assert max(payouts.values()) <= final["pot"]


def _always_bots():
    return {1: Always("call"), 2: Always("raise")}


def test_restored_table_continues_exactly_like_the_original():
    """Snapshots carry the engine state, deck RNG, log and balances."""
    import pickle
    original = Table([SeatConfig("Ann"), SeatConfig("Bot 1", Always("call")),
                      SeatConfig("Bot 2", Always("raise"))], seed=12)
    ann = original.tokens[0]
    # Finish one hand and start the next, then stop mid-hand.
    final = _play_out(original, [ann])
    view = original.next_hand(ann, final["seq"])
    original.act(ann, "call", view["seq"])
    snapshot = pickle.loads(pickle.dumps(original.snapshot()))
    # The shared evaluator (~56 KB) is left out of every saved table.
    assert len(snapshot["state"]) < 20_000
    copy_ = Table.restore(snapshot, _always_bots())
    assert copy_.view(ann) == original.view(ann)
    # Both tables now play identically: same future cards and results.
    for _ in range(3):
        for table in (original, copy_):
            v = table.view(ann)
            if v["result"] is None:
                table.act(ann, "raise" if "raise" in v["legal_actions"] else "call",
                          v["seq"])
            else:
                table.next_hand(ann, v["seq"])
        assert copy_.view(ann) == original.view(ann)


def test_restore_rejects_other_snapshot_versions():
    table, ann, _ = _two_humans()
    snapshot = table.snapshot()
    snapshot["version"] = 0
    with pytest.raises(ValueError):
        Table.restore(snapshot, {2: Always("call")})


def test_snapshot_of_checkpoint_table_needs_card_tables():
    from collections import defaultdict
    from test.functional.training_helpers import STAGES
    lut = {stage: defaultdict(int) for stage in STAGES}
    table = Table([SeatConfig("Ann"), SeatConfig("Bot 1", Always("call")),
                   SeatConfig("Bot 2", Always("call"))], card_info_lut=lut, seed=1)
    snapshot = table.snapshot()
    with pytest.raises(ValueError):
        Table.restore(snapshot, _always_bots())
    restored = Table.restore(snapshot, _always_bots(), card_info_lut=lut)
    assert restored.view(table.tokens[0]) == table.view(table.tokens[0])
