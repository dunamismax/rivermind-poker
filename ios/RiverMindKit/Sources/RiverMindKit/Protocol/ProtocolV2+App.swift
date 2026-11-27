import Foundation

// What the app adds to protocol v2's generated types (ProtocolV2.swift), by hand.

extension BotOption: Identifiable {
    public var id: String { kind }

    /// Whether this bot plays a table of `seats` seats.
    public func plays(seats count: Int) -> Bool {
        seats?.contains(count) ?? true
    }
}

extension ReactionOption: Identifiable {
    public var id: String { kind.rawValue }
}

extension HelloMessage {
    /// The first message on every table socket.
    public static let first = HelloMessage()
}
