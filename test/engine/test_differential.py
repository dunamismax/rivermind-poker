"""The reference outputs for the TypeScript engine's differential tests (P4B.4).

``web/src/lib/engine/evaluator.spec.ts`` pins the same evaluator digests, so a
change to either evaluator fails one suite even without the other runtime.
"""

from __future__ import annotations

import io

import pytest

from rivermind.engine.differential import SplitMix32, evaluator_report, sample_hands, write_hands
from rivermind.engine.history import dumps, hand_record, loads, replay_record, state_to_dict


@pytest.mark.parametrize(
    ("size", "sha256"),
    [
        (5, "27101dbe21b9c95b24dc06c454f5736d0f3b7b7ef720995171400fab8154e5e4"),
        (6, "dee2357219ae639274628510a5fc074c7b571ca14d9baa1dec72cc955e6415b7"),
        (7, "e90ab8e3284b0da1adbdbba801df36544f70480bd337980abb956529b96a860a"),
    ],
)
def test_evaluator_digests_are_pinned(size: int, sha256: str) -> None:
    report = evaluator_report(sample_hands(size, 50_000, 0), {})
    assert report["sha256"] == sha256 and report["hands"] == 50_000


def test_splitmix32_matches_its_definition() -> None:
    gen = SplitMix32(0)
    # The TypeScript SplitMix32 (web/src/lib/server/engine/parity.ts) gives the same.
    assert [gen.next() for _ in range(3)] == [1684164658, 3653269916, 2939563536]
    hands = list(sample_hands(7, 100, 1))
    assert all(len(set(h)) == 7 and all(0 <= c < 52 for c in h) for h in hands)


def test_hand_lines_replay_and_repeat() -> None:
    out = io.StringIO()
    assert write_hands(out, 20, [2, 6, 9], seed=3) == 60
    lines = out.getvalue().splitlines()
    again = io.StringIO()
    write_hands(again, 20, [2, 6, 9], seed=3)
    assert again.getvalue().splitlines() == lines
    for line in lines:
        record, state, digest = line.split("\t")
        final = replay_record(loads(record))
        assert dumps(hand_record(final)) == record
        assert dumps(state_to_dict(final)) == state
        assert len(digest) == 64
