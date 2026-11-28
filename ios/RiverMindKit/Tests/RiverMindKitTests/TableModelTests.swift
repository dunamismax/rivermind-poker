import Foundation
import Testing
@testable import RiverMindKit

/// The action panel's amount, as ActionPanel.svelte keeps it (P5D.7).
@Suite struct ActionSizingTests {
    let legal = Legal(
        canFold: true, canCheck: false, call: 100, raiseKind: .raise, minTo: 400, maxTo: 5000)
    let presets = [
        BetPreset(label: "Min", amount: 400),
        BetPreset(label: "½ pot", amount: 400),
        BetPreset(label: "¾ pot", amount: 512),
        BetPreset(label: "Pot", amount: 650),
        BetPreset(label: "All-in", amount: 5000),
    ]

    @Test func eachTurnStartsAtTheMinimum() {
        var sizing = ActionSizing()
        sizing.follow(turnSeq: 7, legal: legal)
        #expect(sizing.target(legal) == 400)
        sizing.pick(presets[3])
        #expect(sizing.target(legal) == 650)
        // The same turn keeps the amount; the next starts again.
        sizing.follow(turnSeq: 7, legal: legal)
        #expect(sizing.target(legal) == 650)
        sizing.follow(turnSeq: 9, legal: legal)
        #expect(sizing.target(legal) == 400 && sizing.picked == nil)
    }

    @Test func oneSizeIsLitAtATime() {
        var sizing = ActionSizing()
        sizing.follow(turnSeq: 1, legal: legal)
        // Min and ½ pot come to the same amount: the first is lit until the other is picked.
        #expect(sizing.lit(presets, legal) == "Min")
        sizing.pick(presets[1])
        #expect(sizing.lit(presets, legal) == "½ pot")
        // Moved off every size, none is lit; back on one by the slider, that one is.
        sizing.set(513)
        #expect(sizing.lit(presets, legal) == nil)
        sizing.set(650.4)
        #expect(sizing.lit(presets, legal) == "Pot")
    }

    @Test func theAmountStaysInTheLegalRange() {
        var sizing = ActionSizing()
        sizing.set(12)
        #expect(sizing.target(legal) == 400)
        sizing.set(1_000_000)
        #expect(sizing.target(legal) == 5000)
        sizing.set(.nan)
        #expect(sizing.target(legal) == 400)
    }

    @Test func theFacesAndWhatThePanelOffers() {
        #expect(ActionSizing.face("½ pot") == "1/2" && ActionSizing.face("¾ pot") == "3/4")
        #expect(ActionSizing.face("Pot") == "Pot")
        #expect(ActionSizing.canRaise(legal) && ActionSizing.hasSizing(legal))
        var allIn = legal
        allIn.minTo = 5000
        #expect(ActionSizing.canRaise(allIn) && !ActionSizing.hasSizing(allIn))
        var call = legal
        call.raiseKind = nil
        #expect(!ActionSizing.canRaise(call) && !ActionSizing.hasSizing(call))
        #expect(TableModel.reportText(recorded: true) == "Thanks: the report was sent for review.")
        #expect(TableModel.reportText(recorded: false) == "You already reported this today; it counts once.")
    }
}

/// The table's requests beside the socket, against the local server `ios/test.sh` starts.
@Suite(.enabled(if: Server.from(environment: ProcessInfo.processInfo.environment) != nil))
@MainActor
struct TableModelLocalServerTests {
    let server = Server.from(environment: ProcessInfo.processInfo.environment)!

    /// Waits up to ten seconds for `ready`.
    private func until(_ ready: () -> Bool) async {
        let deadline = Date().addingTimeInterval(10)
        while !ready() && Date() < deadline { try? await Task.sleep(for: .milliseconds(50)) }
    }

    @Test func mutesBlocksReportsAndHoldsASeat() async throws {
        // Another guest at a three-seat table with no bots.
        let other = APIClient(server: server)
        _ = try await other.startSession()
        let made = try await other.newTable(NewTableRequest(seats: 3, bigBlind: 50, nulls: [.bots]))

        let client = APIClient(server: server)
        _ = try await client.startSession()
        let connection = TableConnection(client: client)
        connection.follow(made.tableID)
        await until { connection.view != nil }
        let model = TableModel(connection: connection, client: client)
        await model.load(config: try await client.config())
        #expect(model.relations.isEmpty)
        let view = try #require(connection.view)
        let seat = try #require(view.seats.firstIndex { $0?.kind == .human })
        let ref = try #require(view.seats[seat]?.ref)

        await model.toggle(.mute, seat: seat)
        #expect(model.relationOf(ref) == .mute)
        await model.toggle(.block, seat: seat)
        #expect(model.relationOf(ref) == .block)
        await model.toggle(.block, seat: seat)
        #expect(model.relationOf(ref) == nil)

        await model.report(seat: seat, reason: .abuse)
        #expect(model.reported == TableModel.reportText(recorded: true))
        await model.report(seat: seat, reason: .abuse)
        #expect(model.reported == TableModel.reportText(recorded: false))

        // “Sit here”: the seat is held, to buy in with `sit`.
        let empty = try #require(view.seats.firstIndex { $0 == nil })
        await model.holdSeat(empty)
        await until { connection.view?.you.hold?.seat == empty }
        #expect(connection.view?.you.hold?.ready == true)
        #expect(TableWords.emptySeat(try #require(connection.view), empty) == .mine)
        #expect(connection.sit(seat: empty, buyIn: 2000))
        await until { connection.view?.you.seat == empty }
        // A hand may start at once and post a blind from the stack.
        let seated = try #require(connection.view)
        let me = try #require(TableWords.me(seated))
        #expect(me.stack + me.bet == 2000)
        #expect(TableWords.rebuyRoom(seated) == 5000 - me.stack)
        connection.leave()
    }

    @Test func offersThePracticeOpponents() async throws {
        let client = APIClient(server: server)
        _ = try await client.startSession()
        let connection = TableConnection(client: client)
        let model = TableModel(connection: connection, client: client)
        let config = try await client.config()
        await model.load(config: config)
        // RiverMind Easy always, and a trained bot only where the server has a champion.
        #expect(model.opponents.contains { $0.kind == "heuristic" })
        #expect(model.opponents.allSatisfy { $0.kind == "heuristic" || $0.champion != nil })
        #expect(model.opponents.count == config.bots.filter { $0.kind == "heuristic" || $0.champion != nil }.count)
    }
}
