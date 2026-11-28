// What the table screen does beside the socket (P5D.7), as the page's NlTable.svelte
// and NlConnection do it: the bet sizing of the action panel, the seat menu's mute,
// block and report, holding an empty seat, and changing the practice opponent. The
// table itself is the connection's newest view; TableWords says what to show of it.

import Foundation
import Observation

/// The action panel's amount, a port of ActionPanel.svelte's state: it starts at the
/// minimum for each new turn, a preset sets it and is lit while the amount is still its
/// size, and the slider and the field move it inside the legal range.
public struct ActionSizing: Sendable, Hashable {
    /// The amount as the guest left it, before it is kept in the legal range.
    public private(set) var amount: Double = 0
    /// The preset last picked, for as long as the amount is still its size.
    public private(set) var picked: String?
    private var turn: Int?

    public init() {}

    /// Starts each new turn (`turnSeq`) at the minimum.
    public mutating func follow(turnSeq: Int, legal: Legal) {
        guard turn != turnSeq else { return }
        turn = turnSeq
        amount = Double(legal.minTo)
        picked = nil
    }

    public mutating func pick(_ preset: BetPreset) {
        amount = Double(preset.amount)
        picked = preset.label
    }

    /// The slider or the field.
    public mutating func set(_ value: Double) {
        amount = value
    }

    /// The street total the raise button sends.
    public func target(_ legal: Legal) -> Int { Bet.clamp(amount, legal) }

    /// The one preset lit: the one picked when it is still the amount, or else the first
    /// whose size the amount is (two can come to the same amount).
    public func lit(_ presets: [BetPreset], _ legal: Legal) -> String? {
        let target = target(legal)
        return (presets.first { $0.label == picked && $0.amount == target } ?? presets.first { $0.amount == target })?
            .label
    }

    /// The preset buttons' short faces; their spoken names stay in full.
    public static func face(_ label: String) -> String {
        ["½ pot": "1/2", "¾ pot": "3/4"][label] ?? label
    }

    /// Whether the panel offers a bet or raise, and the sizing controls with it.
    public static func canRaise(_ legal: Legal) -> Bool {
        legal.raiseKind != nil && legal.maxTo >= legal.minTo
    }

    public static func hasSizing(_ legal: Legal) -> Bool {
        canRaise(legal) && legal.maxTo > legal.minTo
    }
}

@MainActor
@Observable
public final class TableModel {
    public let connection: TableConnection
    private let client: APIClient
    /// A finished hand of this table, opened without leaving the seat (P5D.8).
    public let review: HandReview

    /// Who the guest muted or blocked, by public reference.
    public private(set) var relations: [RelationItem] = []
    /// A request from the table is under way (the seat menu, holding a seat, the opponent).
    public private(set) var busy = false
    /// The bots a practice table may switch to: RiverMind Easy and the trained bots for two seats.
    public private(set) var opponents: [BotOption] = []
    /// The kind asked for that has not sat down yet.
    public private(set) var asked: String?
    /// What the last report came to.
    public private(set) var reported: String?

    public init(connection: TableConnection, client: APIClient) {
        self.connection = connection
        self.client = client
        review = HandReview(client: client)
    }

    /// Opens a finished hand of this table for review: hand `handNo`, or the guest's newest here.
    public func openReview(handNo: Int?) async {
        guard let tableID = connection.tableID else { return }
        await review.open(table: tableID, handNo: handNo, on: connection)
    }

    /// Reads the guest's mutes and blocks, and the practice opponents the server offers.
    public func load(config: ConfigResponse?) async {
        if let read = try? await client.relations() { relations = read.players }
        if let config {
            opponents = config.bots.filter { $0.kind == "heuristic" || ($0.champion != nil && $0.plays(seats: 2)) }
        }
    }

    public func relationOf(_ ref: String?) -> RelationKind? {
        guard let ref else { return nil }
        return relations.first { $0.ref == ref }?.kind
    }

    /// The seat menu's Mute and Block: on, or off again when it is already on.
    public func toggle(_ kind: RelationKind, seat: Int) async {
        guard let tableID = connection.tableID, let info = seatInfo(seat), let ref = info.ref else { return }
        await run {
            if self.relationOf(ref) == kind {
                self.relations = try await self.client.removeRelation(ref: ref).players
            } else {
                self.relations = try await self.client.setRelation(
                    RelationRequest(tableID: tableID, seat: seat, kind: kind)
                ).players
                // Muting hides their reactions, the one showing now included.
                self.connection.clearReaction(seat: seat)
            }
        }
    }

    /// Reports the person in `seat` for review.
    public func report(seat: Int, reason: ReportReason) async {
        guard let tableID = connection.tableID else { return }
        reported = nil
        await run {
            let answer = try await self.client.report(ReportRequest(tableID: tableID, seat: seat, reason: reason))
            self.reported = Self.reportText(recorded: answer.recorded)
        }
    }

    /// The menu was opened again: its last report's note goes.
    public func forgetReport() { reported = nil }

    /// What the page says after a report.
    public nonisolated static func reportText(recorded: Bool) -> String {
        recorded ? "Thanks: the report was sent for review." : "You already reported this today; it counts once."
    }

    /// “Sit here”: holds an empty seat, to buy in with `sit`.
    public func holdSeat(_ seat: Int) async {
        guard let tableID = connection.tableID else { return }
        await run { _ = try await self.client.takeSeat(table: tableID, SeatRequest(seat: seat, holdOnly: true)) }
    }

    /// Gives up the seat held at this table.
    public func giveUpHold() async {
        guard let tableID = connection.tableID else { return }
        await run { try await self.client.giveUpSeat(table: tableID) }
    }

    /// The bot playing the guest at a practice table.
    public var opponent: String? {
        connection.view?.seats.first { $0?.kind == .bot }??.bot
    }

    /// The bot asked for, until it sits down.
    public var arriving: BotOption? {
        guard let asked, asked != opponent else { return nil }
        return opponents.first { $0.kind == asked }
    }

    /// Changes the practice opponent; the new bot sits down once the hand under way ends.
    public func playAgainst(_ kind: String) async {
        await run {
            let started = try await self.client.practice(PracticeRequest(bot: kind))
            self.asked = started.nextBot
            if self.connection.tableID != started.tableID { self.connection.follow(started.tableID) }
        } failed: { error in
            self.asked = nil
            self.connection.notify("Could not change the opponent: \(error.localizedDescription)")
        }
    }

    private func seatInfo(_ seat: Int) -> SeatInfo? {
        guard let view = connection.view, seat >= 0, seat < view.seats.count else { return nil }
        return view.seats[seat]
    }

    private func run(
        _ work: @escaping @MainActor () async throws -> Void,
        failed: (@MainActor (Error) -> Void)? = nil
    ) async {
        busy = true
        defer { busy = false }
        do {
            try await work()
        } catch {
            if let failed { failed(error) } else { connection.notify(error.localizedDescription) }
        }
    }
}
