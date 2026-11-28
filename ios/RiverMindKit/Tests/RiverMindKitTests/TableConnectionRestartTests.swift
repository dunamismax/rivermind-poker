import Foundation
import Testing
@testable import RiverMindKit

/// The site on PostgreSQL that `ios/test.sh` starts with web/e2e/restart-server.ts when
/// `RIVERMIND_TEST_DATABASE_URL` is set, and its control port's `/restart`.
let restartServer: Server? = ProcessInfo.processInfo.environment["RIVERMIND_RESTART_SERVER"].flatMap(Server.init(origin:))
let restartControl: URL? = ProcessInfo.processInfo.environment["RIVERMIND_RESTART_CONTROL"].flatMap(URL.init(string:))

/// The server is killed mid-hand, as a crash would, and started again on the same
/// database: the app's connection rejoins by itself, finds the hand where it was, and
/// plays on (P5D.3).
@MainActor
@Suite(.enabled(if: restartServer != nil && restartControl != nil, "needs RIVERMIND_RESTART_SERVER, as ios/test.sh sets it with a test database"))
struct TableConnectionRestartTests {
    @Test func rejoinsTheHandInProgressAfterTheServerRestarts() async throws {
        let client = APIClient(server: restartServer!)
        _ = try await client.startSession()
        let practice = try await client.practice()
        let connection = TableConnection(client: client)
        connection.follow(practice.tableID)
        await eventually(30) { connection.view?.you.legal != nil }
        let before = try #require(connection.view)
        let hand = try #require(before.hand)
        let seat = try #require(before.you.seat)

        var request = URLRequest(url: restartControl!.appending(path: "restart"))
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        let restart = Task.detached { try await URLSession.shared.data(for: request) }
        await eventually(30) { connection.status == .closed }
        let (_, response) = try await restart.value
        #expect((response as? HTTPURLResponse)?.statusCode == 204)

        // Rejoined by itself, with the hand in progress intact and the guest still to act.
        await eventually(30) { connection.status == .open && connection.view?.you.legal != nil }
        let after = try #require(connection.view)
        #expect(after.hand?.handNo == hand.handNo)
        #expect(after.hand?.board == hand.board)
        #expect(after.hand?.pot == hand.pot)
        #expect(after.seats[seat]?.cards == before.seats[seat]?.cards)
        #expect(after.seats[seat]?.connected == true)
        #expect(after.you.legal == before.you.legal)

        // And the hand plays on from there.
        let legal = try #require(after.you.legal)
        #expect(connection.act(legal.canCheck ? .check : .call))
        await eventually(30) { (connection.view?.seq ?? 0) > after.seq && !connection.pending }
        connection.leave()
    }
}
