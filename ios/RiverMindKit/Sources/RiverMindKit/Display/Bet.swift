// Bet sizing and the hand log's wording for the no-limit table: a port of
// web/src/lib/nl/bet.ts, held to it by `pnpm ios:fixtures`
// (DisplayParityTests.swift). Amounts are street totals, as the protocol's
// `min_to` and `max_to` are: "raise to 600" means the seat's bet on this street
// becomes 600.
//
// On anything the page renders as `undefined` (a field a newer server leaves
// out, an action this build does not know), the app says something plain
// instead; on everything else it says exactly what the page says.

import Foundation

public struct BetPreset: Sendable, Hashable, Decodable {
    public var label: String
    public var amount: Int
}

public enum Bet {
    /// Keeps an amount inside the legal range, as a whole number of chips.
    public static func clamp(_ amount: Double, _ legal: Legal) -> Int {
        guard amount.isFinite else { return legal.minTo }
        return Int(min(Double(legal.maxTo), max(Double(legal.minTo), amount.rounded(.down))))
    }

    /// The street total for a bet or raise of `fraction` of the pot. The pot counts the
    /// call first, as card rooms do: facing 100 into a pot of 250, a pot-sized raise is
    /// to 100 + (250 + 100) = 450.
    public static func potFraction(_ fraction: Double, _ legal: Legal, currentBet: Int, pot: Int) -> Double {
        Double(currentBet) + fraction * Double(pot + legal.call)
    }

    public static func potFraction(_ fraction: Double, _ legal: Legal, _ hand: HandInfo) -> Double {
        potFraction(fraction, legal, currentBet: hand.currentBet, pot: hand.pot)
    }

    /// Minimum, ½ pot, ¾ pot, pot and all-in, clamped to the legal range.
    public static func presets(_ legal: Legal, currentBet: Int, pot: Int) -> [BetPreset] {
        guard legal.raiseKind != nil else { return [] }
        func sized(_ label: String, _ fraction: Double) -> BetPreset {
            BetPreset(label: label, amount: clamp(potFraction(fraction, legal, currentBet: currentBet, pot: pot), legal))
        }
        return [
            BetPreset(label: "Min", amount: legal.minTo),
            sized("½ pot", 0.5),
            sized("¾ pot", 0.75),
            sized("Pot", 1),
            BetPreset(label: "All-in", amount: legal.maxTo),
        ]
    }

    public static func presets(_ legal: Legal, _ hand: HandInfo) -> [BetPreset] {
        presets(legal, currentBet: hand.currentBet, pot: hand.pot)
    }

    /// The text of the button that bets or raises to `amount`.
    public static func raiseLabel(_ legal: Legal, _ amount: Int) -> String {
        let allIn = amount >= legal.maxTo ? " (all-in)" : ""
        return legal.raiseKind == .bet ? "Bet \(amount)\(allIn)" : "Raise to \(amount)\(allIn)"
    }

    /// The text of the check or call button.
    public static func callLabel(_ legal: Legal) -> String {
        legal.canCheck ? "Check" : "Call \(legal.call)"
    }

    static func verb(_ action: ActionKind) -> String {
        switch action {
        case .fold: "folds"
        case .check: "checks"
        case .call: "calls"
        case .bet: "bets"
        case .raise: "raises to"
        default: action.rawValue.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// One line for the hand log, or nil for events that need no line.
    public static func describe(_ event: TableEvent, nameOf: (Int) -> String) -> String? {
        let who = event.seat.map(nameOf) ?? ""
        let seatNumber = (event.seat ?? 0) + 1
        switch event.kind {
        case .handStarted:
            return "Hand #\(event.handNo ?? 0) · \(who) has the button"
        case .action:
            let action = event.action ?? .check
            let amount = action == .call ? (event.added ?? 0) : (event.amount ?? 0)
            let tail = action == .fold || action == .check ? "" : " \(amount)"
            return "\(who) \(verb(action))\(tail)\(event.allIn == true ? " and is all-in" : "")"
        case .board:
            return "\(event.street == .flop ? "Flop" : event.street == .turn ? "Turn" : "River") dealt"
        case .timedOut:
            return "\(who) ran out of time"
        case .seated:
            return "\(event.name ?? who) sits down with \(event.amount ?? 0)"
        case .left:
            return "\(who) leaves"
        case .satOut:
            return event.reason == "away" ? "\(who) is away and sits out" : "\(who) sits out"
        case .satIn:
            return "\(who) is back"
        case .rebought:
            return "\(who) adds \(event.amount ?? 0)"
        case .rebuyDropped:
            return "\(who)’s rebuy of \(event.amount ?? 0) no longer fits and goes back to the wallet"
        case .disconnected:
            return "\(who) disconnected"
        case .connected:
            return "\(who) reconnected"
        case .reserved:
            return "Seat \(seatNumber) is held for \(event.name ?? "a player")"
        case .reservationEnded:
            return event.reason == "expired" ? "The hold on seat \(seatNumber) ran out" : nil
        default:
            return nil
        }
    }

    /// One line for each pot of a settled hand, under the table: "Ann wins 300",
    /// "Ann and Bob split 600 (main pot)", "Cy wins 200 (side pot)".
    public static func potLines(_ result: HandResult, nameOf: (Int) -> String) -> [String] {
        result.pots.enumerated().map { i, pot in
            let names = pot.winners.map(nameOf).joined(separator: " and ")
            let verb = pot.winners.count > 1 ? "split" : "wins"
            let which = result.pots.count > 1 ? (i == 0 ? " (main pot)" : " (side pot)") : ""
            return "\(names) \(verb) \(pot.amount)\(which)"
        }
    }
}
