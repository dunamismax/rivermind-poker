// The name of a poker hand in words, such as “a king-high straight” or “two
// pair, aces and sevens”: a port of web/src/lib/nl/hand-name.ts, held to it by
// `pnpm ios:fixtures` (DisplayParityTests.swift). It names the best five cards
// among the two to seven given, by the ranking in docs/rules.md.

import Foundation

public enum HandClass: String, CaseIterable, Sendable, Codable {
    case straightFlush = "straight flush"
    case fourOfAKind = "four of a kind"
    case fullHouse = "full house"
    case flush
    case straight
    case threeOfAKind = "three of a kind"
    case twoPair = "two pair"
    case pair
    case highCard = "high card"
}

public struct NamedHand: Sendable, Hashable {
    public var handClass: HandClass
    /// With its article, ready to follow “with” or “shows”: “a king-high straight”.
    public var name: String
}

public enum HandName {
    private static let words: [Int: String] = [
        2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight",
        9: "nine", 10: "ten", 11: "jack", 12: "queen", 13: "king", 14: "ace",
    ]

    static func word(_ rank: Int) -> String { words[rank] ?? String(rank) }
    static func plural(_ rank: Int) -> String { rank == 6 ? "sixes" : "\(word(rank))s" }
    /// “an ace-high”, “an eight-high”, “a king-high”.
    static func high(_ rank: Int) -> String {
        "\(rank == 14 || rank == 8 ? "an" : "a") \(word(rank))-high"
    }

    /// The top card of the best straight among `ranks`, or 0. The ace also plays low, for the wheel.
    static func straightHigh(_ ranks: Set<Int>) -> Int {
        for top in stride(from: 14, through: 5, by: -1) {
            if (top - 4...top).allSatisfy({ ranks.contains($0 == 1 ? 14 : $0) }) { return top }
        }
        return 0
    }

    /// Names the best hand among `cards`: hole cards with the board, or any two to seven cards.
    public static func name(_ cards: [Card]) -> NamedHand {
        var counts: [Int: Int] = [:]
        var suits: [Suit: [Int]] = [:]
        var suitOrder: [Suit] = []
        for card in cards {
            counts[card.rank, default: 0] += 1
            if suits[card.suit] == nil { suitOrder.append(card.suit) }
            suits[card.suit, default: []].append(card.rank)
        }
        // Ranks by how many there are, then by rank, highest first.
        func of(_ n: Int) -> [Int] { counts.filter { $0.value >= n }.keys.sorted(by: >) }
        let flush = suitOrder.lazy.compactMap { suits[$0] }.first { $0.count >= 5 }
        if let flush {
            let top = straightHigh(Set(flush))
            if top == 14 { return NamedHand(handClass: .straightFlush, name: "a royal flush") }
            if top > 0 { return NamedHand(handClass: .straightFlush, name: "\(high(top)) straight flush") }
        }
        if let quads = of(4).first {
            return NamedHand(handClass: .fourOfAKind, name: "four of a kind, \(plural(quads))")
        }
        let trips = of(3)
        let pairs = of(2)
        if let three = trips.first, pairs.count > 1, let over = pairs.first(where: { $0 != three }) {
            return NamedHand(
                handClass: .fullHouse, name: "a full house, \(plural(three)) full of \(plural(over))")
        }
        if let flush { return NamedHand(handClass: .flush, name: "\(high(flush.max()!)) flush") }
        let top = straightHigh(Set(counts.keys))
        if top > 0 { return NamedHand(handClass: .straight, name: "\(high(top)) straight") }
        if let three = trips.first {
            return NamedHand(handClass: .threeOfAKind, name: "three of a kind, \(plural(three))")
        }
        if pairs.count > 1 {
            return NamedHand(handClass: .twoPair, name: "two pair, \(plural(pairs[0])) and \(plural(pairs[1]))")
        }
        if let pair = pairs.first { return NamedHand(handClass: .pair, name: "a pair of \(plural(pair))") }
        return NamedHand(handClass: .highCard, name: "\(word(counts.keys.max() ?? 0))-high")
    }
}
