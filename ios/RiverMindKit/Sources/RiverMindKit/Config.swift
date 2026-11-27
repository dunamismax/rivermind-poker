import Foundation

// `GET /api/config` as `web/src/lib/protocol-v2.ts` defines it. Written by hand
// for P5D.1's lobby; P5D.2's generator (`pnpm protocol:swift`) replaces this file
// with types written from protocol-v2.ts. Unknown fields are ignored, and a kind
// this build does not know decodes as itself, so a newer server never breaks it.

/// The protocol, the bots, the table sizes, the stakes and the reactions a server offers.
public struct ConfigResponse: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var bots: [BotOption]
    public var seatCounts: [Int]
    public var stakes: [Stakes]
    /// The preset reactions, in the order to offer them.
    public var reactions: [ReactionOption]
    /// The chips `POST /api/practice` gives, and gives again whenever the guest runs out.
    public var practiceStack: Int?

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case bots
        case seatCounts = "seat_counts"
        case stakes
        case reactions
        case practiceStack = "practice_stack"
    }
}

/// A bot a table can seat.
public struct BotOption: Codable, Sendable, Equatable, Identifiable {
    public var kind: String
    public var label: String
    /// The table sizes this bot plays; every size when missing.
    public var seats: [Int]?
    /// For a trained bot: the model it plays, the heads-up one when it has more than one.
    public var champion: BotChampion?
    /// For a trained bot with a model for more than one format: each, with the table sizes it plays.
    public var champions: [BotChampion]?

    public var id: String { kind }

    /// Whether this bot plays a table of `seats` seats.
    public func plays(seats count: Int) -> Bool {
        seats?.contains(count) ?? true
    }
}

/// A promoted model and its published evaluation (D-7).
public struct BotChampion: Codable, Sendable, Equatable {
    /// Its name in the model registry (docs/models.md).
    public var name: String
    /// The date it was promoted.
    public var promoted: String
    /// Training iterations.
    public var iterations: Int
    /// The stacks the results were played at, in big blinds.
    public var stackBB: Double
    /// The promotion gate's matchups, for the strategy the site serves.
    public var results: [BotResult]
    /// The table sizes this model plays, in a bot's `champions`; missing in `champion`.
    public var seats: [Int]?

    enum CodingKeys: String, CodingKey {
        case name, promoted, iterations
        case stackBB = "stack_bb"
        case results, seats
    }
}

/// One matchup of a trained bot's published evaluation.
public struct BotResult: Codable, Sendable, Equatable {
    /// A bot kind, or `champion` for the champion this one replaced.
    public var opponent: String
    public var label: String
    public var hands: Int
    /// Big blinds won per 100 hands.
    public var bbPer100: Double
    /// The two bounds of the 95% interval.
    public var ci95: [Double]

    enum CodingKeys: String, CodingKey {
        case opponent, label, hands
        case bbPer100 = "bb_per_100"
        case ci95
    }
}

/// A table's blinds, in chips.
public struct Stakes: Codable, Sendable, Equatable, Hashable {
    public var smallBlind: Int
    public var bigBlind: Int

    enum CodingKeys: String, CodingKey {
        case smallBlind = "small_blind"
        case bigBlind = "big_blind"
    }
}

/// A preset reaction (Q-4: no free text).
public struct ReactionOption: Codable, Sendable, Equatable, Identifiable {
    public var kind: Reaction
    public var text: String

    public var id: String { kind.rawValue }
}

/// A reaction's kind. One this build does not know keeps its name.
public struct Reaction: RawRepresentable, Codable, Sendable, Hashable {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let hello = Reaction(rawValue: "hello")
    public static let niceHand = Reaction(rawValue: "nice_hand")
    public static let wellPlayed = Reaction(rawValue: "well_played")
    public static let goodGame = Reaction(rawValue: "good_game")
    public static let unlucky = Reaction(rawValue: "unlucky")
    public static let thanks = Reaction(rawValue: "thanks")
    public static let wow = Reaction(rawValue: "wow")
    public static let thinking = Reaction(rawValue: "thinking")

    /// The kinds protocol v2 names today.
    public static let known: [Reaction] = [
        .hello, .niceHand, .wellPlayed, .goodGame, .unlucky, .thanks, .wow, .thinking,
    ]
}
