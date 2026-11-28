// A finished hand as steps to walk through: the blinds, every action, each
// street's cards, the showdown and the result, with the board, each seat's
// cards and bets and the pot as they stood after each step, and why each pot
// went where it did. A port of web/src/lib/nl/replay.ts, held to it by
// `pnpm ios:fixtures` (DisplayParityTests.swift).
//
// It is built from a `HandDetail`, which holds only what the viewer may see:
// their own cards and the hands shown at showdown. The replay adds nothing to
// that. It shows the viewer's cards throughout, and every other hand only from
// the step at which it was turned over: the showdown, or the end of the betting
// when the players were all-in with cards to come.

import Foundation

public struct ReplaySeat: Sendable, Hashable, Decodable {
    public var seat: Int
    public var name: String
    public var kind: SeatKind
    public var bot: String?
    public var you: Bool
    /// The seat's hole cards once the viewer may see them at this step, else nil.
    public var cards: [Card]?
    /// Chips put in on the current street.
    public var bet: Int
    /// Chips put in over the whole hand so far.
    public var total: Int
    public var folded: Bool
    public var allIn: Bool
    /// Chips taken from the pots; set on the result step.
    public var won: Int
    /// Chips won or lost in the hand; set on the result step.
    public var net: Int?
}

/// Why a pot went to its winners.
public struct Award: Sendable, Hashable, Decodable {
    public struct Winner: Sendable, Hashable, Decodable {
        public var seat: Int
        public var name: String
        public var share: Int
    }

    /// “The pot”, “Main pot”, “Side pot”, “Side pot 2”.
    public var label: String
    public var amount: Int
    public var winners: [Winner]
    /// The seats that could win it.
    public var eligible: [Int]
    /// One sentence: who won it, and with what or why.
    public var text: String
}

public enum StepKind: String, Sendable, Hashable, Decodable {
    case posts, action, tabled, street, showdown, result
}

public struct ReplayStep: Sendable, Hashable, Decodable {
    public var kind: StepKind
    public var street: Street
    /// What happened at this step, as one line.
    public var text: String
    /// The same in sentences: one, except on the result step, which has one for each pot.
    public var lines: [String]
    /// The board as it stood.
    public var board: [Card]
    /// Every chip put in so far; on the result step, the chips the pots held.
    public var pot: Int
    public var seats: [ReplaySeat]
    /// The seat that acted at this step.
    public var acting: Int?
    /// Chips the action put in.
    public var amount: Int?
    /// How each pot was awarded; on the result step.
    public var awards: [Award]
}

public enum Replay {
    static let streets: [Street] = [.preFlop, .flop, .turn, .river]
    /// Board cards on each street.
    static func boardCount(_ street: Street) -> Int {
        switch street {
        case .flop: 3
        case .turn: 4
        case .river: 5
        default: 0
        }
    }

    static func streetName(_ street: Street) -> String {
        switch street {
        case .preFlop: "Pre-flop"
        case .flop: "Flop"
        case .turn: "Turn"
        case .river: "River"
        default: street.rawValue
        }
    }

    static func post(_ kind: PostKind) -> String {
        switch kind {
        case .ante: "an ante of"
        case .smallBlind: "the small blind,"
        case .bigBlind: "the big blind,"
        default: ""
        }
    }

    static func chips(_ amount: Int) -> String { ConfigResponse.chips(amount) }

    /// “Ann”, “Ann and Bob”, “Ann, Bob and Cy”.
    static func list(_ names: [String]) -> String {
        if names.count < 3 { return names.joined(separator: " and ") }
        return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
    }

    static func potLabel(_ index: Int, _ count: Int) -> String {
        if count == 1 { return "The pot" }
        if index == 0 { return "Main pot" }
        return count == 2 ? "Side pot" : "Side pot \(index)"
    }

    /// How a pot was awarded, from the stored result and the cards shown.
    static func award(_ detail: HandDetail, _ pot: PotResult, _ index: Int, _ nameOf: (Int) -> String) -> Award {
        let label = potLabel(index, detail.pots.count)
        // “the pot”, “the main pot”, “the side pot 2”.
        let lower = label == "The pot" ? "the pot" : "the \(label.prefix(1).lowercased())\(label.dropFirst())"
        let winners = pot.winners.enumerated().map { i, seat in
            Award.Winner(seat: seat, name: nameOf(seat), share: i < pot.shares.count ? pot.shares[i] : 0)
        }
        let names = list(winners.map(\.name))
        let of = "\(lower) of \(chips(pot.amount))"
        let text: String
        if !detail.hand.showdown {
            text = "\(names) wins \(of): everyone else folded."
        } else {
            let board = detail.hand.board
            let hands: [String?] = winners.map { winner in
                detail.seats.first { $0.seat == winner.seat }?.cards.map { HandName.name($0 + board).name }
            }
            let shown = hands.allSatisfy { $0 != nil }
            let named = hands.compactMap { $0 }
            let rivals = pot.eligible.filter { !pot.winners.contains($0) }
            if winners.count > 1 {
                let same = shown && Set(named).count == 1
                let how = same ? ", each with \(named[0])" : shown ? ", with \(list(named))" : ""
                text = "\(names) split \(of)\(how): \(winners.map { chips($0.share) }.joined(separator: " and "))."
            } else if rivals.isEmpty {
                // Chips nobody else could win: a stack no other player covered.
                text = "\(names) takes \(of): no other player had chips in it."
            } else if shown, let hand = named.first {
                text = "\(names) wins \(of) with \(hand)."
            } else {
                text = "\(names) wins \(of) at showdown."
            }
        }
        return Award(label: label, amount: pot.amount, winners: winners, eligible: pot.eligible, text: text)
    }

    /// The steps of a finished hand, from the blinds to the result.
    public static func steps(_ detail: HandDetail) -> [ReplayStep] {
        var names: [Int: String] = [:]
        for seat in detail.seats { names[seat.seat] = seat.name }
        let nameOf = { (seat: Int) in names[seat] ?? "Seat \(seat + 1)" }
        let board = detail.hand.board
        var bet: [Int: Int] = [:]
        var total: [Int: Int] = [:]
        var folded = Set<Int>()
        var allIn = Set<Int>()
        var street = Street.preFlop
        var pot = 0
        var revealed = false
        var steps: [ReplayStep] = []

        func put(_ seat: Int, _ amount: Int, _ isAllIn: Bool) {
            bet[seat, default: 0] += amount
            total[seat, default: 0] += amount
            pot += amount
            if isAllIn { allIn.insert(seat) }
        }
        func seats(final: Bool) -> [ReplaySeat] {
            detail.seats.map { s in
                ReplaySeat(
                    seat: s.seat, name: s.name, kind: s.kind, bot: s.bot, you: s.you,
                    cards: s.cards != nil && (s.you || (revealed && s.shown)) ? s.cards : nil,
                    bet: bet[s.seat] ?? 0, total: total[s.seat] ?? 0,
                    folded: folded.contains(s.seat), allIn: allIn.contains(s.seat),
                    won: 0, net: final ? s.net : nil)
            }
        }
        func push(_ kind: StepKind, _ text: String, acting: Int? = nil, amount: Int? = nil) {
            steps.append(
                ReplayStep(
                    kind: kind, street: street, text: text, lines: [text],
                    board: Array(board.prefix(boardCount(street))), pot: pot,
                    seats: seats(final: kind == .result), acting: acting, amount: amount, awards: []))
        }
        func index(_ street: Street) -> Int { streets.firstIndex(of: street) ?? -1 }
        /// Deals the streets up to `target`, one step each, as far as the board goes.
        func deal(to target: Street) {
            while index(street) < index(target) {
                let next = streets[index(street) + 1]
                if board.count < boardCount(next) { return }
                let fresh = board[boardCount(street)..<boardCount(next)]
                street = next
                bet.removeAll()
                push(.street, "\(streetName(street)): \(fresh.map(Wording.shortCard).joined(separator: " "))")
            }
        }

        for post in detail.posts { put(post.seat, post.amount, post.allIn) }
        push(
            .posts,
            detail.posts.isEmpty
                ? "The hand begins."
                : "\(list(detail.posts.map { "\(nameOf($0.seat)) posts \(post($0.kind)) \(chips($0.amount))" }))."
        )
        // Antes sit in the pot, not in front of the seat.
        for post in detail.posts where post.kind == .ante { bet[post.seat, default: 0] -= post.amount }

        for action in detail.actions {
            deal(to: action.street)
            put(action.seat, action.added, action.allIn)
            if action.action == .fold { folded.insert(action.seat) }
            push(.action, describe(action, who: nameOf(action.seat)), acting: action.seat, amount: action.added)
        }
        // Rule 12.1: when at most one player still in has chips behind, the betting is
        // over and every hand still in is turned face up before the rest of the board.
        let behind = detail.seats.filter { !folded.contains($0.seat) && !allIn.contains($0.seat) }
        if detail.hand.showdown && behind.count <= 1 && board.count > boardCount(street) {
            revealed = true
            let tabled = detail.seats.compactMap { s in
                s.shown ? s.cards.map { "\(s.name) shows \($0.map(Wording.shortCard).joined(separator: " "))" } : nil
            }
            if !tabled.isEmpty { push(.tabled, "All in: \(list(tabled)).") }
        }
        // The rest of the board comes with no more betting.
        deal(to: .river)

        if detail.hand.showdown {
            revealed = true
            let shows = detail.seats.compactMap { s in
                s.shown ? s.cards.map { "\(s.name) shows \(HandName.name($0 + board).name)" } : nil
            }
            push(.showdown, shows.isEmpty ? "Showdown." : "Showdown: \(list(shows)).")
        }

        var lines: [String] = []
        if let uncalled = detail.uncalled {
            pot -= uncalled.amount
            total[uncalled.seat, default: 0] -= uncalled.amount
            lines.append("\(nameOf(uncalled.seat)) takes back \(chips(uncalled.amount)) that nobody called.")
        }
        bet.removeAll()
        let awards = detail.pots.enumerated().map { award(detail, $1, $0, nameOf) }
        lines += awards.map(\.text)
        push(.result, lines.joined(separator: " "))
        var result = steps.removeLast()
        result.lines = lines
        result.awards = awards
        for i in result.seats.indices {
            let seat = result.seats[i].seat
            result.seats[i].won = awards.reduce(0) { sum, award in
                sum + (award.winners.first { $0.seat == seat }?.share ?? 0)
            }
        }
        steps.append(result)
        return steps
    }

    /// “Ann raises to 300 and is all-in”. A call names the chips it adds.
    public static func describe(_ action: ActionRecord, who: String) -> String {
        let amount = action.action == .call ? action.added : action.to
        let tail = action.action == .fold || action.action == .check ? "" : " \(chips(amount))"
        return "\(who) \(Bet.verb(action.action))\(tail)\(action.allIn ? " and is all-in" : "")."
    }

    /// Where in the hand a step is: its street, then “Showdown” and “Result”.
    public static func stage(_ step: ReplayStep) -> String {
        if step.kind == .result { return "Result" }
        return step.kind == .showdown ? "Showdown" : streetName(step.street)
    }

    /// The step a key moves the replay to from step `index` of `count`: the arrows go
    /// back and on one step, Home and End to the first and last. Nil for any other key.
    public static func step(forKey key: String, index: Int, count: Int) -> Int? {
        switch key {
        case "ArrowLeft": max(0, index - 1)
        case "ArrowRight": min(count - 1, index + 1)
        case "Home": 0
        case "End": count - 1
        default: nil
        }
    }
}
