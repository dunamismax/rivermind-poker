"""Card tables (P5.2): isomorphism, exact equities, histograms, clustering and the built set."""

from __future__ import annotations

import itertools
import json
import random
from math import comb
from pathlib import Path

import numpy as np
import pytest
from click.testing import CliRunner

from poker_ai.cli.runner import cli
from rivermind.bots.cards import CardTables, Settings, TableError, build, verify_files
from rivermind.bots.cards.build import _kmeans, _renumber
from rivermind.bots.cards.equity import (
    BINS,
    EQUITY_SCALE,
    INVALID,
    direct_rows,
    equity_bin,
    histograms,
    river_equity,
    river_equity_brute,
)
from rivermind.bots.cards.iso import (
    PAIRS,
    PERMS,
    board_index,
    pair_cards,
    pair_index,
    permute_card,
    permuted_pairs,
    preflop_class,
    set_rank,
)
from rivermind.engine.cards import cards


def deal(rng: random.Random, n: int) -> list[int]:
    deck = list(range(52))
    rng.shuffle(deck)
    return deck[:n]


@pytest.mark.parametrize(("size", "classes"), [(3, 1_755), (4, 16_432), (5, 134_459)])
def test_board_classes_match_burnside_counts(size: int, classes: int) -> None:
    index = board_index(size)
    assert len(index) == classes
    assert int(index.orbit.sum()) == comb(52, size)
    assert set(np.unique(index.orbit).tolist()) <= {1, 2, 3, 4, 6, 8, 12, 24}
    # Each representative is its own canonical board.
    for cls in (0, classes // 2, classes - 1):
        rep = index.representative(cls)
        assert index.lookup(rep) == (cls, index.lookup(rep)[1])


def test_relabelling_suits_keeps_a_board_in_its_class() -> None:
    rng = random.Random(5)
    for size in (3, 4, 5):
        index = board_index(size)
        for _ in range(200):
            board = deal(rng, size)
            g = rng.randrange(24)
            cls, perm = index.lookup(board)
            assert index.lookup([permute_card(c, g) for c in board])[0] == cls
            # The stored permutation maps the board onto its class's representative.
            assert tuple(sorted(permute_card(c, perm) for c in board)) == index.representative(cls)


def test_pair_indexes_and_permuted_pairs() -> None:
    seen = {pair_index(a, b) for a, b in itertools.combinations(range(52), 2)}
    assert seen == set(range(PAIRS)) and pair_index(7, 3) == pair_index(3, 7)
    assert set_rank((0, 1, 2)) == 0 and set_rank((49, 50, 51)) == comb(52, 3) - 1
    cards_of = pair_cards()
    table = permuted_pairs()
    for g in (0, 7, 23):
        for p in (0, 500, PAIRS - 1):
            a, b = cards_of[p]
            assert table[g, p] == pair_index(permute_card(int(a), g), permute_card(int(b), g))
        assert sorted(table[g].tolist()) == list(range(PAIRS))


def test_preflop_classes_are_the_169_lossless_classes() -> None:
    classes = {preflop_class(a, b) for a, b in itertools.combinations(range(52), 2)}
    assert classes == set(range(169))
    assert preflop_class(*cards("AsAh")) == 168 and preflop_class(*cards("2c2d")) == 0
    assert preflop_class(*cards("AsKs")) == preflop_class(*cards("AhKh")) != preflop_class(*cards("AsKh"))
    assert preflop_class(*cards("7c2d")) == preflop_class(*cards("2h7s"))


def test_river_equity_is_exact() -> None:
    rng = random.Random(11)
    for _ in range(25):
        dealt = deal(rng, 7)
        board, hole = tuple(dealt[:5]), (dealt[5], dealt[6])
        row = river_equity(board)
        assert int(row[pair_index(*hole)]) == river_equity_brute(hole, board)
        assert row[pair_index(board[0], hole[0])] == INVALID
        valid = row[row != INVALID]
        assert len(valid) == 1_081 and valid.max() <= EQUITY_SCALE
    # A royal flush on the board: every hand ties every other.
    royal = river_equity(cards("AsKsQsJsTs"))
    assert set(royal[royal != INVALID].tolist()) == {EQUITY_SCALE // 2}
    # The nuts never lose; quads with the case card beat everything else here.
    quads = river_equity(cards("AsAhAd7c2h"))
    assert quads[pair_index(*cards("Ac3d"))] == EQUITY_SCALE


def test_a_hand_reads_the_same_equity_from_its_class_row() -> None:
    rng = random.Random(3)
    river = board_index(5)
    turned = permuted_pairs()
    for _ in range(30):
        dealt = deal(rng, 7)
        board, hole = dealt[:5], (dealt[5], dealt[6])
        cls, g = river.lookup(board)
        direct = river_equity(board)[pair_index(*hole)]
        assert river_equity(river.representative(cls))[turned[g, pair_index(*hole)]] == direct


def test_turn_and_flop_histograms_count_every_runout() -> None:
    river = board_index(5)
    rows = direct_rows(river)
    turn = cards("Ah9d4c4s")
    found = histograms(turn, river, rows)
    for hole in (cards("KhQh"), cards("4d4h"), cards("2c3c"), cards("Ad9s")):
        expected = np.zeros(BINS, dtype=np.int64)
        for card in sorted(set(range(52)) - set(turn) - set(hole)):
            value = river_equity((*turn, card))[pair_index(*hole)]
            expected[equity_bin(np.array([value]))[0]] += 1
        assert found[pair_index(*hole)].tolist() == expected.tolist() and expected.sum() == 46
    assert found[pair_index(*cards("AhKc"))].sum() == 0  # collides with the board
    flop = cards("Tc7d2h")
    found = histograms(flop, river, rows)
    hole = cards("JcTd")
    expected = np.zeros(BINS, dtype=np.int64)
    for extra in itertools.combinations(sorted(set(range(52)) - set(flop) - set(hole)), 2):
        value = river_equity((*flop, *extra))[pair_index(*hole)]
        expected[equity_bin(np.array([value]))[0]] += 1
    assert found[pair_index(*hole)].tolist() == expected.tolist() and expected.sum() == 1_081


def test_kmeans_is_seeded_and_buckets_follow_the_mean() -> None:
    rng = np.random.default_rng(0)
    points = np.concatenate([rng.normal(m, 0.05, size=(200, 2)) for m in (0.9, 0.1, 0.5)])
    weights = rng.integers(1, 25, size=len(points)).astype(float)
    settings = Settings(seed=4)
    one = _kmeans(points, weights, 3, settings, salt=1)
    two = _kmeans(points, weights, 3, settings, salt=1)
    assert np.array_equal(one[0], two[0]) and np.array_equal(one[1], two[1])
    order = _renumber(one[0][:, 0])
    # Renumbered, the cluster around 0.1 is bucket 0 and the one around 0.9 is bucket 2.
    assert order[one[1][250]] == 0 and order[one[1][0]] == 2 and order[one[1][450]] == 1


def limited(tmp_path: Path, name: str = "set") -> Path:
    out = tmp_path / name
    result = CliRunner().invoke(
        cli,
        [
            "tables", "build", "--out", str(out), "--limit", "3", "--workers", "1",
            "--flop_buckets", "6", "--turn_buckets", "6", "--river_buckets", "12",
        ],
    )  # fmt: skip
    assert result.exit_code == 0, result.output
    return out


def test_a_limited_set_builds_reproducibly_verifies_and_looks_up(tmp_path: Path) -> None:
    out = limited(tmp_path)
    again = limited(tmp_path, "again")
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["files"] == json.loads((again / "manifest.json").read_text())["files"]
    assert manifest["settings"]["limit"] == 3 and manifest["classes"] == {"flop": 3, "turn": 3, "river": 3}
    assert not (out / "work").exists() and not (tmp_path / "set.partial").exists()
    runner = CliRunner()
    assert runner.invoke(cli, ["tables", "verify", str(out)]).exit_code == 0

    tables = CardTables(out, verify=True)
    assert tables.bucket(cards("AsAh")) == 168
    flop = board_index(3).representative(0)
    turn = board_index(4).representative(1)
    river = board_index(5).representative(2)
    rng = random.Random(2)
    for board, count in ((flop, 6), (turn, 6), (river, 12)):
        hole = tuple(c for c in deal(rng, 52) if c not in board)[:2]
        found = tables.bucket(hole, board)
        assert 0 <= found < count
        for g in range(len(PERMS)):  # the same hand under any suit names
            assert tables.bucket([permute_card(c, g) for c in hole], [permute_card(c, g) for c in board]) == found
    printed = runner.invoke(cli, ["tables", "bucket", str(out), "AsAh"])
    assert printed.exit_code == 0 and printed.output.strip() == "168"
    with pytest.raises(TableError, match="lacks"):
        tables.bucket(cards("AsKd"), cards("Qh7c2s"))
    with pytest.raises(TableError, match="needed"):
        tables.bucket((flop[0], 51), flop)  # a hole card on the board
    with pytest.raises(TableError):
        tables.bucket(cards("AsAs"))

    # A damaged or extra file is caught, and an existing set is never overwritten.
    data = bytearray((out / "turn.npy").read_bytes())
    data[-1] ^= 1
    (out / "turn.npy").write_bytes(bytes(data))
    (out / "stray.npy").write_bytes(b"x")
    assert verify_files(out) == ["stray.npy", "turn.npy"]
    assert runner.invoke(cli, ["tables", "verify", str(out)]).exit_code != 0
    with pytest.raises(TableError, match="differ"):
        CardTables(out, verify=True)
    with pytest.raises(FileExistsError):
        build(out, Settings(limit=1))


def test_bad_settings_are_refused(tmp_path: Path) -> None:
    for bad in (Settings(flop_buckets=0), Settings(river_buckets=70_000), Settings(sample=0), Settings(limit=0)):
        with pytest.raises(ValueError):
            build(tmp_path / "never", bad)
    with pytest.raises(TableError, match="manifest"):
        CardTables(tmp_path)
