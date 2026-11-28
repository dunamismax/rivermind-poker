// Hand ranking for five to seven cards (rule 10): a port of the page's
// browser-safe evaluator (web/src/lib/engine/evaluator.ts), itself a port of
// rivermind/engine/evaluator.py, which stays the reference.
//
// Adapted from the Deuces evaluator by Will Drevo (MIT licence, see
// licenses/Deuces.txt), which is a variant of Cactus Kev's algorithm. Ranks
// run from 1 (a royal flush) to 7462 (7-5-4-3-2 offsuit), lower is better.
// Non-flush hands are keyed on the product of their rank primes and the best
// five-card subset is taken; flushes are scored on the suited cards alone,
// since a seven-card hand holding a flush cannot also hold four of a kind or a
// full house. The app decides nothing with it (D-2): it checks that a hand's
// name names the class the engine ranks it in (DisplayParityTests.swift).

import Foundation

public enum Evaluator {
    public static let primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41]

    public static let maxStraightFlush = 10
    public static let maxFourOfAKind = 166
    public static let maxFullHouse = 322
    public static let maxFlush = 1599
    public static let maxStraight = 1609
    public static let maxThreeOfAKind = 2467
    public static let maxTwoPair = 3325
    public static let maxPair = 6185
    public static let maxHighCard = 7462

    static let classLimits = [
        maxStraightFlush, maxFourOfAKind, maxFullHouse, maxFlush, maxStraight,
        maxThreeOfAKind, maxTwoPair, maxPair, maxHighCard,
    ]

    /// The engine's number for a card: rank * 4 + suit, with a deuce rank 0 and an
    /// ace 12, and clubs, diamonds, hearts and spades 0 to 3.
    public static func number(of card: Card) -> Int? {
        let suits: [Suit] = [.clubs, .diamonds, .hearts, .spades]
        guard (2...14).contains(card.rank), let suit = suits.firstIndex(of: card.suit) else { return nil }
        return (card.rank - 2) * 4 + suit
    }

    /// The r-element combinations of `items`, in the order of Python's itertools.
    static func combinations<T>(_ items: [T], _ r: Int) -> [[T]] {
        let n = items.count
        guard r <= n else { return [] }
        var index = Array(0..<r)
        var found = [index.map { items[$0] }]
        while true {
            var i = r - 1
            while i >= 0 && index[i] == i + n - r { i -= 1 }
            if i < 0 { return found }
            index[i] += 1
            for j in (i + 1)..<max(i + 1, r) { index[j] = index[j - 1] + 1 }
            found.append(index.map { items[$0] })
        }
    }

    private static func key(_ ranks: [Int]) -> Int {
        ranks.reduce(1) { $0 * primes[$1] }
    }

    private static let tables: (flush: [Int: Int], unsuited: [Int: Int]) = {
        let desc = Array((0..<13).reversed())
        var straights: [[Int]] = []
        for top in stride(from: 12, to: 3, by: -1) {
            straights.append([top, top - 1, top - 2, top - 3, top - 4])
        }
        straights.append([3, 2, 1, 0, 12])
        let straightKeys = Set(straights.map(key))
        let highs = combinations(desc, 5).filter { !straightKeys.contains(key($0)) }

        var flush: [Int: Int] = [:]
        var unsuited: [Int: Int] = [:]
        var value = 1
        func next() -> Int {
            defer { value += 1 }
            return value
        }
        for s in straights { flush[key(s)] = next() }
        for quad in desc {
            for kicker in desc where kicker != quad { unsuited[key([quad, quad, quad, quad, kicker])] = next() }
        }
        for trips in desc {
            for pair in desc where pair != trips { unsuited[key([trips, trips, trips, pair, pair])] = next() }
        }
        for c in highs { flush[key(c)] = next() }
        for s in straights { unsuited[key(s)] = next() }
        for trips in desc {
            for kickers in combinations(desc.filter { $0 != trips }, 2) {
                unsuited[key([trips, trips, trips] + kickers)] = next()
            }
        }
        for pairs in combinations(desc, 2) {
            for kicker in desc where !pairs.contains(kicker) {
                unsuited[key(pairs + pairs + [kicker])] = next()
            }
        }
        for pair in desc {
            for kickers in combinations(desc.filter { $0 != pair }, 3) {
                unsuited[key([pair, pair] + kickers)] = next()
            }
        }
        for c in highs { unsuited[key(c)] = next() }
        precondition(value - 1 == maxHighCard, "evaluator tables are inconsistent")
        return (flush, unsuited)
    }()

    private static func bestOfFive(_ primes: [Int], _ table: [Int: Int]) -> Int {
        var best = maxHighCard
        for five in combinations(primes, 5) {
            if let value = table[five.reduce(1, *)], value < best { best = value }
        }
        return best
    }

    /// Ranks the best five-card hand from five to seven cards (engine numbers); lower is better.
    public static func evaluate(_ cards: [Int]) -> Int {
        precondition((5...7).contains(cards.count), "evaluate takes five to seven cards")
        var counts = [0, 0, 0, 0]
        for c in cards { counts[c & 3] += 1 }
        let cardPrime = { (c: Int) in primes[c >> 2] }
        if let flushSuit = counts.firstIndex(where: { $0 >= 5 }) {
            return bestOfFive(cards.filter { $0 & 3 == flushSuit }.map(cardPrime), tables.flush)
        }
        let product = cards.map(cardPrime).reduce(1, *)
        if cards.count == 5 { return tables.unsuited[product]! }
        return bestOfFive(cards.map(cardPrime), tables.unsuited)
    }

    /// Ranks the best hand among five to seven protocol cards, or nil for any other count.
    public static func evaluate(_ cards: [Card]) -> Int? {
        let numbers = cards.compactMap(number(of:))
        guard numbers.count == cards.count, (5...7).contains(numbers.count) else { return nil }
        return evaluate(numbers)
    }

    /// The hand class from 1 (straight flush) to 9 (high card).
    public static func rankClass(_ value: Int) -> Int {
        (classLimits.firstIndex { value <= $0 } ?? classLimits.count - 1) + 1
    }
}
