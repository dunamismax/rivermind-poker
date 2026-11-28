import Foundation
import Testing
@testable import RiverMindKit

/// A config as the server sends it, with the trained bots' table sizes.
private let configJSON = """
    {"protocol":2,"seat_counts":[2,3,4,5,6,7,8,9],
     "stakes":[{"small_blind":1,"big_blind":2},{"small_blind":50,"big_blind":100},{"small_blind":500,"big_blind":1000}],
     "reactions":[],"practice_stack":10000,"oldest_app_build":1,
     "bots":[{"kind":"random","label":"Random bot"},{"kind":"heuristic","label":"RiverMind Easy"},
             {"kind":"hard","label":"RiverMind Hard","seats":[2,3,4,5,6]}]}
    """

private func offeredConfig() throws -> ConfigResponse {
    try JSONDecoder().decode(ConfigResponse.self, from: Data(configJSON.utf8))
}

private let session = #"{"player_id":"p1","name":"Keen Marten 47","created":true,"balance":20000}"#

private func summary(_ id: String, free: Int = 1, bots: Int = 0, botSeats: Int = 0, people: Int = 1) -> String {
    """
    {"table_id":"\(id)","name":"Table","seat_count":6,"small_blind":50,"big_blind":100,"min_buy_in":4000,
     "max_buy_in":10000,"private":false,"people":\(people),"bots":\(bots),"free_seats":\(free),"bot_seats":\(botSeats),
     "holds":0,"waitlist":0,"hand_no":3,"seated":false,"hold":null,"waitlist_position":null,"blocked":false}
    """
}

@MainActor
private func followed(_ client: APIClient) -> (TableConnection, Sockets) {
    let sockets = Sockets()
    let table = TableConnection(
        client: client,
        makeSocket: { request in
            let socket = FakeSocket(request: request)
            sockets.add(socket)
            return socket
        }, memory: MemoryTableMemory(), schedule: ManualScheduler().scheduler)
    return (table, sockets)
}

private func body(_ request: URLRequest) -> [String: Any] {
    guard let data = request.httpBody else { return [:] }
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
}

@Suite struct NewTableFormTests {
    @Test func keepsTheChoicesToWhatIsOfferedAndCovered() throws {
        let config = try offeredConfig()
        var form = NewTableForm().normalized(config: config, balance: 20_000)
        #expect(form.seats == 6 && form.bots == "heuristic" && form.bigBlind == 100 && form.buyInBlinds == 100)

        // Hard plays at most six seats: at nine it gives way to RiverMind Easy.
        form.bots = "hard"
        form.seats = 9
        form = form.normalized(config: config, balance: 20_000)
        #expect(form.bots == "heuristic")
        form.bots = NewTableForm.noBots
        #expect(form.normalized(config: config, balance: 20_000).bots == NewTableForm.noBots)

        // The largest buy-in the wallet covers, and none at all when it covers none.
        form.bigBlind = 1000
        #expect(form.affordable(balance: 75_000) == [40, 70])
        #expect(form.normalized(config: config, balance: 75_000).buyInBlinds == 70)
        #expect(form.affordable(balance: 1_000).isEmpty)
        #expect(form.normalized(config: config, balance: 1_000).buyInBlinds == 100)
        #expect(form.affordable(balance: nil) == [40, 70, 100])
    }

    @Test func noBotsIsAnExplicitNull() throws {
        var form = NewTableForm()
        form.bots = NewTableForm.noBots
        form.isPrivate = true
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(form.request)) as! [String: Any]
        #expect(sent["bots"] is NSNull)
        #expect(sent["private"] as? Bool == true && sent["buy_in"] as? Int == 10_000 && sent["seats"] as? Int == 6)
        form.bots = "random"
        let withBots = try JSONSerialization.jsonObject(with: JSONEncoder().encode(form.request)) as! [String: Any]
        #expect(withBots["bots"] as? String == "random")
    }
}

@MainActor
@Suite struct LobbyRequestTests {
    @Test func loadsTheGuestAndTheirChips() async throws {
        let server = FakeServer(["GET /api/config": (200, configJSON), "POST /api/session": (200, session)])
        let model = LobbyModel(client: APIClient(server: local, transport: server.transport))
        await model.load()
        guard case let .ready(_, guest) = model.state else { Issue.record("\(model.state)"); return }
        #expect(guest.name == "Keen Marten 47" && model.balance == 20_000)
    }

    @Test func quickSeatFollowsTheTableItFound() async throws {
        let server = FakeServer([
            "POST /api/quick-seat": (200, #"{"table_id":"t9","seat":2,"seated":true,"hold":null}"#),
            "GET /api/tables": (200, #"{"tables":[]}"#),
            "GET /api/wallet": (200, #"{"balance":10000,"notice":"Play money only.","entries":[]}"#),
        ])
        let client = APIClient(server: local, transport: server.transport)
        let model = LobbyModel(client: client)
        let (table, sockets) = followed(client)
        model.filters = TableFilters(seats: 2, bigBlind: 100)
        await model.quickSeat(on: table)
        #expect(model.error == nil && model.busy == nil)
        #expect(table.tableID == "t9" && sockets.all.count == 1)
        let quick = try #require(server.requests.first { $0.url!.path() == "/api/quick-seat" })
        let sent = body(quick)
        #expect(sent["seats"] as? Int == 2 && sent["big_blind"] as? Int == 100)
    }

    @Test func aRefusalIsShownInWordsAndTheTableIsNotFollowed() async throws {
        let server = FakeServer([
            "POST /api/tables/t1/seat": (409, #"{"detail":"You need at least 4,000 play chips to sit here."}"#),
            "GET /api/tables": (200, "{\"tables\":[\(summary("t1"))]}"),
        ])
        let client = APIClient(server: local, transport: server.transport)
        let model = LobbyModel(client: client)
        let (table, _) = followed(client)
        await model.refreshTables()
        let listed = try #require(model.tables?.first)
        #expect(LobbyWords.choice(listed, balance: 20_000) == .sit(afford: true))
        await model.takeSeat(at: listed.tableID, on: table)
        #expect(model.error == "You need at least 4,000 play chips to sit here.")
        #expect(table.tableID == nil)
    }

    @Test func aFullInvitedTableIsJoinedByTheWaitlist() async throws {
        let full = summary("t5", free: 0, people: 6)
        var waiting = full
        waiting = waiting.replacingOccurrences(of: #""waitlist_position":null"#, with: #""waitlist_position":1"#)
        let server = FakeServer([
            "GET /api/invites/abc": [
                .init(body: Data(full.utf8)), .init(body: Data(waiting.utf8)),
            ],
            "POST /api/tables/t5/waitlist": [.init(body: Data(#"{"table_id":"t5","position":1}"#.utf8))],
            "GET /api/tables": [.init(body: Data(#"{"tables":[]}"#.utf8))],
        ])
        let client = APIClient(server: local, transport: server.transport)
        let model = LobbyModel(client: client)
        let (table, _) = followed(client)
        #expect(LobbyWords.inviteCode(in: "https://rivermindpoker.com/?invite=abc") == "abc")
        await model.openInvite("abc")
        #expect(model.invite?.table?.tableID == "t5")
        await model.acceptInvite(on: table)
        #expect(model.invite?.table?.waitlistPosition == 1)
        #expect(table.tableID == nil)
        let join = try #require(server.requests.first { $0.url!.path() == "/api/tables/t5/waitlist" })
        #expect(body(join)["invite"] as? String == "abc")
    }

    @Test func readsAnInviteFromWhatWasPasted() {
        #expect(LobbyWords.inviteCode(in: " https://rivermindpoker.com/?invite=Ab3-x_9\n") == "Ab3-x_9")
        #expect(LobbyWords.inviteCode(in: "rivermindpoker.com/?invite=Ab3") == "Ab3")
        #expect(LobbyWords.inviteCode(in: "Ab3-x_9") == "Ab3-x_9")
        #expect(LobbyWords.inviteCode(in: "https://rivermindpoker.com/") == nil)
        #expect(LobbyWords.inviteCode(in: "two words") == nil)
        #expect(LobbyWords.inviteCode(in: "  ") == nil)
    }
}

/// The lobby against a real server when `RIVERMIND_SERVER` names one (`ios/test.sh`).
@MainActor
@Suite(.enabled(if: Server.from(environment: ProcessInfo.processInfo.environment) != nil,
                "RIVERMIND_SERVER names no server"))
struct LobbyModelLocalServerTests {
    let server = Server.from(environment: ProcessInfo.processInfo.environment)!

    /// A full table: two other guests at a two-seat table with no bots, at blinds no other
    /// test quick-seats at, so a parallel test cannot take its second seat.
    private func fullTable() async throws -> String {
        let first = APIClient(server: server)
        _ = try await first.startSession()
        let made = try await first.newTable(NewTableRequest(seats: 2, bigBlind: 200, nulls: [.bots]))
        let second = APIClient(server: server)
        _ = try await second.startSession()
        let seat = try await second.takeSeat(table: made.tableID)
        #expect(seat.seated)
        return made.tableID
    }

    @Test func listsAFullTableAndWaitsForASeat() async throws {
        let id = try await fullTable()
        let client = APIClient(server: server)
        let model = LobbyModel(client: client)
        await model.load()
        model.filters = TableFilters(seats: 2, bigBlind: 200)
        await model.refreshTables()
        let listed = try #require(model.tables?.first { $0.tableID == id })
        #expect(LobbyWords.choice(listed, balance: model.balance) == .waitlist(afford: true))
        #expect(LobbyWords.seatsText(listed) == "2 people")

        #expect(await model.joinWaitlist(at: listed.tableID) == 1)
        let waiting = try #require(model.tables?.first { $0.tableID == id })
        #expect(LobbyWords.choice(waiting, balance: model.balance) == .waiting(note: "Number 1 in line"))
        await model.leaveWaitlist(at: waiting.tableID)
        let left = try #require(model.tables?.first { $0.tableID == id })
        #expect(left.waitlistPosition == nil && model.error == nil)
    }

    @Test func startsATableWithTheFormsChoicesAndAPrivateOnesInvite() async throws {
        let client = APIClient(server: server)
        let model = LobbyModel(client: client)
        await model.load()
        guard case let .ready(config, _) = model.state else { Issue.record("\(model.state)"); return }
        let table = TableConnection(client: client)
        model.form.seats = 3
        model.form.bots = "random"
        model.form.bigBlind = 50
        model.form.isPrivate = true
        await model.newTable(config, on: table)
        #expect(model.error == nil)
        let id = try #require(table.tableID)
        defer { table.leave() }
        for _ in 0..<100 where table.view == nil { try await Task.sleep(for: .milliseconds(100)) }
        let view = try #require(table.view)
        #expect(view.tableID == id && view.isPrivate && view.invite != nil && view.settings.seatCount == 3)
        #expect(view.you.seat == 0 && view.seats.compactMap { $0 }.filter { $0.bot == "random" }.count == 2)
        #expect(model.balance == 20_000 - 100 * 50)
    }
}
