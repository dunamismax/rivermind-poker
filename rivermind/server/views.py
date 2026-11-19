"""Build protocol v2 messages from a table (P3.4).

``table_view`` is everything one player may see: their own hole cards, the
cards shown at showdown and public information, never another seat's hidden
cards. ``table_events`` turns the table's public events into protocol events.
"""

from __future__ import annotations

from collections.abc import Sequence

from rivermind.engine import card
from rivermind.engine.cards import rank, suit
from rivermind.engine.state import legal_actions

from . import protocol as p
from .runner import TableRunner
from .table import Event

_SUITS = (p.Suit.CLUBS, p.Suit.DIAMONDS, p.Suit.HEARTS, p.Suit.SPADES)


def to_card(c: int) -> p.Card:
    return p.Card(rank=rank(c) + 2, suit=_SUITS[suit(c)])


def _cards(cs: Sequence[int]) -> list[p.Card]:
    return [to_card(c) for c in cs]


def table_view(runner: TableRunner, player_id: str) -> p.TableView:
    table = runner.table
    config = table.config
    you_seat = table.seat_of(player_id)
    hand = table.hand
    in_progress = table.hand_in_progress
    result = hand.result if hand is not None else None
    shown = set(result.shown) if result is not None else set()
    seats: list[p.SeatInfo | None] = []
    for seat, player in enumerate(table.seats):
        if player is None:
            seats.append(None)
            continue
        dealt = hand is not None and hand.dealt_in[seat] and table.hand_players[seat] == player.player_id
        folded = dealt and hand is not None and hand.folded[seat]
        cards: list[p.Card] | None = None
        has_cards = False
        if dealt and hand is not None:
            hole = hand.hole_cards[seat]
            assert hole is not None
            if seat == you_seat or seat in shown:
                cards = _cards(hole)
            has_cards = not folded and (in_progress or seat in shown or seat == you_seat)
        seats.append(
            p.SeatInfo(
                seat=seat,
                name=player.name,
                kind=p.SeatKind.BOT if player.is_bot else p.SeatKind.HUMAN,
                bot=player.bot,
                stack=table.stack_of(seat),
                bet=hand.street_bets[seat] if in_progress and dealt and hand is not None else 0,
                in_hand=in_progress and dealt and not folded,
                folded=folded,
                all_in=in_progress and dealt and not folded and hand is not None and hand.stacks[seat] == 0,
                sitting_out=player.sitting_out,
                leaving=player.leaving,
                connected=player.connected,
                has_cards=has_cards,
                cards=cards,
            )
        )
    hand_info = None
    if hand is not None:
        hand_result = None
        if result is not None:
            hand_result = p.HandResult(
                pots=[
                    p.PotResult(amount=pot.amount, eligible=list(pot.eligible), winners=list(pot.winners), shares=list(pot.shares))
                    for pot in result.pots
                ],
                uncalled=None if result.uncalled is None else p.Uncalled(seat=result.uncalled[0], amount=result.uncalled[1]),
                showdown=result.showdown,
                shown=list(result.shown),
                mucked=list(result.mucked),
                winnings=list(result.winnings),
                net=[
                    (hand.stacks[s] - (hand.starting_stacks[s] or 0)) if hand.dealt_in[s] else 0
                    for s in range(hand.num_seats)
                ],
            )
        hand_info = p.HandInfo(
            hand_no=table.hand_no,
            button=hand.button,
            small_blind_seat=hand.small_blind_seat,
            big_blind_seat=hand.big_blind_seat,
            street=p.Street(hand.street.label),
            board=_cards(hand.board),
            pot=hand.pot,
            current_bet=hand.current_bet,
            to_act=hand.to_act,
            posts=[p.Post(seat=x.seat, kind=p.PostKind(x.kind.value), amount=x.amount, all_in=x.all_in) for x in hand.posts],
            actions=[
                p.ActionRecord(
                    seat=a.seat,
                    street=p.Street(a.street.label),
                    action=p.ActionKind(a.kind.value),
                    to=a.to,
                    added=a.added,
                    all_in=a.all_in,
                )
                for a in hand.actions
            ],
            result=hand_result,
        )
    turn = table.turn if in_progress else None
    legal = None
    if in_progress and hand is not None and you_seat is not None and hand.to_act == you_seat:
        options = legal_actions(hand)
        legal = p.Legal(
            can_fold=options.can_fold,
            can_check=options.can_check,
            call=options.call,
            raise_kind=None if options.raise_kind is None else p.RaiseKind(options.raise_kind.value),
            min_to=options.min_to,
            max_to=options.max_to,
        )
    you_player = table.seats[you_seat] if you_seat is not None else None
    return p.TableView(
        table_id=runner.table_id,
        name=runner.name,
        seq=table.seq,
        server_time=runner.options.clock.now(),
        settings=p.TableSettings(
            seat_count=config.seat_count,
            small_blind=config.small_blind,
            big_blind=config.big_blind,
            ante=config.ante,
            min_buy_in=config.min_buy_in,
            max_buy_in=config.max_buy_in,
            action_seconds=config.action_seconds,
            time_bank_seconds=config.time_bank_seconds,
        ),
        seats=seats,
        hand=hand_info,
        turn=None
        if turn is None
        else p.Turn(seat=turn.seat, seq=turn.seq, started=turn.started, deadline=turn.deadline, final=turn.final),
        you=p.You(
            player_id=player_id,
            seat=you_seat,
            legal=legal,
            time_bank=you_player.time_bank if you_player is not None else None,
            pending_rebuy=you_player.pending_rebuy if you_player is not None else 0,
            sitting_out=you_player.sitting_out if you_player is not None else False,
            sitting_out_next=you_player.sit_out_next if you_player is not None else False,
        ),
    )


def table_events(events: Sequence[Event]) -> list[p.TableEvent]:
    out = []
    for event in events:
        data = event.data
        fields: dict[str, object] = {"seq": event.seq, "kind": p.EventKind(event.kind)}
        if "seat" in data:
            fields["seat"] = data["seat"]
        kind = event.kind
        if kind == "seated":
            fields.update(name=data["name"], amount=data["stack"])
        elif kind == "left":
            fields["amount"] = data["stack"]
        elif kind in ("rebuy_pending", "rebought"):
            fields["amount"] = data["amount"]
        elif kind == "sat_out":
            fields["reason"] = data["reason"]
        elif kind == "hand_started":
            fields.update(hand_no=data["hand_no"], seat=data["button"])
        elif kind == "hand_ended":
            fields["hand_no"] = data["hand_no"]
        elif kind == "action":
            fields.update(
                action=p.ActionKind(data["action"]),
                amount=data["to"],
                added=data["added"],
                all_in=data["all_in"],
                street=p.Street(data["street"]),
            )
        elif kind == "board":
            fields.update(street=p.Street(data["street"]), cards=[to_card(card(c)) for c in data["cards"]])
        out.append(p.TableEvent.model_validate(fields))
    return out
