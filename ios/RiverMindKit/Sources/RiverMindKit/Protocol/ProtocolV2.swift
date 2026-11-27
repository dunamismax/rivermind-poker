// Protocol v2: every HTTP body and table message (P5D.2).
// Written by `pnpm protocol:swift` (web/scripts/protocol-swift.ts) from
// web/src/lib/protocol-v2.ts. Do not edit: change the TypeScript and run it again.

import Foundation

/// The table protocol's version, which `hello` names.
public let protocolVersion = 2

public struct ActMessage: Codable, Sendable, Hashable {
    public static let type = "act"

    public var tableID: String
    /// The seq of the view acted on.
    public var seq: Int
    public var action: ActionKind
    /// The street total, for a bet or raise only.
    public var amount: Int?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case amount
    }

    public init(
        tableID: String,
        seq: Int,
        action: ActionKind,
        amount: Int? = nil,
        nulls: Set<Null> = []
    ) {
        self.tableID = tableID
        self.seq = seq
        self.action = action
        self.amount = amount
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
        case seq
        case action
        case amount
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        seq = try container.decode(Int.self, forKey: .seq)
        action = try container.decode(ActionKind.self, forKey: .action)
        amount = try container.decodeIfPresent(Int.self, forKey: .amount)
        if container.contains(.amount), try container.decodeNil(forKey: .amount) { nulls.insert(.amount) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(seq, forKey: .seq)
        try container.encode(action, forKey: .action)
        if let amount { try container.encode(amount, forKey: .amount) } else if nulls.contains(.amount) { try container.encodeNil(forKey: .amount) }
    }
}

/// A value this build does not know decodes as itself.
public struct ActionKind: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let fold = ActionKind(rawValue: "fold")
    public static let check = ActionKind(rawValue: "check")
    public static let call = ActionKind(rawValue: "call")
    public static let bet = ActionKind(rawValue: "bet")
    public static let raise = ActionKind(rawValue: "raise")

    /// The values this build knows, in the protocol's order.
    public static let known: [ActionKind] = [
        .fold,
        .check,
        .call,
        .bet,
        .raise,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

public struct ActionRecord: Codable, Sendable, Hashable {
    public var seat: Int
    public var street: Street
    public var action: ActionKind
    /// The seat's street total after the action.
    public var to: Int
    /// Chips the action put in.
    public var added: Int
    public var allIn: Bool

    public init(
        seat: Int,
        street: Street,
        action: ActionKind,
        to: Int,
        added: Int,
        allIn: Bool
    ) {
        self.seat = seat
        self.street = street
        self.action = action
        self.to = to
        self.added = added
        self.allIn = allIn
    }

    enum CodingKeys: String, CodingKey {
        case seat
        case street
        case action
        case to
        case added
        case allIn = "all_in"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seat = try container.decode(Int.self, forKey: .seat)
        street = try container.decode(Street.self, forKey: .street)
        action = try container.decode(ActionKind.self, forKey: .action)
        to = try container.decode(Int.self, forKey: .to)
        added = try container.decode(Int.self, forKey: .added)
        allIn = try container.decode(Bool.self, forKey: .allIn)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seat, forKey: .seat)
        try container.encode(street, forKey: .street)
        try container.encode(action, forKey: .action)
        try container.encode(to, forKey: .to)
        try container.encode(added, forKey: .added)
        try container.encode(allIn, forKey: .allIn)
    }
}

/// The promoted model a trained bot plays, with the evaluation its label links to (D-7).
public struct BotChampion: Codable, Sendable, Hashable {
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
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case seats
    }

    public init(
        name: String,
        promoted: String,
        iterations: Int,
        stackBB: Double,
        results: [BotResult],
        seats: [Int]? = nil,
        nulls: Set<Null> = []
    ) {
        self.name = name
        self.promoted = promoted
        self.iterations = iterations
        self.stackBB = stackBB
        self.results = results
        self.seats = seats
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case name
        case promoted
        case iterations
        case stackBB = "stack_bb"
        case results
        case seats
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        promoted = try container.decode(String.self, forKey: .promoted)
        iterations = try container.decode(Int.self, forKey: .iterations)
        stackBB = try container.decode(Double.self, forKey: .stackBB)
        results = try container.decode([BotResult].self, forKey: .results)
        seats = try container.decodeIfPresent([Int].self, forKey: .seats)
        if container.contains(.seats), try container.decodeNil(forKey: .seats) { nulls.insert(.seats) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(promoted, forKey: .promoted)
        try container.encode(iterations, forKey: .iterations)
        try container.encode(stackBB, forKey: .stackBB)
        try container.encode(results, forKey: .results)
        if let seats { try container.encode(seats, forKey: .seats) } else if nulls.contains(.seats) { try container.encodeNil(forKey: .seats) }
    }
}

public struct BotOption: Codable, Sendable, Hashable {
    public var kind: String
    public var label: String
    /// The table sizes this bot plays; every size when missing.
    public var seats: [Int]?
    /// For a trained bot: the model it plays, the heads-up one when it has more than one.
    public var champion: BotChampion?
    /// For a trained bot with a model for more than one format (P5.7): each, with the table sizes it plays.
    public var champions: [BotChampion]?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case seats
        case champion
        case champions
    }

    public init(
        kind: String,
        label: String,
        seats: [Int]? = nil,
        champion: BotChampion? = nil,
        champions: [BotChampion]? = nil,
        nulls: Set<Null> = []
    ) {
        self.kind = kind
        self.label = label
        self.seats = seats
        self.champion = champion
        self.champions = champions
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case kind
        case label
        case seats
        case champion
        case champions
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        label = try container.decode(String.self, forKey: .label)
        seats = try container.decodeIfPresent([Int].self, forKey: .seats)
        champion = try container.decodeIfPresent(BotChampion.self, forKey: .champion)
        champions = try container.decodeIfPresent([BotChampion].self, forKey: .champions)
        if container.contains(.seats), try container.decodeNil(forKey: .seats) { nulls.insert(.seats) }
        if container.contains(.champion), try container.decodeNil(forKey: .champion) { nulls.insert(.champion) }
        if container.contains(.champions), try container.decodeNil(forKey: .champions) { nulls.insert(.champions) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(label, forKey: .label)
        if let seats { try container.encode(seats, forKey: .seats) } else if nulls.contains(.seats) { try container.encodeNil(forKey: .seats) }
        if let champion { try container.encode(champion, forKey: .champion) } else if nulls.contains(.champion) { try container.encodeNil(forKey: .champion) }
        if let champions { try container.encode(champions, forKey: .champions) } else if nulls.contains(.champions) { try container.encodeNil(forKey: .champions) }
    }
}

/// One matchup of a trained bot's published evaluation.
public struct BotResult: Codable, Sendable, Hashable {
    /// A bot kind, or `champion` for the champion this one replaced.
    public var opponent: String
    public var label: String
    public var hands: Int
    /// Big blinds won per 100 hands.
    public var bbPer100: Double
    /// The two bounds of the 95% interval.
    public var ci95: [Double]

    public init(
        opponent: String,
        label: String,
        hands: Int,
        bbPer100: Double,
        ci95: [Double]
    ) {
        self.opponent = opponent
        self.label = label
        self.hands = hands
        self.bbPer100 = bbPer100
        self.ci95 = ci95
    }

    enum CodingKeys: String, CodingKey {
        case opponent
        case label
        case hands
        case bbPer100 = "bb_per_100"
        case ci95
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        opponent = try container.decode(String.self, forKey: .opponent)
        label = try container.decode(String.self, forKey: .label)
        hands = try container.decode(Int.self, forKey: .hands)
        bbPer100 = try container.decode(Double.self, forKey: .bbPer100)
        ci95 = try container.decode([Double].self, forKey: .ci95)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(opponent, forKey: .opponent)
        try container.encode(label, forKey: .label)
        try container.encode(hands, forKey: .hands)
        try container.encode(bbPer100, forKey: .bbPer100)
        try container.encode(ci95, forKey: .ci95)
    }
}

public struct Card: Codable, Sendable, Hashable {
    /// 2 to 10, then 11 to 14 for J, Q, K, A.
    public var rank: Int
    public var suit: Suit

    public init(
        rank: Int,
        suit: Suit
    ) {
        self.rank = rank
        self.suit = suit
    }

    enum CodingKeys: String, CodingKey {
        case rank
        case suit
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        rank = try container.decode(Int.self, forKey: .rank)
        suit = try container.decode(Suit.self, forKey: .suit)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(rank, forKey: .rank)
        try container.encode(suit, forKey: .suit)
    }
}

/// Any message after the hello.
public enum ClientMessage: Codable, Sendable, Hashable {
    case joinTable(JoinTableMessage)
    case leaveTable(LeaveTableMessage)
    case sit(SitMessage)
    case sitOut(SitOutMessage)
    case sitIn(SitInMessage)
    case rebuy(RebuyMessage)
    case act(ActMessage)
    case refresh(RefreshMessage)
    case react(ReactMessage)

    /// The `type` that names the message.
    public var type: String {
        switch self {
        case .joinTable: "join_table"
        case .leaveTable: "leave_table"
        case .sit: "sit"
        case .sitOut: "sit_out"
        case .sitIn: "sit_in"
        case .rebuy: "rebuy"
        case .act: "act"
        case .refresh: "refresh"
        case .react: "react"
        }
    }

    private enum TagKey: String, CodingKey {
        case tag = "type"
    }

    public init(from decoder: any Decoder) throws {
        let tag = try decoder.container(keyedBy: TagKey.self).decode(String.self, forKey: .tag)
        switch tag {
        case "join_table": self = .joinTable(try JoinTableMessage(from: decoder))
        case "leave_table": self = .leaveTable(try LeaveTableMessage(from: decoder))
        case "sit": self = .sit(try SitMessage(from: decoder))
        case "sit_out": self = .sitOut(try SitOutMessage(from: decoder))
        case "sit_in": self = .sitIn(try SitInMessage(from: decoder))
        case "rebuy": self = .rebuy(try RebuyMessage(from: decoder))
        case "act": self = .act(try ActMessage(from: decoder))
        case "refresh": self = .refresh(try RefreshMessage(from: decoder))
        case "react": self = .react(try ReactMessage(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .tag, in: try decoder.container(keyedBy: TagKey.self),
                debugDescription: "not a ClientMessage: \(tag)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case let .joinTable(message): try message.encode(to: encoder)
        case let .leaveTable(message): try message.encode(to: encoder)
        case let .sit(message): try message.encode(to: encoder)
        case let .sitOut(message): try message.encode(to: encoder)
        case let .sitIn(message): try message.encode(to: encoder)
        case let .rebuy(message): try message.encode(to: encoder)
        case let .act(message): try message.encode(to: encoder)
        case let .refresh(message): try message.encode(to: encoder)
        case let .react(message): try message.encode(to: encoder)
        }
    }
}

/// `GET /api/config`.
public struct ConfigResponse: Codable, Sendable, Hashable {
    public var protocolVersion: Int
    public var bots: [BotOption]
    public var seatCounts: [Int]
    public var stakes: [Stakes]
    /// The preset reactions, in the order to offer them.
    public var reactions: [ReactionOption]
    /// The chips `POST /api/practice` gives, and gives again whenever the guest runs out.
    public var practiceStack: Int?

    public init(
        protocolVersion: Int,
        bots: [BotOption],
        seatCounts: [Int],
        stakes: [Stakes],
        reactions: [ReactionOption],
        practiceStack: Int? = nil
    ) {
        self.protocolVersion = protocolVersion
        self.bots = bots
        self.seatCounts = seatCounts
        self.stakes = stakes
        self.reactions = reactions
        self.practiceStack = practiceStack
    }

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case bots
        case seatCounts = "seat_counts"
        case stakes
        case reactions
        case practiceStack = "practice_stack"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
        bots = try container.decode([BotOption].self, forKey: .bots)
        seatCounts = try container.decode([Int].self, forKey: .seatCounts)
        stakes = try container.decode([Stakes].self, forKey: .stakes)
        reactions = try container.decode([ReactionOption].self, forKey: .reactions)
        practiceStack = try container.decodeIfPresent(Int.self, forKey: .practiceStack)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(protocolVersion, forKey: .protocolVersion)
        try container.encode(bots, forKey: .bots)
        try container.encode(seatCounts, forKey: .seatCounts)
        try container.encode(stakes, forKey: .stakes)
        try container.encode(reactions, forKey: .reactions)
        try container.encodeIfPresent(practiceStack, forKey: .practiceStack)
    }
}

/// Stable codes clients branch on.
///
/// A value this build does not know decodes as itself.
public struct ErrorCode: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let badRequest = ErrorCode(rawValue: "bad_request")
    public static let unauthorized = ErrorCode(rawValue: "unauthorized")
    public static let stale = ErrorCode(rawValue: "stale")
    public static let illegalAction = ErrorCode(rawValue: "illegal_action")
    public static let notYourTurn = ErrorCode(rawValue: "not_your_turn")
    public static let handOver = ErrorCode(rawValue: "hand_over")
    public static let handInProgress = ErrorCode(rawValue: "hand_in_progress")
    public static let unknownTable = ErrorCode(rawValue: "unknown_table")
    public static let unknownSeat = ErrorCode(rawValue: "unknown_seat")
    public static let seatTaken = ErrorCode(rawValue: "seat_taken")
    public static let alreadySeated = ErrorCode(rawValue: "already_seated")
    public static let notSeated = ErrorCode(rawValue: "not_seated")
    public static let badBuyIn = ErrorCode(rawValue: "bad_buy_in")
    public static let notSubscribed = ErrorCode(rawValue: "not_subscribed")
    public static let insufficientChips = ErrorCode(rawValue: "insufficient_chips")
    public static let rateLimited = ErrorCode(rawValue: "rate_limited")

    /// The values this build knows, in the protocol's order.
    public static let known: [ErrorCode] = [
        .badRequest,
        .unauthorized,
        .stale,
        .illegalAction,
        .notYourTurn,
        .handOver,
        .handInProgress,
        .unknownTable,
        .unknownSeat,
        .seatTaken,
        .alreadySeated,
        .notSeated,
        .badBuyIn,
        .notSubscribed,
        .insufficientChips,
        .rateLimited,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

/// A refused message. The table and the view are unchanged.
public struct ErrorMessage: Codable, Sendable, Hashable {
    public static let type = "error"

    public var code: ErrorCode
    public var message: String
    public var tableID: String?

    public init(
        code: ErrorCode,
        message: String,
        tableID: String? = nil
    ) {
        self.code = code
        self.message = message
        self.tableID = tableID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case code
        case message
        case tableID = "table_id"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(ErrorCode.self, forKey: .code)
        message = try container.decode(String.self, forKey: .message)
        tableID = try container.decodeIfPresent(String.self, forKey: .tableID)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(code, forKey: .code)
        try container.encode(message, forKey: .message)
        if let tableID { try container.encode(tableID, forKey: .tableID) } else { try container.encodeNil(forKey: .tableID) }
    }
}

/// What a `TableEvent` reports. The fields it sets are listed per kind.
///
/// A value this build does not know decodes as itself.
public struct EventKind: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let seated = EventKind(rawValue: "seated")
    public static let left = EventKind(rawValue: "left")
    public static let leaving = EventKind(rawValue: "leaving")
    public static let satOut = EventKind(rawValue: "sat_out")
    public static let sittingOutNext = EventKind(rawValue: "sitting_out_next")
    public static let satIn = EventKind(rawValue: "sat_in")
    public static let rebuyPending = EventKind(rawValue: "rebuy_pending")
    public static let rebought = EventKind(rawValue: "rebought")
    public static let rebuyDropped = EventKind(rawValue: "rebuy_dropped")
    public static let connected = EventKind(rawValue: "connected")
    public static let disconnected = EventKind(rawValue: "disconnected")
    public static let handStarted = EventKind(rawValue: "hand_started")
    public static let turn = EventKind(rawValue: "turn")
    public static let timedOut = EventKind(rawValue: "timed_out")
    public static let action = EventKind(rawValue: "action")
    public static let board = EventKind(rawValue: "board")
    public static let handEnded = EventKind(rawValue: "hand_ended")
    public static let reserved = EventKind(rawValue: "reserved")
    public static let reservationEnded = EventKind(rawValue: "reservation_ended")
    public static let waitlist = EventKind(rawValue: "waitlist")

    /// The values this build knows, in the protocol's order.
    public static let known: [EventKind] = [
        .seated,
        .left,
        .leaving,
        .satOut,
        .sittingOutNext,
        .satIn,
        .rebuyPending,
        .rebought,
        .rebuyDropped,
        .connected,
        .disconnected,
        .handStarted,
        .turn,
        .timedOut,
        .action,
        .board,
        .handEnded,
        .reserved,
        .reservationEnded,
        .waitlist,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

/// `GET /api/hands/{hand_id}`: a hand the viewer played, with every card they may see.
public struct HandDetail: Codable, Sendable, Hashable {
    public var hand: HandSummary
    public var button: Int
    public var seats: [HandSeat]
    public var posts: [Post]
    public var actions: [ActionRecord]
    public var pots: [PotResult]
    public var uncalled: Uncalled?
    /// The readable hand history, as the viewer may see it.
    public var text: String

    public init(
        hand: HandSummary,
        button: Int,
        seats: [HandSeat],
        posts: [Post],
        actions: [ActionRecord],
        pots: [PotResult],
        uncalled: Uncalled? = nil,
        text: String
    ) {
        self.hand = hand
        self.button = button
        self.seats = seats
        self.posts = posts
        self.actions = actions
        self.pots = pots
        self.uncalled = uncalled
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case hand
        case button
        case seats
        case posts
        case actions
        case pots
        case uncalled
        case text
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hand = try container.decode(HandSummary.self, forKey: .hand)
        button = try container.decode(Int.self, forKey: .button)
        seats = try container.decode([HandSeat].self, forKey: .seats)
        posts = try container.decode([Post].self, forKey: .posts)
        actions = try container.decode([ActionRecord].self, forKey: .actions)
        pots = try container.decode([PotResult].self, forKey: .pots)
        uncalled = try container.decodeIfPresent(Uncalled.self, forKey: .uncalled)
        text = try container.decode(String.self, forKey: .text)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hand, forKey: .hand)
        try container.encode(button, forKey: .button)
        try container.encode(seats, forKey: .seats)
        try container.encode(posts, forKey: .posts)
        try container.encode(actions, forKey: .actions)
        try container.encode(pots, forKey: .pots)
        if let uncalled { try container.encode(uncalled, forKey: .uncalled) } else { try container.encodeNil(forKey: .uncalled) }
        try container.encode(text, forKey: .text)
    }
}

/// The current hand, or the last one until the next starts.
public struct HandInfo: Codable, Sendable, Hashable {
    public var handNo: Int
    public var button: Int
    public var smallBlindSeat: Int
    public var bigBlindSeat: Int
    public var street: Street
    public var board: [Card]
    /// Everything put in so far, including this street's bets.
    public var pot: Int
    public var currentBet: Int
    public var toAct: Int?
    public var posts: [Post]
    public var actions: [ActionRecord]
    /// Set once the hand is over.
    public var result: HandResult?

    public init(
        handNo: Int,
        button: Int,
        smallBlindSeat: Int,
        bigBlindSeat: Int,
        street: Street,
        board: [Card],
        pot: Int,
        currentBet: Int,
        toAct: Int? = nil,
        posts: [Post],
        actions: [ActionRecord],
        result: HandResult? = nil
    ) {
        self.handNo = handNo
        self.button = button
        self.smallBlindSeat = smallBlindSeat
        self.bigBlindSeat = bigBlindSeat
        self.street = street
        self.board = board
        self.pot = pot
        self.currentBet = currentBet
        self.toAct = toAct
        self.posts = posts
        self.actions = actions
        self.result = result
    }

    enum CodingKeys: String, CodingKey {
        case handNo = "hand_no"
        case button
        case smallBlindSeat = "small_blind_seat"
        case bigBlindSeat = "big_blind_seat"
        case street
        case board
        case pot
        case currentBet = "current_bet"
        case toAct = "to_act"
        case posts
        case actions
        case result
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        handNo = try container.decode(Int.self, forKey: .handNo)
        button = try container.decode(Int.self, forKey: .button)
        smallBlindSeat = try container.decode(Int.self, forKey: .smallBlindSeat)
        bigBlindSeat = try container.decode(Int.self, forKey: .bigBlindSeat)
        street = try container.decode(Street.self, forKey: .street)
        board = try container.decode([Card].self, forKey: .board)
        pot = try container.decode(Int.self, forKey: .pot)
        currentBet = try container.decode(Int.self, forKey: .currentBet)
        toAct = try container.decodeIfPresent(Int.self, forKey: .toAct)
        posts = try container.decode([Post].self, forKey: .posts)
        actions = try container.decode([ActionRecord].self, forKey: .actions)
        result = try container.decodeIfPresent(HandResult.self, forKey: .result)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(handNo, forKey: .handNo)
        try container.encode(button, forKey: .button)
        try container.encode(smallBlindSeat, forKey: .smallBlindSeat)
        try container.encode(bigBlindSeat, forKey: .bigBlindSeat)
        try container.encode(street, forKey: .street)
        try container.encode(board, forKey: .board)
        try container.encode(pot, forKey: .pot)
        try container.encode(currentBet, forKey: .currentBet)
        if let toAct { try container.encode(toAct, forKey: .toAct) } else { try container.encodeNil(forKey: .toAct) }
        try container.encode(posts, forKey: .posts)
        try container.encode(actions, forKey: .actions)
        if let result { try container.encode(result, forKey: .result) } else { try container.encodeNil(forKey: .result) }
    }
}

/// `GET /api/hands`, with optional `limit` (1 to 50) and `before` (a hand id, for the next page).
public struct HandListResponse: Codable, Sendable, Hashable {
    public var hands: [HandSummary]
    /// Whether older hands follow; ask again with `before` set to the last hand id.
    public var more: Bool

    public init(
        hands: [HandSummary],
        more: Bool
    ) {
        self.hands = hands
        self.more = more
    }

    enum CodingKeys: String, CodingKey {
        case hands
        case more
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hands = try container.decode([HandSummary].self, forKey: .hands)
        more = try container.decode(Bool.self, forKey: .more)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hands, forKey: .hands)
        try container.encode(more, forKey: .more)
    }
}

public struct HandResult: Codable, Sendable, Hashable {
    public var pots: [PotResult]
    /// An uncalled bet returned before the pots were formed.
    public var uncalled: Uncalled?
    /// False when everyone else folded.
    public var showdown: Bool
    /// Seats whose cards were shown, in showing order.
    public var shown: [Int]
    /// Seats that mucked without showing.
    public var mucked: [Int]
    /// Chips won from the pots per seat.
    public var winnings: [Int]
    /// Chips won or lost in the hand per seat (0 for seats not dealt in).
    public var net: [Int]

    public init(
        pots: [PotResult],
        uncalled: Uncalled? = nil,
        showdown: Bool,
        shown: [Int],
        mucked: [Int],
        winnings: [Int],
        net: [Int]
    ) {
        self.pots = pots
        self.uncalled = uncalled
        self.showdown = showdown
        self.shown = shown
        self.mucked = mucked
        self.winnings = winnings
        self.net = net
    }

    enum CodingKeys: String, CodingKey {
        case pots
        case uncalled
        case showdown
        case shown
        case mucked
        case winnings
        case net
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pots = try container.decode([PotResult].self, forKey: .pots)
        uncalled = try container.decodeIfPresent(Uncalled.self, forKey: .uncalled)
        showdown = try container.decode(Bool.self, forKey: .showdown)
        shown = try container.decode([Int].self, forKey: .shown)
        mucked = try container.decode([Int].self, forKey: .mucked)
        winnings = try container.decode([Int].self, forKey: .winnings)
        net = try container.decode([Int].self, forKey: .net)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(pots, forKey: .pots)
        if let uncalled { try container.encode(uncalled, forKey: .uncalled) } else { try container.encodeNil(forKey: .uncalled) }
        try container.encode(showdown, forKey: .showdown)
        try container.encode(shown, forKey: .shown)
        try container.encode(mucked, forKey: .mucked)
        try container.encode(winnings, forKey: .winnings)
        try container.encode(net, forKey: .net)
    }
}

/// A seat dealt into the hand. Cards are set only for the viewer and for hands shown at showdown.
public struct HandSeat: Codable, Sendable, Hashable {
    public var seat: Int
    public var name: String
    public var kind: SeatKind
    public var bot: String?
    public var you: Bool
    public var cards: [Card]?
    public var shown: Bool
    public var net: Int

    public init(
        seat: Int,
        name: String,
        kind: SeatKind,
        bot: String? = nil,
        you: Bool,
        cards: [Card]? = nil,
        shown: Bool,
        net: Int
    ) {
        self.seat = seat
        self.name = name
        self.kind = kind
        self.bot = bot
        self.you = you
        self.cards = cards
        self.shown = shown
        self.net = net
    }

    enum CodingKeys: String, CodingKey {
        case seat
        case name
        case kind
        case bot
        case you
        case cards
        case shown
        case net
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seat = try container.decode(Int.self, forKey: .seat)
        name = try container.decode(String.self, forKey: .name)
        kind = try container.decode(SeatKind.self, forKey: .kind)
        bot = try container.decodeIfPresent(String.self, forKey: .bot)
        you = try container.decode(Bool.self, forKey: .you)
        cards = try container.decodeIfPresent([Card].self, forKey: .cards)
        shown = try container.decode(Bool.self, forKey: .shown)
        net = try container.decode(Int.self, forKey: .net)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seat, forKey: .seat)
        try container.encode(name, forKey: .name)
        try container.encode(kind, forKey: .kind)
        if let bot { try container.encode(bot, forKey: .bot) } else { try container.encodeNil(forKey: .bot) }
        try container.encode(you, forKey: .you)
        if let cards { try container.encode(cards, forKey: .cards) } else { try container.encodeNil(forKey: .cards) }
        try container.encode(shown, forKey: .shown)
        try container.encode(net, forKey: .net)
    }
}

/// A finished hand the viewer played, as the hand history lists it.
public struct HandSummary: Codable, Sendable, Hashable {
    public var handID: String
    public var tableID: String
    public var tableName: String
    public var handNo: Int
    /// When the hand ended, in seconds since the epoch.
    public var at: Double
    /// The viewer's seat.
    public var seat: Int
    public var seatCount: Int
    public var smallBlind: Int
    public var bigBlind: Int
    /// The viewer's hole cards.
    public var cards: [Card]
    public var board: [Card]
    /// Chips in the pots at the end.
    public var pot: Int
    /// Chips the viewer won (positive) or lost.
    public var net: Int
    public var showdown: Bool
    /// Played with practice chips; left out of competitive stats.
    public var practice: Bool?

    public init(
        handID: String,
        tableID: String,
        tableName: String,
        handNo: Int,
        at: Double,
        seat: Int,
        seatCount: Int,
        smallBlind: Int,
        bigBlind: Int,
        cards: [Card],
        board: [Card],
        pot: Int,
        net: Int,
        showdown: Bool,
        practice: Bool? = nil
    ) {
        self.handID = handID
        self.tableID = tableID
        self.tableName = tableName
        self.handNo = handNo
        self.at = at
        self.seat = seat
        self.seatCount = seatCount
        self.smallBlind = smallBlind
        self.bigBlind = bigBlind
        self.cards = cards
        self.board = board
        self.pot = pot
        self.net = net
        self.showdown = showdown
        self.practice = practice
    }

    enum CodingKeys: String, CodingKey {
        case handID = "hand_id"
        case tableID = "table_id"
        case tableName = "table_name"
        case handNo = "hand_no"
        case at
        case seat
        case seatCount = "seat_count"
        case smallBlind = "small_blind"
        case bigBlind = "big_blind"
        case cards
        case board
        case pot
        case net
        case showdown
        case practice
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        handID = try container.decode(String.self, forKey: .handID)
        tableID = try container.decode(String.self, forKey: .tableID)
        tableName = try container.decode(String.self, forKey: .tableName)
        handNo = try container.decode(Int.self, forKey: .handNo)
        at = try container.decode(Double.self, forKey: .at)
        seat = try container.decode(Int.self, forKey: .seat)
        seatCount = try container.decode(Int.self, forKey: .seatCount)
        smallBlind = try container.decode(Int.self, forKey: .smallBlind)
        bigBlind = try container.decode(Int.self, forKey: .bigBlind)
        cards = try container.decode([Card].self, forKey: .cards)
        board = try container.decode([Card].self, forKey: .board)
        pot = try container.decode(Int.self, forKey: .pot)
        net = try container.decode(Int.self, forKey: .net)
        showdown = try container.decode(Bool.self, forKey: .showdown)
        practice = try container.decodeIfPresent(Bool.self, forKey: .practice)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(handID, forKey: .handID)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(tableName, forKey: .tableName)
        try container.encode(handNo, forKey: .handNo)
        try container.encode(at, forKey: .at)
        try container.encode(seat, forKey: .seat)
        try container.encode(seatCount, forKey: .seatCount)
        try container.encode(smallBlind, forKey: .smallBlind)
        try container.encode(bigBlind, forKey: .bigBlind)
        try container.encode(cards, forKey: .cards)
        try container.encode(board, forKey: .board)
        try container.encode(pot, forKey: .pot)
        try container.encode(net, forKey: .net)
        try container.encode(showdown, forKey: .showdown)
        try container.encodeIfPresent(practice, forKey: .practice)
    }
}

/// Must be the first message on a socket.
public struct HelloMessage: Codable, Sendable, Hashable {
    public static let type = "hello"
    public static let protocolVersion = 2

    public init() {}

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
    }

    public init(from decoder: any Decoder) throws {
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(Self.protocolVersion, forKey: .protocolVersion)
    }
}

/// Any HTTP error response.
public struct HttpError: Codable, Sendable, Hashable {
    public var detail: String

    public init(
        detail: String
    ) {
        self.detail = detail
    }

    enum CodingKeys: String, CodingKey {
        case detail
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        detail = try container.decode(String.self, forKey: .detail)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(detail, forKey: .detail)
    }
}

/// Follow a table. Rejoining after a reconnect is the same message.
public struct JoinTableMessage: Codable, Sendable, Hashable {
    public static let type = "join_table"

    public var tableID: String

    public init(
        tableID: String
    ) {
        self.tableID = tableID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
    }
}

/// Stop following a table and give up the seat (at the end of the hand if in one).
public struct LeaveTableMessage: Codable, Sendable, Hashable {
    public static let type = "leave_table"

    public var tableID: String

    public init(
        tableID: String
    ) {
        self.tableID = tableID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
    }
}

/// One change to the wallet.
public struct LedgerItem: Codable, Sendable, Hashable {
    public var kind: LedgerKind
    /// Positive for chips paid in, negative for chips paid out.
    public var amount: Int
    public var balanceAfter: Int
    public var tableID: String?
    /// Seconds since the epoch.
    public var at: Double

    public init(
        kind: LedgerKind,
        amount: Int,
        balanceAfter: Int,
        tableID: String? = nil,
        at: Double
    ) {
        self.kind = kind
        self.amount = amount
        self.balanceAfter = balanceAfter
        self.tableID = tableID
        self.at = at
    }

    enum CodingKeys: String, CodingKey {
        case kind
        case amount
        case balanceAfter = "balance_after"
        case tableID = "table_id"
        case at
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(LedgerKind.self, forKey: .kind)
        amount = try container.decode(Int.self, forKey: .amount)
        balanceAfter = try container.decode(Int.self, forKey: .balanceAfter)
        tableID = try container.decodeIfPresent(String.self, forKey: .tableID)
        at = try container.decode(Double.self, forKey: .at)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(amount, forKey: .amount)
        try container.encode(balanceAfter, forKey: .balanceAfter)
        if let tableID { try container.encode(tableID, forKey: .tableID) } else { try container.encodeNil(forKey: .tableID) }
        try container.encode(at, forKey: .at)
    }
}

/// A value this build does not know decodes as itself.
public struct LedgerKind: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let grant = LedgerKind(rawValue: "grant")
    public static let topUp = LedgerKind(rawValue: "top_up")
    public static let buyIn = LedgerKind(rawValue: "buy_in")
    public static let rebuy = LedgerKind(rawValue: "rebuy")
    public static let cashOut = LedgerKind(rawValue: "cash_out")
    public static let refund = LedgerKind(rawValue: "refund")

    /// The values this build knows, in the protocol's order.
    public static let known: [LedgerKind] = [
        .grant,
        .topUp,
        .buyIn,
        .rebuy,
        .cashOut,
        .refund,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

public struct LeftTableMessage: Codable, Sendable, Hashable {
    public static let type = "left_table"

    public var tableID: String

    public init(
        tableID: String
    ) {
        self.tableID = tableID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
    }
}

/// What the viewer may do now (rule 7.7).
public struct Legal: Codable, Sendable, Hashable {
    public var canFold: Bool
    public var canCheck: Bool
    /// Chips a call adds; 0 when there is nothing to call.
    public var call: Int
    public var raiseKind: RaiseKind?
    /// Smallest bet or raise, as a street total.
    public var minTo: Int
    /// Largest bet or raise (all-in), as a street total.
    public var maxTo: Int

    public init(
        canFold: Bool,
        canCheck: Bool,
        call: Int,
        raiseKind: RaiseKind? = nil,
        minTo: Int,
        maxTo: Int
    ) {
        self.canFold = canFold
        self.canCheck = canCheck
        self.call = call
        self.raiseKind = raiseKind
        self.minTo = minTo
        self.maxTo = maxTo
    }

    enum CodingKeys: String, CodingKey {
        case canFold = "can_fold"
        case canCheck = "can_check"
        case call
        case raiseKind = "raise_kind"
        case minTo = "min_to"
        case maxTo = "max_to"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        canFold = try container.decode(Bool.self, forKey: .canFold)
        canCheck = try container.decode(Bool.self, forKey: .canCheck)
        call = try container.decode(Int.self, forKey: .call)
        raiseKind = try container.decodeIfPresent(RaiseKind.self, forKey: .raiseKind)
        minTo = try container.decode(Int.self, forKey: .minTo)
        maxTo = try container.decode(Int.self, forKey: .maxTo)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(canFold, forKey: .canFold)
        try container.encode(canCheck, forKey: .canCheck)
        try container.encode(call, forKey: .call)
        if let raiseKind { try container.encode(raiseKind, forKey: .raiseKind) } else { try container.encodeNil(forKey: .raiseKind) }
        try container.encode(minTo, forKey: .minTo)
        try container.encode(maxTo, forKey: .maxTo)
    }
}

/// `POST /api/tables` with the session cookie. The player takes seat 0.
public struct NewTableRequest: Codable, Sendable, Hashable {
    public var seats: Int?
    /// The kind of bot in every other seat, which gives up its seat when a person wants it; null leaves the seats for people.
    public var bots: String?
    /// One of the config's stakes.
    public var bigBlind: Int?
    /// Defaults to as much of the maximum as the wallet holds.
    public var buyIn: Int?
    /// Unlisted; people join with the invite code.
    public var isPrivate: Bool?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case bots
        case buyIn
    }

    public init(
        seats: Int? = nil,
        bots: String? = nil,
        bigBlind: Int? = nil,
        buyIn: Int? = nil,
        isPrivate: Bool? = nil,
        nulls: Set<Null> = []
    ) {
        self.seats = seats
        self.bots = bots
        self.bigBlind = bigBlind
        self.buyIn = buyIn
        self.isPrivate = isPrivate
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case seats
        case bots
        case bigBlind = "big_blind"
        case buyIn = "buy_in"
        case isPrivate = "private"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seats = try container.decodeIfPresent(Int.self, forKey: .seats)
        bots = try container.decodeIfPresent(String.self, forKey: .bots)
        bigBlind = try container.decodeIfPresent(Int.self, forKey: .bigBlind)
        buyIn = try container.decodeIfPresent(Int.self, forKey: .buyIn)
        isPrivate = try container.decodeIfPresent(Bool.self, forKey: .isPrivate)
        if container.contains(.bots), try container.decodeNil(forKey: .bots) { nulls.insert(.bots) }
        if container.contains(.buyIn), try container.decodeNil(forKey: .buyIn) { nulls.insert(.buyIn) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(seats, forKey: .seats)
        if let bots { try container.encode(bots, forKey: .bots) } else if nulls.contains(.bots) { try container.encodeNil(forKey: .bots) }
        try container.encodeIfPresent(bigBlind, forKey: .bigBlind)
        if let buyIn { try container.encode(buyIn, forKey: .buyIn) } else if nulls.contains(.buyIn) { try container.encodeNil(forKey: .buyIn) }
        try container.encodeIfPresent(isPrivate, forKey: .isPrivate)
    }
}

/// `POST /api/tables`, status 201.
public struct NewTableResponse: Codable, Sendable, Hashable {
    public var tableID: String
    public var seat: Int
    /// A private table's invite code.
    public var invite: String?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case invite
    }

    public init(
        tableID: String,
        seat: Int,
        invite: String? = nil,
        nulls: Set<Null> = []
    ) {
        self.tableID = tableID
        self.seat = seat
        self.invite = invite
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case tableID = "table_id"
        case seat
        case invite
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        seat = try container.decode(Int.self, forKey: .seat)
        invite = try container.decodeIfPresent(String.self, forKey: .invite)
        if container.contains(.invite), try container.decodeNil(forKey: .invite) { nulls.insert(.invite) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(seat, forKey: .seat)
        if let invite { try container.encode(invite, forKey: .invite) } else if nulls.contains(.invite) { try container.encodeNil(forKey: .invite) }
    }
}

public struct Post: Codable, Sendable, Hashable {
    public var seat: Int
    public var kind: PostKind
    public var amount: Int
    public var allIn: Bool

    public init(
        seat: Int,
        kind: PostKind,
        amount: Int,
        allIn: Bool
    ) {
        self.seat = seat
        self.kind = kind
        self.amount = amount
        self.allIn = allIn
    }

    enum CodingKeys: String, CodingKey {
        case seat
        case kind
        case amount
        case allIn = "all_in"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seat = try container.decode(Int.self, forKey: .seat)
        kind = try container.decode(PostKind.self, forKey: .kind)
        amount = try container.decode(Int.self, forKey: .amount)
        allIn = try container.decode(Bool.self, forKey: .allIn)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seat, forKey: .seat)
        try container.encode(kind, forKey: .kind)
        try container.encode(amount, forKey: .amount)
        try container.encode(allIn, forKey: .allIn)
    }
}

/// A value this build does not know decodes as itself.
public struct PostKind: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let ante = PostKind(rawValue: "ante")
    public static let smallBlind = PostKind(rawValue: "small_blind")
    public static let bigBlind = PostKind(rawValue: "big_blind")

    /// The values this build knows, in the protocol's order.
    public static let known: [PostKind] = [
        .ante,
        .smallBlind,
        .bigBlind,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

public struct PotResult: Codable, Sendable, Hashable {
    public var amount: Int
    public var eligible: [Int]
    public var winners: [Int]
    /// Chips each winner took, in the order of winners.
    public var shares: [Int]

    public init(
        amount: Int,
        eligible: [Int],
        winners: [Int],
        shares: [Int]
    ) {
        self.amount = amount
        self.eligible = eligible
        self.winners = winners
        self.shares = shares
    }

    enum CodingKeys: String, CodingKey {
        case amount
        case eligible
        case winners
        case shares
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        amount = try container.decode(Int.self, forKey: .amount)
        eligible = try container.decode([Int].self, forKey: .eligible)
        winners = try container.decode([Int].self, forKey: .winners)
        shares = try container.decode([Int].self, forKey: .shares)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(amount, forKey: .amount)
        try container.encode(eligible, forKey: .eligible)
        try container.encode(winners, forKey: .winners)
        try container.encode(shares, forKey: .shares)
    }
}

/// `POST /api/practice`, with an optional body.
public struct PracticeRequest: Codable, Sendable, Hashable {
    /// The bot to practise against, one that plays two seats. Missing: the table's bot, or RiverMind Easy at a new table.
    public var bot: String?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case bot
    }

    public init(
        bot: String? = nil,
        nulls: Set<Null> = []
    ) {
        self.bot = bot
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case bot
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bot = try container.decodeIfPresent(String.self, forKey: .bot)
        if container.contains(.bot), try container.decodeNil(forKey: .bot) { nulls.insert(.bot) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let bot { try container.encode(bot, forKey: .bot) } else if nulls.contains(.bot) { try container.encodeNil(forKey: .bot) }
    }
}

/// `POST /api/practice`: the guest's practice table, heads-up against a labelled bot (P6.0b).
///
/// The guest sits with a practice stack that never comes from or goes back to the wallet.
/// Asking again while seated there returns the same table. Asking for another bot
/// changes the opponent, at once between hands and otherwise when the hand ends (P5.7a).
public struct PracticeResponse: Codable, Sendable, Hashable {
    public var tableID: String
    public var seat: Int
    /// False when the guest's practice table was already running.
    public var created: Bool
    /// The kind of bot in the other seat.
    public var bot: String
    /// The practice stack, given again whenever the guest runs out.
    public var stack: Int
    /// The kind that takes the bot's seat when the hand in progress ends.
    public var nextBot: String?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case nextBot
    }

    public init(
        tableID: String,
        seat: Int,
        created: Bool,
        bot: String,
        stack: Int,
        nextBot: String? = nil,
        nulls: Set<Null> = []
    ) {
        self.tableID = tableID
        self.seat = seat
        self.created = created
        self.bot = bot
        self.stack = stack
        self.nextBot = nextBot
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case tableID = "table_id"
        case seat
        case created
        case bot
        case stack
        case nextBot = "next_bot"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        seat = try container.decode(Int.self, forKey: .seat)
        created = try container.decode(Bool.self, forKey: .created)
        bot = try container.decode(String.self, forKey: .bot)
        stack = try container.decode(Int.self, forKey: .stack)
        nextBot = try container.decodeIfPresent(String.self, forKey: .nextBot)
        if container.contains(.nextBot), try container.decodeNil(forKey: .nextBot) { nulls.insert(.nextBot) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(seat, forKey: .seat)
        try container.encode(created, forKey: .created)
        try container.encode(bot, forKey: .bot)
        try container.encode(stack, forKey: .stack)
        if let nextBot { try container.encode(nextBot, forKey: .nextBot) } else if nulls.contains(.nextBot) { try container.encodeNil(forKey: .nextBot) }
    }
}

/// `POST /api/quick-seat`: a seat at the busiest matching public table, or a new table with bots.
public struct QuickSeatRequest: Codable, Sendable, Hashable {
    public var seats: Int?
    public var bigBlind: Int?
    /// Defaults to as much of the maximum as the wallet holds.
    public var buyIn: Int?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case seats
        case bigBlind
        case buyIn
    }

    public init(
        seats: Int? = nil,
        bigBlind: Int? = nil,
        buyIn: Int? = nil,
        nulls: Set<Null> = []
    ) {
        self.seats = seats
        self.bigBlind = bigBlind
        self.buyIn = buyIn
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case seats
        case bigBlind = "big_blind"
        case buyIn = "buy_in"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seats = try container.decodeIfPresent(Int.self, forKey: .seats)
        bigBlind = try container.decodeIfPresent(Int.self, forKey: .bigBlind)
        buyIn = try container.decodeIfPresent(Int.self, forKey: .buyIn)
        if container.contains(.seats), try container.decodeNil(forKey: .seats) { nulls.insert(.seats) }
        if container.contains(.bigBlind), try container.decodeNil(forKey: .bigBlind) { nulls.insert(.bigBlind) }
        if container.contains(.buyIn), try container.decodeNil(forKey: .buyIn) { nulls.insert(.buyIn) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let seats { try container.encode(seats, forKey: .seats) } else if nulls.contains(.seats) { try container.encodeNil(forKey: .seats) }
        if let bigBlind { try container.encode(bigBlind, forKey: .bigBlind) } else if nulls.contains(.bigBlind) { try container.encodeNil(forKey: .bigBlind) }
        if let buyIn { try container.encode(buyIn, forKey: .buyIn) } else if nulls.contains(.buyIn) { try container.encodeNil(forKey: .buyIn) }
    }
}

/// A value this build does not know decodes as itself.
public struct RaiseKind: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let bet = RaiseKind(rawValue: "bet")
    public static let raise = RaiseKind(rawValue: "raise")

    /// The values this build knows, in the protocol's order.
    public static let known: [RaiseKind] = [
        .bet,
        .raise,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

/// A preset reaction from a seated person (P4.5).
public struct ReactMessage: Codable, Sendable, Hashable {
    public static let type = "react"

    public var tableID: String
    public var reaction: Reaction

    public init(
        tableID: String,
        reaction: Reaction
    ) {
        self.tableID = tableID
        self.reaction = reaction
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
        case reaction
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        reaction = try container.decode(Reaction.self, forKey: .reaction)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(reaction, forKey: .reaction)
    }
}

/// Preset reactions (Q-4: no free-text chat in 1.0).
///
/// A value this build does not know decodes as itself.
public struct Reaction: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let hello = Reaction(rawValue: "hello")
    public static let niceHand = Reaction(rawValue: "nice_hand")
    public static let wellPlayed = Reaction(rawValue: "well_played")
    public static let goodGame = Reaction(rawValue: "good_game")
    public static let unlucky = Reaction(rawValue: "unlucky")
    public static let thanks = Reaction(rawValue: "thanks")
    public static let wow = Reaction(rawValue: "wow")
    public static let thinking = Reaction(rawValue: "thinking")

    /// The values this build knows, in the protocol's order.
    public static let known: [Reaction] = [
        .hello,
        .niceHand,
        .wellPlayed,
        .goodGame,
        .unlucky,
        .thanks,
        .wow,
        .thinking,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

/// A seated person's reaction, not sent to anyone who muted or blocked them.
public struct ReactionMessage: Codable, Sendable, Hashable {
    public static let type = "reaction"

    public var tableID: String
    public var seat: Int
    public var name: String
    public var ref: String
    public var reaction: Reaction
    public var text: String

    public init(
        tableID: String,
        seat: Int,
        name: String,
        ref: String,
        reaction: Reaction,
        text: String
    ) {
        self.tableID = tableID
        self.seat = seat
        self.name = name
        self.ref = ref
        self.reaction = reaction
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
        case seat
        case name
        case ref
        case reaction
        case text
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        seat = try container.decode(Int.self, forKey: .seat)
        name = try container.decode(String.self, forKey: .name)
        ref = try container.decode(String.self, forKey: .ref)
        reaction = try container.decode(Reaction.self, forKey: .reaction)
        text = try container.decode(String.self, forKey: .text)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(seat, forKey: .seat)
        try container.encode(name, forKey: .name)
        try container.encode(ref, forKey: .ref)
        try container.encode(reaction, forKey: .reaction)
        try container.encode(text, forKey: .text)
    }
}

public struct ReactionOption: Codable, Sendable, Hashable {
    public var kind: Reaction
    public var text: String

    public init(
        kind: Reaction,
        text: String
    ) {
        self.kind = kind
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case kind
        case text
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(Reaction.self, forKey: .kind)
        text = try container.decode(String.self, forKey: .text)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(text, forKey: .text)
    }
}

public struct RebuyMessage: Codable, Sendable, Hashable {
    public static let type = "rebuy"

    public var tableID: String
    public var amount: Int

    public init(
        tableID: String,
        amount: Int
    ) {
        self.tableID = tableID
        self.amount = amount
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
        case amount
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        amount = try container.decode(Int.self, forKey: .amount)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(amount, forKey: .amount)
    }
}

public struct RefreshMessage: Codable, Sendable, Hashable {
    public static let type = "refresh"

    public var tableID: String

    public init(
        tableID: String
    ) {
        self.tableID = tableID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
    }
}

public struct RelationItem: Codable, Sendable, Hashable {
    public var ref: String
    public var name: String
    public var kind: RelationKind

    public init(
        ref: String,
        name: String,
        kind: RelationKind
    ) {
        self.ref = ref
        self.name = name
        self.kind = kind
    }

    enum CodingKeys: String, CodingKey {
        case ref
        case name
        case kind
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ref = try container.decode(String.self, forKey: .ref)
        name = try container.decode(String.self, forKey: .name)
        kind = try container.decode(RelationKind.self, forKey: .kind)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(ref, forKey: .ref)
        try container.encode(name, forKey: .name)
        try container.encode(kind, forKey: .kind)
    }
}

/// A value this build does not know decodes as itself.
public struct RelationKind: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let mute = RelationKind(rawValue: "mute")
    public static let block = RelationKind(rawValue: "block")

    /// The values this build knows, in the protocol's order.
    public static let known: [RelationKind] = [
        .mute,
        .block,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

/// `PUT /api/relations`: mute or block the person in a seat.
public struct RelationRequest: Codable, Sendable, Hashable {
    public var tableID: String
    public var seat: Int
    public var kind: RelationKind

    public init(
        tableID: String,
        seat: Int,
        kind: RelationKind
    ) {
        self.tableID = tableID
        self.seat = seat
        self.kind = kind
    }

    enum CodingKeys: String, CodingKey {
        case tableID = "table_id"
        case seat
        case kind
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        seat = try container.decode(Int.self, forKey: .seat)
        kind = try container.decode(RelationKind.self, forKey: .kind)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(seat, forKey: .seat)
        try container.encode(kind, forKey: .kind)
    }
}

/// `GET /api/relations`, and `PUT` and `DELETE /api/relations/{ref}`: everyone the viewer muted or blocked.
public struct RelationsResponse: Codable, Sendable, Hashable {
    public var players: [RelationItem]

    public init(
        players: [RelationItem]
    ) {
        self.players = players
    }

    enum CodingKeys: String, CodingKey {
        case players
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        players = try container.decode([RelationItem].self, forKey: .players)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(players, forKey: .players)
    }
}

/// `voice` is something said in table voice (P4C.8), of which no recording exists.
///
/// A value this build does not know decodes as itself.
public struct ReportReason: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let handle = ReportReason(rawValue: "handle")
    public static let abuse = ReportReason(rawValue: "abuse")
    public static let collusion = ReportReason(rawValue: "collusion")
    public static let other = ReportReason(rawValue: "other")
    public static let voice = ReportReason(rawValue: "voice")

    /// The values this build knows, in the protocol's order.
    public static let known: [ReportReason] = [
        .handle,
        .abuse,
        .collusion,
        .other,
        .voice,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

/// `POST /api/reports`: report the person in a seat, for review.
public struct ReportRequest: Codable, Sendable, Hashable {
    public var tableID: String
    public var seat: Int
    public var reason: ReportReason

    public init(
        tableID: String,
        seat: Int,
        reason: ReportReason
    ) {
        self.tableID = tableID
        self.seat = seat
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey {
        case tableID = "table_id"
        case seat
        case reason
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        seat = try container.decode(Int.self, forKey: .seat)
        reason = try container.decode(ReportReason.self, forKey: .reason)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(seat, forKey: .seat)
        try container.encode(reason, forKey: .reason)
    }
}

/// `POST /api/reports`, status 201.
public struct ReportResponse: Codable, Sendable, Hashable {
    /// False when the same report was already made today; it counts once.
    public var recorded: Bool

    public init(
        recorded: Bool
    ) {
        self.recorded = recorded
    }

    enum CodingKeys: String, CodingKey {
        case recorded
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        recorded = try container.decode(Bool.self, forKey: .recorded)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(recorded, forKey: .recorded)
    }
}

/// A seat held for a player while they buy in (rule 2.4).
public struct SeatHold: Codable, Sendable, Hashable {
    public var seat: Int
    public var name: String
    /// False while a bot plays out the hand before giving up the seat.
    public var ready: Bool
    /// When the hold runs out; null until it is ready.
    public var until: Double?

    public init(
        seat: Int,
        name: String,
        ready: Bool,
        until: Double? = nil
    ) {
        self.seat = seat
        self.name = name
        self.ready = ready
        self.until = until
    }

    enum CodingKeys: String, CodingKey {
        case seat
        case name
        case ready
        case until
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seat = try container.decode(Int.self, forKey: .seat)
        name = try container.decode(String.self, forKey: .name)
        ready = try container.decode(Bool.self, forKey: .ready)
        until = try container.decodeIfPresent(Double.self, forKey: .until)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seat, forKey: .seat)
        try container.encode(name, forKey: .name)
        try container.encode(ready, forKey: .ready)
        if let until { try container.encode(until, forKey: .until) } else { try container.encodeNil(forKey: .until) }
    }
}

/// An occupied seat as the viewer may see it.
public struct SeatInfo: Codable, Sendable, Hashable {
    public var seat: Int
    public var name: String
    public var kind: SeatKind
    /// A person's public reference, the same at every table, for mutes and blocks; null for bots.
    public var ref: String?
    /// The bot kind for a bot seat (bots are always labelled).
    public var bot: String?
    /// Chips behind right now.
    public var stack: Int
    /// Chips put in on the current street.
    public var bet: Int
    /// Dealt into the hand in progress and not folded.
    public var inHand: Bool
    public var folded: Bool
    public var allIn: Bool
    public var sittingOut: Bool
    public var leaving: Bool
    public var connected: Bool
    /// Holds cards in the hand in progress, shown or not.
    public var hasCards: Bool
    /// The viewer's own cards, or cards shown at showdown; null when hidden.
    public var cards: [Card]?

    public init(
        seat: Int,
        name: String,
        kind: SeatKind,
        ref: String? = nil,
        bot: String? = nil,
        stack: Int,
        bet: Int,
        inHand: Bool,
        folded: Bool,
        allIn: Bool,
        sittingOut: Bool,
        leaving: Bool,
        connected: Bool,
        hasCards: Bool,
        cards: [Card]? = nil
    ) {
        self.seat = seat
        self.name = name
        self.kind = kind
        self.ref = ref
        self.bot = bot
        self.stack = stack
        self.bet = bet
        self.inHand = inHand
        self.folded = folded
        self.allIn = allIn
        self.sittingOut = sittingOut
        self.leaving = leaving
        self.connected = connected
        self.hasCards = hasCards
        self.cards = cards
    }

    enum CodingKeys: String, CodingKey {
        case seat
        case name
        case kind
        case ref
        case bot
        case stack
        case bet
        case inHand = "in_hand"
        case folded
        case allIn = "all_in"
        case sittingOut = "sitting_out"
        case leaving
        case connected
        case hasCards = "has_cards"
        case cards
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seat = try container.decode(Int.self, forKey: .seat)
        name = try container.decode(String.self, forKey: .name)
        kind = try container.decode(SeatKind.self, forKey: .kind)
        ref = try container.decodeIfPresent(String.self, forKey: .ref)
        bot = try container.decodeIfPresent(String.self, forKey: .bot)
        stack = try container.decode(Int.self, forKey: .stack)
        bet = try container.decode(Int.self, forKey: .bet)
        inHand = try container.decode(Bool.self, forKey: .inHand)
        folded = try container.decode(Bool.self, forKey: .folded)
        allIn = try container.decode(Bool.self, forKey: .allIn)
        sittingOut = try container.decode(Bool.self, forKey: .sittingOut)
        leaving = try container.decode(Bool.self, forKey: .leaving)
        connected = try container.decode(Bool.self, forKey: .connected)
        hasCards = try container.decode(Bool.self, forKey: .hasCards)
        cards = try container.decodeIfPresent([Card].self, forKey: .cards)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seat, forKey: .seat)
        try container.encode(name, forKey: .name)
        try container.encode(kind, forKey: .kind)
        if let ref { try container.encode(ref, forKey: .ref) } else { try container.encodeNil(forKey: .ref) }
        if let bot { try container.encode(bot, forKey: .bot) } else { try container.encodeNil(forKey: .bot) }
        try container.encode(stack, forKey: .stack)
        try container.encode(bet, forKey: .bet)
        try container.encode(inHand, forKey: .inHand)
        try container.encode(folded, forKey: .folded)
        try container.encode(allIn, forKey: .allIn)
        try container.encode(sittingOut, forKey: .sittingOut)
        try container.encode(leaving, forKey: .leaving)
        try container.encode(connected, forKey: .connected)
        try container.encode(hasCards, forKey: .hasCards)
        if let cards { try container.encode(cards, forKey: .cards) } else { try container.encodeNil(forKey: .cards) }
    }
}

/// A value this build does not know decodes as itself.
public struct SeatKind: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let human = SeatKind(rawValue: "human")
    public static let bot = SeatKind(rawValue: "bot")

    /// The values this build knows, in the protocol's order.
    public static let known: [SeatKind] = [
        .human,
        .bot,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

/// `POST /api/tables/{table_id}/seat`: hold a seat and, unless `hold_only`, buy in and sit in it.
public struct SeatRequest: Codable, Sendable, Hashable {
    /// A seat to take; by default the server picks one.
    public var seat: Int?
    /// Defaults to as much of the maximum as the wallet holds.
    public var buyIn: Int?
    /// Only hold the seat, to buy in later with a `sit` message.
    public var holdOnly: Bool?
    /// Needed for a private table.
    public var invite: String?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case seat
        case buyIn
        case invite
    }

    public init(
        seat: Int? = nil,
        buyIn: Int? = nil,
        holdOnly: Bool? = nil,
        invite: String? = nil,
        nulls: Set<Null> = []
    ) {
        self.seat = seat
        self.buyIn = buyIn
        self.holdOnly = holdOnly
        self.invite = invite
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case seat
        case buyIn = "buy_in"
        case holdOnly = "hold_only"
        case invite
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seat = try container.decodeIfPresent(Int.self, forKey: .seat)
        buyIn = try container.decodeIfPresent(Int.self, forKey: .buyIn)
        holdOnly = try container.decodeIfPresent(Bool.self, forKey: .holdOnly)
        invite = try container.decodeIfPresent(String.self, forKey: .invite)
        if container.contains(.seat), try container.decodeNil(forKey: .seat) { nulls.insert(.seat) }
        if container.contains(.buyIn), try container.decodeNil(forKey: .buyIn) { nulls.insert(.buyIn) }
        if container.contains(.invite), try container.decodeNil(forKey: .invite) { nulls.insert(.invite) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let seat { try container.encode(seat, forKey: .seat) } else if nulls.contains(.seat) { try container.encodeNil(forKey: .seat) }
        if let buyIn { try container.encode(buyIn, forKey: .buyIn) } else if nulls.contains(.buyIn) { try container.encodeNil(forKey: .buyIn) }
        try container.encodeIfPresent(holdOnly, forKey: .holdOnly)
        if let invite { try container.encode(invite, forKey: .invite) } else if nulls.contains(.invite) { try container.encodeNil(forKey: .invite) }
    }
}

/// `POST /api/tables/{table_id}/seat` and `POST /api/quick-seat`.
public struct SeatResponse: Codable, Sendable, Hashable {
    public var tableID: String
    public var seat: Int
    /// True when the player now sits at the table.
    public var seated: Bool
    /// When not seated: the held seat. Sit in it with a `sit` message once it is ready.
    public var hold: SeatHold?

    public init(
        tableID: String,
        seat: Int,
        seated: Bool,
        hold: SeatHold? = nil
    ) {
        self.tableID = tableID
        self.seat = seat
        self.seated = seated
        self.hold = hold
    }

    enum CodingKeys: String, CodingKey {
        case tableID = "table_id"
        case seat
        case seated
        case hold
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        seat = try container.decode(Int.self, forKey: .seat)
        seated = try container.decode(Bool.self, forKey: .seated)
        hold = try container.decodeIfPresent(SeatHold.self, forKey: .hold)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(seat, forKey: .seat)
        try container.encode(seated, forKey: .seated)
        if let hold { try container.encode(hold, forKey: .hold) } else { try container.encodeNil(forKey: .hold) }
    }
}

/// Any message the server sends.
public enum ServerMessage: Codable, Sendable, Hashable {
    case welcome(WelcomeMessage)
    case table(TableMessage)
    case leftTable(LeftTableMessage)
    case tableClosed(TableClosedMessage)
    case reaction(ReactionMessage)
    case error(ErrorMessage)
    /// A message this build does not know, kept whole.
    case unknown(String, JSONValue)

    /// The `type` that names the message.
    public var type: String {
        switch self {
        case .welcome: "welcome"
        case .table: "table"
        case .leftTable: "left_table"
        case .tableClosed: "table_closed"
        case .reaction: "reaction"
        case .error: "error"
        case let .unknown(tag, _): tag
        }
    }

    private enum TagKey: String, CodingKey {
        case tag = "type"
    }

    public init(from decoder: any Decoder) throws {
        let tag = try decoder.container(keyedBy: TagKey.self).decode(String.self, forKey: .tag)
        switch tag {
        case "welcome": self = .welcome(try WelcomeMessage(from: decoder))
        case "table": self = .table(try TableMessage(from: decoder))
        case "left_table": self = .leftTable(try LeftTableMessage(from: decoder))
        case "table_closed": self = .tableClosed(try TableClosedMessage(from: decoder))
        case "reaction": self = .reaction(try ReactionMessage(from: decoder))
        case "error": self = .error(try ErrorMessage(from: decoder))
        default: self = .unknown(tag, try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case let .welcome(message): try message.encode(to: encoder)
        case let .table(message): try message.encode(to: encoder)
        case let .leftTable(message): try message.encode(to: encoder)
        case let .tableClosed(message): try message.encode(to: encoder)
        case let .reaction(message): try message.encode(to: encoder)
        case let .error(message): try message.encode(to: encoder)
        case let .unknown(_, value): try value.encode(to: encoder)
        }
    }
}

/// `POST /api/session`, with an optional body.
public struct SessionRequest: Codable, Sendable, Hashable {
    /// The bearer token a Phase 3 client kept, to move that player onto a session cookie.
    public var legacyToken: String?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case legacyToken
    }

    public init(
        legacyToken: String? = nil,
        nulls: Set<Null> = []
    ) {
        self.legacyToken = legacyToken
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case legacyToken = "legacy_token"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        legacyToken = try container.decodeIfPresent(String.self, forKey: .legacyToken)
        if container.contains(.legacyToken), try container.decodeNil(forKey: .legacyToken) { nulls.insert(.legacyToken) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let legacyToken { try container.encode(legacyToken, forKey: .legacyToken) } else if nulls.contains(.legacyToken) { try container.encodeNil(forKey: .legacyToken) }
    }
}

/// `POST /api/session`: the player this browser is. The session itself is in an `HttpOnly` cookie.
public struct SessionResponse: Codable, Sendable, Hashable {
    public var playerID: String
    public var name: String
    /// Whether this request made a new player.
    public var created: Bool
    /// Play chips in the wallet, after any grant or top-up this visit paid.
    public var balance: Int

    public init(
        playerID: String,
        name: String,
        created: Bool,
        balance: Int
    ) {
        self.playerID = playerID
        self.name = name
        self.created = created
        self.balance = balance
    }

    enum CodingKeys: String, CodingKey {
        case playerID = "player_id"
        case name
        case created
        case balance
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        playerID = try container.decode(String.self, forKey: .playerID)
        name = try container.decode(String.self, forKey: .name)
        created = try container.decode(Bool.self, forKey: .created)
        balance = try container.decode(Int.self, forKey: .balance)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(playerID, forKey: .playerID)
        try container.encode(name, forKey: .name)
        try container.encode(created, forKey: .created)
        try container.encode(balance, forKey: .balance)
    }
}

public struct SitInMessage: Codable, Sendable, Hashable {
    public static let type = "sit_in"

    public var tableID: String

    public init(
        tableID: String
    ) {
        self.tableID = tableID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
    }
}

public struct SitMessage: Codable, Sendable, Hashable {
    public static let type = "sit"

    public var tableID: String
    public var seat: Int
    public var buyIn: Int

    public init(
        tableID: String,
        seat: Int,
        buyIn: Int
    ) {
        self.tableID = tableID
        self.seat = seat
        self.buyIn = buyIn
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
        case seat
        case buyIn = "buy_in"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        seat = try container.decode(Int.self, forKey: .seat)
        buyIn = try container.decode(Int.self, forKey: .buyIn)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(seat, forKey: .seat)
        try container.encode(buyIn, forKey: .buyIn)
    }
}

public struct SitOutMessage: Codable, Sendable, Hashable {
    public static let type = "sit_out"

    public var tableID: String

    public init(
        tableID: String
    ) {
        self.tableID = tableID
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
    }
}

public struct Stakes: Codable, Sendable, Hashable {
    public var smallBlind: Int
    public var bigBlind: Int

    public init(
        smallBlind: Int,
        bigBlind: Int
    ) {
        self.smallBlind = smallBlind
        self.bigBlind = bigBlind
    }

    enum CodingKeys: String, CodingKey {
        case smallBlind = "small_blind"
        case bigBlind = "big_blind"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        smallBlind = try container.decode(Int.self, forKey: .smallBlind)
        bigBlind = try container.decode(Int.self, forKey: .bigBlind)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(smallBlind, forKey: .smallBlind)
        try container.encode(bigBlind, forKey: .bigBlind)
    }
}

/// A value this build does not know decodes as itself.
public struct Street: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let preFlop = Street(rawValue: "pre-flop")
    public static let flop = Street(rawValue: "flop")
    public static let turn = Street(rawValue: "turn")
    public static let river = Street(rawValue: "river")

    /// The values this build knows, in the protocol's order.
    public static let known: [Street] = [
        .preFlop,
        .flop,
        .turn,
        .river,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

/// A value this build does not know decodes as itself.
public struct Suit: RawRepresentable, Codable, Sendable, Hashable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: any Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let spades = Suit(rawValue: "spades")
    public static let hearts = Suit(rawValue: "hearts")
    public static let diamonds = Suit(rawValue: "diamonds")
    public static let clubs = Suit(rawValue: "clubs")

    /// The values this build knows, in the protocol's order.
    public static let known: [Suit] = [
        .spades,
        .hearts,
        .diamonds,
        .clubs,
    ]

    /// Whether this build knows the value.
    public var isKnown: Bool { Self.known.contains(self) }
}

public struct TableClosedMessage: Codable, Sendable, Hashable {
    public static let type = "table_closed"

    public var tableID: String
    public var message: String

    public init(
        tableID: String,
        message: String
    ) {
        self.tableID = tableID
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
        case message
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        message = try container.decode(String.self, forKey: .message)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(message, forKey: .message)
    }
}

/// A public change at a table.
public struct TableEvent: Codable, Sendable, Hashable {
    /// Increases by one per event at a table.
    public var seq: Int
    public var kind: EventKind
    public var seat: Int?
    public var name: String?
    public var amount: Int?
    public var added: Int?
    public var allIn: Bool?
    public var action: ActionKind?
    public var street: Street?
    public var cards: [Card]?
    public var reason: String?
    public var handNo: Int?
    public var count: Int?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case seat
        case name
        case amount
        case added
        case allIn
        case action
        case street
        case cards
        case reason
        case handNo
        case count
    }

    public init(
        seq: Int,
        kind: EventKind,
        seat: Int? = nil,
        name: String? = nil,
        amount: Int? = nil,
        added: Int? = nil,
        allIn: Bool? = nil,
        action: ActionKind? = nil,
        street: Street? = nil,
        cards: [Card]? = nil,
        reason: String? = nil,
        handNo: Int? = nil,
        count: Int? = nil,
        nulls: Set<Null> = []
    ) {
        self.seq = seq
        self.kind = kind
        self.seat = seat
        self.name = name
        self.amount = amount
        self.added = added
        self.allIn = allIn
        self.action = action
        self.street = street
        self.cards = cards
        self.reason = reason
        self.handNo = handNo
        self.count = count
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case seq
        case kind
        case seat
        case name
        case amount
        case added
        case allIn = "all_in"
        case action
        case street
        case cards
        case reason
        case handNo = "hand_no"
        case count
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seq = try container.decode(Int.self, forKey: .seq)
        kind = try container.decode(EventKind.self, forKey: .kind)
        seat = try container.decodeIfPresent(Int.self, forKey: .seat)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        amount = try container.decodeIfPresent(Int.self, forKey: .amount)
        added = try container.decodeIfPresent(Int.self, forKey: .added)
        allIn = try container.decodeIfPresent(Bool.self, forKey: .allIn)
        action = try container.decodeIfPresent(ActionKind.self, forKey: .action)
        street = try container.decodeIfPresent(Street.self, forKey: .street)
        cards = try container.decodeIfPresent([Card].self, forKey: .cards)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        handNo = try container.decodeIfPresent(Int.self, forKey: .handNo)
        count = try container.decodeIfPresent(Int.self, forKey: .count)
        if container.contains(.seat), try container.decodeNil(forKey: .seat) { nulls.insert(.seat) }
        if container.contains(.name), try container.decodeNil(forKey: .name) { nulls.insert(.name) }
        if container.contains(.amount), try container.decodeNil(forKey: .amount) { nulls.insert(.amount) }
        if container.contains(.added), try container.decodeNil(forKey: .added) { nulls.insert(.added) }
        if container.contains(.allIn), try container.decodeNil(forKey: .allIn) { nulls.insert(.allIn) }
        if container.contains(.action), try container.decodeNil(forKey: .action) { nulls.insert(.action) }
        if container.contains(.street), try container.decodeNil(forKey: .street) { nulls.insert(.street) }
        if container.contains(.cards), try container.decodeNil(forKey: .cards) { nulls.insert(.cards) }
        if container.contains(.reason), try container.decodeNil(forKey: .reason) { nulls.insert(.reason) }
        if container.contains(.handNo), try container.decodeNil(forKey: .handNo) { nulls.insert(.handNo) }
        if container.contains(.count), try container.decodeNil(forKey: .count) { nulls.insert(.count) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seq, forKey: .seq)
        try container.encode(kind, forKey: .kind)
        if let seat { try container.encode(seat, forKey: .seat) } else if nulls.contains(.seat) { try container.encodeNil(forKey: .seat) }
        if let name { try container.encode(name, forKey: .name) } else if nulls.contains(.name) { try container.encodeNil(forKey: .name) }
        if let amount { try container.encode(amount, forKey: .amount) } else if nulls.contains(.amount) { try container.encodeNil(forKey: .amount) }
        if let added { try container.encode(added, forKey: .added) } else if nulls.contains(.added) { try container.encodeNil(forKey: .added) }
        if let allIn { try container.encode(allIn, forKey: .allIn) } else if nulls.contains(.allIn) { try container.encodeNil(forKey: .allIn) }
        if let action { try container.encode(action, forKey: .action) } else if nulls.contains(.action) { try container.encodeNil(forKey: .action) }
        if let street { try container.encode(street, forKey: .street) } else if nulls.contains(.street) { try container.encodeNil(forKey: .street) }
        if let cards { try container.encode(cards, forKey: .cards) } else if nulls.contains(.cards) { try container.encodeNil(forKey: .cards) }
        if let reason { try container.encode(reason, forKey: .reason) } else if nulls.contains(.reason) { try container.encodeNil(forKey: .reason) }
        if let handNo { try container.encode(handNo, forKey: .handNo) } else if nulls.contains(.handNo) { try container.encodeNil(forKey: .handNo) }
        if let count { try container.encode(count, forKey: .count) } else if nulls.contains(.count) { try container.encodeNil(forKey: .count) }
    }
}

/// `GET /api/tables`, with optional filters `seats`, `big_blind` and `open` (only tables with a seat to take).
///
/// Public tables, and private ones the viewer is at, most people first.
public struct TableListResponse: Codable, Sendable, Hashable {
    public var tables: [TableSummary]

    public init(
        tables: [TableSummary]
    ) {
        self.tables = tables
    }

    enum CodingKeys: String, CodingKey {
        case tables
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tables = try container.decode([TableSummary].self, forKey: .tables)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tables, forKey: .tables)
    }
}

/// A table's view after a change, with the events since the last one sent.
public struct TableMessage: Codable, Sendable, Hashable {
    public static let type = "table"

    public var tableID: String
    public var view: TableView
    public var events: [TableEvent]

    public init(
        tableID: String,
        view: TableView,
        events: [TableEvent]
    ) {
        self.tableID = tableID
        self.view = view
        self.events = events
    }

    enum CodingKeys: String, CodingKey {
        case type
        case tableID = "table_id"
        case view
        case events
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        view = try container.decode(TableView.self, forKey: .view)
        events = try container.decode([TableEvent].self, forKey: .events)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(view, forKey: .view)
        try container.encode(events, forKey: .events)
    }
}

public struct TableSettings: Codable, Sendable, Hashable {
    public var seatCount: Int
    public var smallBlind: Int
    public var bigBlind: Int
    public var ante: Int
    public var minBuyIn: Int
    public var maxBuyIn: Int
    public var actionSeconds: Double
    public var timeBankSeconds: Double

    public init(
        seatCount: Int,
        smallBlind: Int,
        bigBlind: Int,
        ante: Int,
        minBuyIn: Int,
        maxBuyIn: Int,
        actionSeconds: Double,
        timeBankSeconds: Double
    ) {
        self.seatCount = seatCount
        self.smallBlind = smallBlind
        self.bigBlind = bigBlind
        self.ante = ante
        self.minBuyIn = minBuyIn
        self.maxBuyIn = maxBuyIn
        self.actionSeconds = actionSeconds
        self.timeBankSeconds = timeBankSeconds
    }

    enum CodingKeys: String, CodingKey {
        case seatCount = "seat_count"
        case smallBlind = "small_blind"
        case bigBlind = "big_blind"
        case ante
        case minBuyIn = "min_buy_in"
        case maxBuyIn = "max_buy_in"
        case actionSeconds = "action_seconds"
        case timeBankSeconds = "time_bank_seconds"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seatCount = try container.decode(Int.self, forKey: .seatCount)
        smallBlind = try container.decode(Int.self, forKey: .smallBlind)
        bigBlind = try container.decode(Int.self, forKey: .bigBlind)
        ante = try container.decode(Int.self, forKey: .ante)
        minBuyIn = try container.decode(Int.self, forKey: .minBuyIn)
        maxBuyIn = try container.decode(Int.self, forKey: .maxBuyIn)
        actionSeconds = try container.decode(Double.self, forKey: .actionSeconds)
        timeBankSeconds = try container.decode(Double.self, forKey: .timeBankSeconds)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seatCount, forKey: .seatCount)
        try container.encode(smallBlind, forKey: .smallBlind)
        try container.encode(bigBlind, forKey: .bigBlind)
        try container.encode(ante, forKey: .ante)
        try container.encode(minBuyIn, forKey: .minBuyIn)
        try container.encode(maxBuyIn, forKey: .maxBuyIn)
        try container.encode(actionSeconds, forKey: .actionSeconds)
        try container.encode(timeBankSeconds, forKey: .timeBankSeconds)
    }
}

/// A table as the lobby lists it.
public struct TableSummary: Codable, Sendable, Hashable {
    public var tableID: String
    public var name: String
    public var seatCount: Int
    public var smallBlind: Int
    public var bigBlind: Int
    public var minBuyIn: Int
    public var maxBuyIn: Int
    public var isPrivate: Bool
    /// People seated.
    public var people: Int
    /// Bots seated.
    public var bots: Int
    /// Empty seats nobody holds.
    public var freeSeats: Int
    /// Bots' seats a person can claim; the bot leaves when its hand ends.
    public var botSeats: Int
    /// Seats held for players buying in.
    public var holds: Int
    public var waitlist: Int
    /// Hands dealt so far.
    public var handNo: Int
    /// Whether the viewer has a seat here.
    public var seated: Bool
    /// The seat held for the viewer here, if any.
    public var hold: SeatHold?
    /// The viewer's place on the waitlist here, from 1.
    public var waitlistPosition: Int?
    /// Someone the viewer blocked, or who blocked the viewer, is seated here.
    public var blocked: Bool

    public init(
        tableID: String,
        name: String,
        seatCount: Int,
        smallBlind: Int,
        bigBlind: Int,
        minBuyIn: Int,
        maxBuyIn: Int,
        isPrivate: Bool,
        people: Int,
        bots: Int,
        freeSeats: Int,
        botSeats: Int,
        holds: Int,
        waitlist: Int,
        handNo: Int,
        seated: Bool,
        hold: SeatHold? = nil,
        waitlistPosition: Int? = nil,
        blocked: Bool
    ) {
        self.tableID = tableID
        self.name = name
        self.seatCount = seatCount
        self.smallBlind = smallBlind
        self.bigBlind = bigBlind
        self.minBuyIn = minBuyIn
        self.maxBuyIn = maxBuyIn
        self.isPrivate = isPrivate
        self.people = people
        self.bots = bots
        self.freeSeats = freeSeats
        self.botSeats = botSeats
        self.holds = holds
        self.waitlist = waitlist
        self.handNo = handNo
        self.seated = seated
        self.hold = hold
        self.waitlistPosition = waitlistPosition
        self.blocked = blocked
    }

    enum CodingKeys: String, CodingKey {
        case tableID = "table_id"
        case name
        case seatCount = "seat_count"
        case smallBlind = "small_blind"
        case bigBlind = "big_blind"
        case minBuyIn = "min_buy_in"
        case maxBuyIn = "max_buy_in"
        case isPrivate = "private"
        case people
        case bots
        case freeSeats = "free_seats"
        case botSeats = "bot_seats"
        case holds
        case waitlist
        case handNo = "hand_no"
        case seated
        case hold
        case waitlistPosition = "waitlist_position"
        case blocked
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        name = try container.decode(String.self, forKey: .name)
        seatCount = try container.decode(Int.self, forKey: .seatCount)
        smallBlind = try container.decode(Int.self, forKey: .smallBlind)
        bigBlind = try container.decode(Int.self, forKey: .bigBlind)
        minBuyIn = try container.decode(Int.self, forKey: .minBuyIn)
        maxBuyIn = try container.decode(Int.self, forKey: .maxBuyIn)
        isPrivate = try container.decode(Bool.self, forKey: .isPrivate)
        people = try container.decode(Int.self, forKey: .people)
        bots = try container.decode(Int.self, forKey: .bots)
        freeSeats = try container.decode(Int.self, forKey: .freeSeats)
        botSeats = try container.decode(Int.self, forKey: .botSeats)
        holds = try container.decode(Int.self, forKey: .holds)
        waitlist = try container.decode(Int.self, forKey: .waitlist)
        handNo = try container.decode(Int.self, forKey: .handNo)
        seated = try container.decode(Bool.self, forKey: .seated)
        hold = try container.decodeIfPresent(SeatHold.self, forKey: .hold)
        waitlistPosition = try container.decodeIfPresent(Int.self, forKey: .waitlistPosition)
        blocked = try container.decode(Bool.self, forKey: .blocked)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(name, forKey: .name)
        try container.encode(seatCount, forKey: .seatCount)
        try container.encode(smallBlind, forKey: .smallBlind)
        try container.encode(bigBlind, forKey: .bigBlind)
        try container.encode(minBuyIn, forKey: .minBuyIn)
        try container.encode(maxBuyIn, forKey: .maxBuyIn)
        try container.encode(isPrivate, forKey: .isPrivate)
        try container.encode(people, forKey: .people)
        try container.encode(bots, forKey: .bots)
        try container.encode(freeSeats, forKey: .freeSeats)
        try container.encode(botSeats, forKey: .botSeats)
        try container.encode(holds, forKey: .holds)
        try container.encode(waitlist, forKey: .waitlist)
        try container.encode(handNo, forKey: .handNo)
        try container.encode(seated, forKey: .seated)
        if let hold { try container.encode(hold, forKey: .hold) } else { try container.encodeNil(forKey: .hold) }
        if let waitlistPosition { try container.encode(waitlistPosition, forKey: .waitlistPosition) } else { try container.encodeNil(forKey: .waitlistPosition) }
        try container.encode(blocked, forKey: .blocked)
    }
}

/// Everything one player may see at a table.
public struct TableView: Codable, Sendable, Hashable {
    public var tableID: String
    public var name: String
    /// The seq of the last event at the table.
    public var seq: Int
    /// The server's clock when the view was made, for the timers.
    public var serverTime: Double
    public var settings: TableSettings
    /// One entry per seat; null for an empty seat.
    public var seats: [SeatInfo?]
    public var hand: HandInfo?
    public var turn: Turn?
    public var you: You
    public var isPrivate: Bool
    /// A private table's invite code, for its people to share.
    public var invite: String?
    public var holds: [SeatHold]
    /// Players waiting for a seat.
    public var waitlist: Int
    /// A practice table (P6.0b): its chips are not from the wallet, and a player who runs out gets a fresh practice stack with a `rebuy` message.
    public var practice: Bool?

    public init(
        tableID: String,
        name: String,
        seq: Int,
        serverTime: Double,
        settings: TableSettings,
        seats: [SeatInfo?],
        hand: HandInfo? = nil,
        turn: Turn? = nil,
        you: You,
        isPrivate: Bool,
        invite: String? = nil,
        holds: [SeatHold],
        waitlist: Int,
        practice: Bool? = nil
    ) {
        self.tableID = tableID
        self.name = name
        self.seq = seq
        self.serverTime = serverTime
        self.settings = settings
        self.seats = seats
        self.hand = hand
        self.turn = turn
        self.you = you
        self.isPrivate = isPrivate
        self.invite = invite
        self.holds = holds
        self.waitlist = waitlist
        self.practice = practice
    }

    enum CodingKeys: String, CodingKey {
        case tableID = "table_id"
        case name
        case seq
        case serverTime = "server_time"
        case settings
        case seats
        case hand
        case turn
        case you
        case isPrivate = "private"
        case invite
        case holds
        case waitlist
        case practice
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        name = try container.decode(String.self, forKey: .name)
        seq = try container.decode(Int.self, forKey: .seq)
        serverTime = try container.decode(Double.self, forKey: .serverTime)
        settings = try container.decode(TableSettings.self, forKey: .settings)
        seats = try container.decode([SeatInfo?].self, forKey: .seats)
        hand = try container.decodeIfPresent(HandInfo.self, forKey: .hand)
        turn = try container.decodeIfPresent(Turn.self, forKey: .turn)
        you = try container.decode(You.self, forKey: .you)
        isPrivate = try container.decode(Bool.self, forKey: .isPrivate)
        invite = try container.decodeIfPresent(String.self, forKey: .invite)
        holds = try container.decode([SeatHold].self, forKey: .holds)
        waitlist = try container.decode(Int.self, forKey: .waitlist)
        practice = try container.decodeIfPresent(Bool.self, forKey: .practice)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(name, forKey: .name)
        try container.encode(seq, forKey: .seq)
        try container.encode(serverTime, forKey: .serverTime)
        try container.encode(settings, forKey: .settings)
        try container.encode(seats, forKey: .seats)
        if let hand { try container.encode(hand, forKey: .hand) } else { try container.encodeNil(forKey: .hand) }
        if let turn { try container.encode(turn, forKey: .turn) } else { try container.encodeNil(forKey: .turn) }
        try container.encode(you, forKey: .you)
        try container.encode(isPrivate, forKey: .isPrivate)
        if let invite { try container.encode(invite, forKey: .invite) } else { try container.encodeNil(forKey: .invite) }
        try container.encode(holds, forKey: .holds)
        try container.encode(waitlist, forKey: .waitlist)
        try container.encodeIfPresent(practice, forKey: .practice)
    }
}

/// The clock of the seat to act, in seconds since the epoch on the server.
public struct Turn: Codable, Sendable, Hashable {
    public var seat: Int
    /// The seq of this turn's event; an act must carry at least this.
    public var seq: Int
    public var started: Double
    /// When the action time runs out and the time bank starts.
    public var deadline: Double
    /// When the seat is timed out.
    public var final: Double

    public init(
        seat: Int,
        seq: Int,
        started: Double,
        deadline: Double,
        final: Double
    ) {
        self.seat = seat
        self.seq = seq
        self.started = started
        self.deadline = deadline
        self.final = final
    }

    enum CodingKeys: String, CodingKey {
        case seat
        case seq
        case started
        case deadline
        case final
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seat = try container.decode(Int.self, forKey: .seat)
        seq = try container.decode(Int.self, forKey: .seq)
        started = try container.decode(Double.self, forKey: .started)
        deadline = try container.decode(Double.self, forKey: .deadline)
        final = try container.decode(Double.self, forKey: .final)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seat, forKey: .seat)
        try container.encode(seq, forKey: .seq)
        try container.encode(started, forKey: .started)
        try container.encode(deadline, forKey: .deadline)
        try container.encode(final, forKey: .final)
    }
}

public struct Uncalled: Codable, Sendable, Hashable {
    public var seat: Int
    public var amount: Int

    public init(
        seat: Int,
        amount: Int
    ) {
        self.seat = seat
        self.amount = amount
    }

    enum CodingKeys: String, CodingKey {
        case seat
        case amount
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seat = try container.decode(Int.self, forKey: .seat)
        amount = try container.decode(Int.self, forKey: .amount)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(seat, forKey: .seat)
        try container.encode(amount, forKey: .amount)
    }
}

/// `POST /api/tables/{table_id}/waitlist`: wait for a seat at a full table.
public struct WaitlistRequest: Codable, Sendable, Hashable {
    /// Needed for a private table.
    public var invite: String?
    /// The optional fields written as an explicit null when they are nil, rather than
    /// left out: those that came as null, and those a request means as null.
    public var nulls: Set<Null> = []

    /// An optional field that may be written as null.
    public enum Null: Sendable, Hashable {
        case invite
    }

    public init(
        invite: String? = nil,
        nulls: Set<Null> = []
    ) {
        self.invite = invite
        self.nulls = nulls
    }

    enum CodingKeys: String, CodingKey {
        case invite
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        invite = try container.decodeIfPresent(String.self, forKey: .invite)
        if container.contains(.invite), try container.decodeNil(forKey: .invite) { nulls.insert(.invite) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let invite { try container.encode(invite, forKey: .invite) } else if nulls.contains(.invite) { try container.encodeNil(forKey: .invite) }
    }
}

public struct WaitlistResponse: Codable, Sendable, Hashable {
    public var tableID: String
    /// The player's place in line, from 1.
    public var position: Int

    public init(
        tableID: String,
        position: Int
    ) {
        self.tableID = tableID
        self.position = position
    }

    enum CodingKeys: String, CodingKey {
        case tableID = "table_id"
        case position
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tableID = try container.decode(String.self, forKey: .tableID)
        position = try container.decode(Int.self, forKey: .position)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(tableID, forKey: .tableID)
        try container.encode(position, forKey: .position)
    }
}

/// `GET /api/wallet` with the session cookie: the balance and the newest entries first.
public struct WalletResponse: Codable, Sendable, Hashable {
    public var balance: Int
    /// The play-money statement (D-1), to show with the chips.
    public var notice: String
    public var entries: [LedgerItem]

    public init(
        balance: Int,
        notice: String,
        entries: [LedgerItem]
    ) {
        self.balance = balance
        self.notice = notice
        self.entries = entries
    }

    enum CodingKeys: String, CodingKey {
        case balance
        case notice
        case entries
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        balance = try container.decode(Int.self, forKey: .balance)
        notice = try container.decode(String.self, forKey: .notice)
        entries = try container.decode([LedgerItem].self, forKey: .entries)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(balance, forKey: .balance)
        try container.encode(notice, forKey: .notice)
        try container.encode(entries, forKey: .entries)
    }
}

public struct WelcomeMessage: Codable, Sendable, Hashable {
    public static let type = "welcome"

    public var protocolVersion: Int
    public var playerID: String
    public var name: String

    public init(
        protocolVersion: Int,
        playerID: String,
        name: String
    ) {
        self.protocolVersion = protocolVersion
        self.playerID = playerID
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
        case playerID = "player_id"
        case name
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
        playerID = try container.decode(String.self, forKey: .playerID)
        name = try container.decode(String.self, forKey: .name)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.type, forKey: .type)
        try container.encode(protocolVersion, forKey: .protocolVersion)
        try container.encode(playerID, forKey: .playerID)
        try container.encode(name, forKey: .name)
    }
}

public struct You: Codable, Sendable, Hashable {
    public var playerID: String
    /// The viewer's seat, or null when not seated.
    public var seat: Int?
    /// The seat held for the viewer, if any.
    public var hold: SeatHold?
    /// The viewer's place on the waitlist, from 1.
    public var waitlistPosition: Int?
    /// Set when it is the viewer's turn.
    public var legal: Legal?
    public var timeBank: Double?
    public var pendingRebuy: Int
    public var sittingOut: Bool
    public var sittingOutNext: Bool

    public init(
        playerID: String,
        seat: Int? = nil,
        hold: SeatHold? = nil,
        waitlistPosition: Int? = nil,
        legal: Legal? = nil,
        timeBank: Double? = nil,
        pendingRebuy: Int,
        sittingOut: Bool,
        sittingOutNext: Bool
    ) {
        self.playerID = playerID
        self.seat = seat
        self.hold = hold
        self.waitlistPosition = waitlistPosition
        self.legal = legal
        self.timeBank = timeBank
        self.pendingRebuy = pendingRebuy
        self.sittingOut = sittingOut
        self.sittingOutNext = sittingOutNext
    }

    enum CodingKeys: String, CodingKey {
        case playerID = "player_id"
        case seat
        case hold
        case waitlistPosition = "waitlist_position"
        case legal
        case timeBank = "time_bank"
        case pendingRebuy = "pending_rebuy"
        case sittingOut = "sitting_out"
        case sittingOutNext = "sitting_out_next"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        playerID = try container.decode(String.self, forKey: .playerID)
        seat = try container.decodeIfPresent(Int.self, forKey: .seat)
        hold = try container.decodeIfPresent(SeatHold.self, forKey: .hold)
        waitlistPosition = try container.decodeIfPresent(Int.self, forKey: .waitlistPosition)
        legal = try container.decodeIfPresent(Legal.self, forKey: .legal)
        timeBank = try container.decodeIfPresent(Double.self, forKey: .timeBank)
        pendingRebuy = try container.decode(Int.self, forKey: .pendingRebuy)
        sittingOut = try container.decode(Bool.self, forKey: .sittingOut)
        sittingOutNext = try container.decode(Bool.self, forKey: .sittingOutNext)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(playerID, forKey: .playerID)
        if let seat { try container.encode(seat, forKey: .seat) } else { try container.encodeNil(forKey: .seat) }
        if let hold { try container.encode(hold, forKey: .hold) } else { try container.encodeNil(forKey: .hold) }
        if let waitlistPosition { try container.encode(waitlistPosition, forKey: .waitlistPosition) } else { try container.encodeNil(forKey: .waitlistPosition) }
        if let legal { try container.encode(legal, forKey: .legal) } else { try container.encodeNil(forKey: .legal) }
        if let timeBank { try container.encode(timeBank, forKey: .timeBank) } else { try container.encodeNil(forKey: .timeBank) }
        try container.encode(pendingRebuy, forKey: .pendingRebuy)
        try container.encode(sittingOut, forKey: .sittingOut)
        try container.encode(sittingOutNext, forKey: .sittingOutNext)
    }
}
