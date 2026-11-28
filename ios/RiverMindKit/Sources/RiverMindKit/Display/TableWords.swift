// What the table works out from a view only to show it: who is named where, the
// lines under the action dock and in the join panel, what each empty seat offers,
// and when the rebuy, the refill and the review are offered. A port of
// web/src/lib/nl/table.ts, held to it by `pnpm ios:fixtures`
// (DisplayParityTests.swift). A change to either side lands in both in the same
// commit.

import Foundation

public enum TableWords {
    /// A seat's name, or its number when nobody sits there.
    public static func nameOf(_ view: TableView, _ seat: Int) -> String {
        (seat >= 0 && seat < view.seats.count ? view.seats[seat]?.name : nil) ?? "Seat \(seat + 1)"
    }

    /// The viewer's own seat, when they have one.
    public static func me(_ view: TableView) -> SeatInfo? {
        guard let mine = view.you.seat, mine >= 0, mine < view.seats.count else { return nil }
        return view.seats[mine]
    }

    /// Whether a hand is being played: dealt and not yet settled.
    public static func inHand(_ view: TableView) -> Bool {
        view.hand != nil && view.hand?.result == nil
    }

    /// It is the viewer's turn, with their legal actions.
    public static func myTurn(_ view: TableView) -> Bool {
        view.you.legal != nil && view.hand != nil && view.turn != nil
    }

    /// The name of the player the table waits for, when it is not the viewer.
    public static func waitingFor(_ view: TableView) -> String? {
        guard let turn = view.turn, turn.seat != view.you.seat else { return nil }
        return nameOf(view, turn.seat)
    }

    /// How many chips the viewer may still add to their stack.
    public static func rebuyRoom(_ view: TableView) -> Int {
        guard let me = me(view) else { return 0 }
        return view.settings.maxBuyIn - me.stack - view.you.pendingRebuy
    }

    /// The viewer has a seat with no chips and no hand under way.
    public static func busted(_ view: TableView) -> Bool {
        guard let me = me(view) else { return false }
        return me.stack == 0 && !inHand(view)
    }

    /// Whether the viewer was dealt into the hand on the felt, so it is among their hands.
    public static func dealtIn(_ view: TableView) -> Bool {
        guard let hand = view.hand, let mine = view.you.seat else { return false }
        if hand.posts.contains(where: { $0.seat == mine }) { return true }
        if hand.actions.contains(where: { $0.seat == mine }) { return true }
        if let net = hand.result?.net, mine < net.count { return net[mine] != 0 }
        return false
    }

    /// A hand has finished at this table, so there may be one of the viewer's to review.
    public static func reviewable(_ view: TableView) -> Bool {
        guard let hand = view.hand else { return false }
        return hand.result != nil || hand.handNo > 1
    }

    /// A seat the viewer could take: empty or a bot's, and not held for someone.
    public static func hasSeatRoom(_ view: TableView) -> Bool {
        let held = Set(view.holds.map(\.seat))
        return view.seats.enumerated().contains { seat, info in
            !held.contains(seat) && (info == nil || info?.kind == .bot)
        }
    }

    /// What a place with nobody in it shows.
    public enum EmptySeat: String, Sendable, Hashable, Decodable, CaseIterable {
        /// Held for the viewer.
        case mine
        /// Held for someone else.
        case held
        /// The viewer may take it.
        case open
        case empty

        public var text: String {
            switch self {
            case .mine: "Your seat"
            case .held: "Held"
            case .open: "Sit here"
            case .empty: "Empty"
            }
        }
    }

    public static func emptySeat(_ view: TableView, _ seat: Int) -> EmptySeat {
        if view.holds.contains(where: { $0.seat == seat }) { return view.you.hold?.seat == seat ? .mine : .held }
        if view.you.seat == nil && view.you.hold == nil && view.you.waitlistPosition == nil { return .open }
        return .empty
    }

    /// The bar's middle: the hand's number and street, or that the table waits.
    public static func handLine(_ view: TableView) -> String {
        guard let hand = view.hand else { return "Waiting for players" }
        return "#\(hand.handNo) · \(hand.street.rawValue)"
    }

    /// The line in the dock while it is not the viewer's turn; empty when there is nothing to say.
    public static func dockLine(_ view: TableView) -> String {
        if busted(view) { return "You are out of chips. Rebuy to keep playing." }
        if view.you.sittingOut { return "You are sitting out." }
        if let waiting = waitingFor(view) { return "Waiting for \(waiting)…" }
        if view.hand?.result != nil { return "Next hand soon…" }
        return ""
    }

    /// The join panel's line for someone without a seat: a held seat (with `holdLeft` seconds
    /// when it runs out), a place in line, or watching (`short` when the wallet cannot cover
    /// the minimum buy-in).
    public static func joinLine(_ view: TableView, holdLeft: Int?, short: Bool) -> String {
        if let hold = view.you.hold {
            if hold.ready {
                return "Seat \(hold.seat + 1) is held for you\(holdLeft.map { " for \($0)s" } ?? ""). Buy in to sit down."
            }
            return "Seat \(hold.seat + 1) is yours when the bot there finishes this hand."
        }
        if let position = view.you.waitlistPosition {
            return "You are number \(position) in line. A seat is held for you when one opens."
        }
        return "You are watching." + (short ? " You need more play chips to sit at this table." : "")
    }

    /// Under the buy-in field.
    public static func buyInHint(_ view: TableView) -> String {
        "Buy in for \(ConfigResponse.chips(view.settings.minBuyIn)) to \(ConfigResponse.chips(view.settings.maxBuyIn)) play chips."
    }

    /// The refill button at a practice table.
    public static func refillText(_ view: TableView) -> String {
        "Play again with \(ConfigResponse.chips(view.settings.maxBuyIn)) chips"
    }

    /// The note beside the seat tools while a rebuy waits for the hand to end.
    public static func pendingRebuyText(_ view: TableView) -> String? {
        view.you.pendingRebuy != 0 ? "+\(view.you.pendingRebuy) after this hand" : nil
    }

    /// A line of the hand log.
    public struct LogLine: Sendable, Hashable, Decodable {
        public var seq: Int
        public var text: String
    }

    /// The hand log, newest first: at most 30 lines, each naming the player seated when it happened.
    public static func logLines(_ log: [LoggedEvent], _ view: TableView) -> [LogLine] {
        let lines = log.compactMap { entry -> LogLine? in
            Bet.describe(entry.event, nameOf: { entry.who ?? nameOf(view, $0) }).map {
                LogLine(seq: entry.event.seq, text: $0)
            }
        }
        return Array(lines.suffix(30).reversed())
    }

    /// What the review says when the viewer asks for a hand they were not in.
    public static func noHandText(_ handNo: Int?) -> String {
        guard let handNo else { return "You have not finished a hand at this table yet." }
        return "You were not dealt into hand #\(handNo), so it is not among your hands."
    }
}
