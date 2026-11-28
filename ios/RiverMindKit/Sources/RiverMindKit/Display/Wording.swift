// Cards in words, and the words of the table's safety tools: ports of
// `cardName` in web/src/lib/wording.ts, `shortCard` in web/src/lib/nl/replay.ts
// and web/src/lib/nl/safety.ts, held to them by `pnpm ios:fixtures`
// (DisplayParityTests.swift).

import Foundation

public enum Wording {
    private static let rankNames: [Int: String] = [11: "Jack", 12: "Queen", 13: "King", 14: "Ace"]
    private static let shortRanks: [Int: String] = [10: "10", 11: "J", 12: "Q", 13: "K", 14: "A"]
    private static let symbols: [Suit: String] = [.spades: "♠", .hearts: "♥", .diamonds: "♦", .clubs: "♣"]

    /// "Ace of spades", "10 of hearts": the card's name, for VoiceOver.
    public static func cardName(_ card: Card) -> String {
        "\(rankNames[card.rank] ?? String(card.rank)) of \(card.suit.rawValue)"
    }

    /// “K♠”, “10♥”.
    public static func shortCard(_ card: Card) -> String {
        "\(shortRanks[card.rank] ?? String(card.rank))\(symbols[card.suit] ?? card.suit.rawValue)"
    }
}

/// The preset reactions and the words for reports (P4.5). There is no free-text chat
/// (Q-4); the server sends each reaction's text too.
public enum Safety {
    public struct ReactionWords: Sendable, Hashable, Decodable {
        public var kind: Reaction
        public var text: String
    }

    public struct ReasonWords: Sendable, Hashable, Decodable {
        public var reason: ReportReason
        public var text: String
    }

    public static let reactions: [ReactionWords] = [
        .init(kind: .hello, text: "Hi!"),
        .init(kind: .niceHand, text: "Nice hand"),
        .init(kind: .wellPlayed, text: "Well played"),
        .init(kind: .goodGame, text: "Good game"),
        .init(kind: .unlucky, text: "Unlucky"),
        .init(kind: .thanks, text: "Thanks"),
        .init(kind: .wow, text: "Wow"),
        .init(kind: .thinking, text: "Thinking…"),
    ]

    /// How long a reaction shows beside its seat, in seconds.
    public static let reactionSeconds = 4.0

    public static let reportReasons: [ReasonWords] = [
        .init(reason: .handle, text: "Offensive name"),
        .init(reason: .abuse, text: "Spam or abuse"),
        .init(reason: .collusion, text: "Playing as a team"),
        .init(reason: .voice, text: "Something said in voice"),
        .init(reason: .other, text: "Something else"),
    ]

    /// What the report form says when the report is of something said in voice (P4C.8).
    public static let voiceReportNote =
        "Voice is never recorded, so there is no audio to send with this report. When people at three other tables report the same player within a day, nobody hears them in voice for the next day."

    public static func relationText(_ kind: RelationKind?) -> String {
        kind == .block ? "Blocked" : kind == .mute ? "Muted" : ""
    }
}
