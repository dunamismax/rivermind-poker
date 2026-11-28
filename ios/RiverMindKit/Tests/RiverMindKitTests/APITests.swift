import Foundation
import Synchronization
import Testing
@testable import RiverMindKit

/// A server in memory: it answers each `METHOD /path` with a reply, in order when a route
/// has several, and records every request it is given.
final class FakeServer: Sendable {
    struct Reply: Sendable {
        var status = 200
        var headers: [String: String] = [:]
        var body = Data("{}".utf8)
    }

    private let state: Mutex<(replies: [String: [Reply]], sent: [URLRequest])>

    init(_ replies: [String: [Reply]] = [:]) {
        state = Mutex((replies, []))
    }

    /// One reply for a route, as JSON text.
    convenience init(_ routes: [String: (Int, String)]) {
        self.init(routes.mapValues { [Reply(status: $0.0, body: Data($0.1.utf8))] })
    }

    var requests: [URLRequest] { state.withLock { $0.sent } }

    var transport: Transport {
        { [self] request in
            let key = "\(request.httpMethod ?? "GET") \(request.url!.path())"
            let reply = state.withLock { state in
                state.sent.append(request)
                guard var replies = state.replies[key], !replies.isEmpty else { return Reply(status: 404) }
                let first = replies.count > 1 ? replies.removeFirst() : replies[0]
                state.replies[key] = replies
                return first
            }
            var headers = reply.headers
            headers["content-type"] = "application/json"
            let response = HTTPURLResponse(
                url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers)!
            return (reply.body, response)
        }
    }
}

let local = Server(origin: "http://127.0.0.1:4380")!

@Suite struct ServerTests {
    @Test func liveIsTheSite() {
        #expect(Server.live.origin.absoluteString == "https://rivermindpoker.com")
        #expect(Server.live.url("/api/config").absoluteString == "https://rivermindpoker.com/api/config")
    }

    @Test(arguments: [
        ("http://127.0.0.1:4380", "http://127.0.0.1:4380"),
        ("https://rivermindpoker.com/", "https://rivermindpoker.com"),
        ("HTTP://localhost:8000", "http://localhost:8000"),
        (" http://[::1]:4380 ", "http://[::1]:4380"),
    ])
    func acceptsAnOrigin(text: String, origin: String) throws {
        #expect(try #require(Server(origin: text)).origin.absoluteString == origin)
    }

    @Test(arguments: [
        "", "127.0.0.1:4380", "ftp://example.com", "https://example.com/api", "https://example.com?x=1",
        "https://user:pass@example.com", "https://", "javascript:alert(1)",
    ])
    func refusesWhatIsNotAnOrigin(text: String) {
        #expect(Server(origin: text) == nil)
    }

    @Test func readsTheEnvironment() {
        #expect(Server.from(environment: ["RIVERMIND_SERVER": "http://127.0.0.1:4380"]) == local)
        #expect(Server.from(environment: ["RIVERMIND_SERVER": "not a url"]) == nil)
        #expect(Server.from(environment: [:]) == nil)
    }
}

let config = """
    {"protocol":2,"bots":[{"kind":"random","label":"Random bot"},{"kind":"heuristic","label":"RiverMind Easy"}],
     "seat_counts":[2,3,4,5,6,7,8,9],"stakes":[{"small_blind":50,"big_blind":100}],"reactions":[],"practice_stack":10000}
    """
let guest = #"{"player_id":"p_1","name":"Guest 1234","created":true,"balance":20000}"#
let cookie = "rm_session=abc.123; HttpOnly; Max-Age=15552000; Path=/; SameSite=lax"

extension URLRequest {
    var body: String? { httpBody.map { String(decoding: $0, as: UTF8.self) } }
    var cookie: String? { value(forHTTPHeaderField: "Cookie") }
}

@Suite struct APIClientTests {
    @Test func asksForTheConfigAsAPageDoes() async throws {
        let server = FakeServer(["GET /api/config": (200, config)])
        let config = try await APIClient(server: local, transport: server.transport).config()
        #expect(config.bots.count == 2)
        let request = try #require(server.requests.first)
        #expect(request.httpMethod == "GET")
        #expect(request.url?.absoluteString == "http://127.0.0.1:4380/api/config")
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        // A client that is not a browser sends no Origin, which the server accepts (`originAllowed`).
        #expect(request.value(forHTTPHeaderField: "Origin") == nil)
        #expect(request.cookie == nil && request.httpBody == nil)
    }

    @Test func keepsTheSessionTheServerGivesAndSendsItBack() async throws {
        let server = FakeServer([
            "POST /api/session": [FakeServer.Reply(headers: ["Set-Cookie": cookie], body: Data(guest.utf8))],
            "GET /api/wallet": [FakeServer.Reply(body: Data(#"{"balance":20000,"notice":"Play money only","entries":[]}"#.utf8))],
        ])
        let store = MemorySessionStore()
        let client = APIClient(server: local, session: store, transport: server.transport)
        let made = try await client.startSession()
        #expect(made.name == "Guest 1234" && made.created)
        #expect(store.load() == "abc.123")
        _ = try await client.wallet()
        #expect(server.requests.last?.cookie == "rm_session=abc.123")
        // A session request sends no body, as a page's first visit does.
        #expect(server.requests.first?.httpBody == nil)
        #expect(client.webSocketRequest("/ws").url?.absoluteString == "ws://127.0.0.1:4380/ws")
        #expect(client.webSocketRequest("/ws").cookie == "rm_session=abc.123")
        let live = APIClient(server: .live, session: store, transport: server.transport)
        #expect(live.webSocketRequest("/voice").url?.absoluteString == "wss://rivermindpoker.com/voice")
    }

    @Test func makesTheGuestAgainWhenTheSessionHasEnded() async throws {
        let ended = #"{"detail":"Your session has ended. Reload the page to start a new one."}"#
        let server = FakeServer([
            "GET /api/wallet": [
                FakeServer.Reply(status: 401, body: Data(ended.utf8)),
                FakeServer.Reply(body: Data(#"{"balance":20000,"notice":"n","entries":[]}"#.utf8)),
            ],
            "POST /api/session": [FakeServer.Reply(headers: ["Set-Cookie": cookie], body: Data(guest.utf8))],
        ])
        let store = MemorySessionStore("expired")
        let wallet = try await APIClient(server: local, session: store, transport: server.transport).wallet()
        #expect(wallet.balance == 20000)
        #expect(server.requests.map { "\($0.httpMethod!) \($0.url!.path()) \($0.cookie ?? "-")" } == [
            "GET /api/wallet rm_session=expired",
            "POST /api/session rm_session=expired",
            "GET /api/wallet rm_session=abc.123",
        ])
    }

    @Test func aSessionThatIsRefusedIsNotAskedForAgain() async throws {
        let server = FakeServer(["POST /api/session": (401, #"{"detail":"No"}"#)])
        await #expect(throws: APIError.status(401, detail: "No")) {
            try await APIClient(server: local, transport: server.transport).startSession()
        }
        #expect(server.requests.count == 1)
    }

    @Test func reportsALimitWithItsWaitAndNeverRetries() async throws {
        let server = FakeServer([
            "POST /api/tables": [
                FakeServer.Reply(status: 429, headers: ["Retry-After": "7"], body: Data(#"{"detail":"Too many requests"}"#.utf8))
            ]
        ])
        await #expect(throws: APIError.limited(detail: "Too many requests", retryAfter: 7)) {
            try await APIClient(server: local, transport: server.transport).newTable(NewTableRequest(seats: 6))
        }
        #expect(server.requests.count == 1)
    }

    @Test func reportsARefusalWithItsDetail() async throws {
        let server = FakeServer(["GET /api/config": (500, #"{"detail":"Broken"}"#)])
        await #expect(throws: APIError.status(500, detail: "Broken")) {
            try await APIClient(server: local, transport: server.transport).config()
        }
    }

    @Test func reportsAnUnreadableAnswer() async throws {
        let server = FakeServer(["GET /api/config": (200, "<html>")])
        await #expect {
            try await APIClient(server: local, transport: server.transport).config()
        } throws: { error in
            if case .unreadable = error as? APIError { true } else { false }
        }
    }

    @Test func reportsNoAnswer() async throws {
        let client = APIClient(server: local) { _ in throw URLError(.cannotConnectToHost) }
        await #expect {
            try await client.config()
        } throws: { error in
            if case .unreachable = error as? APIError { true } else { false }
        }
    }

    /// Each route's method, path, query and body, as the page's own requests are.
    @Test func eachRouteIsAskedAsThePageAsksIt() async throws {
        let tables = #"{"tables":[]}"#
        let seat = #"{"table_id":"t 1","seat":2,"seated":true,"hold":null}"#
        let relations = #"{"players":[]}"#
        let server = FakeServer([
            "GET /api/tables": (200, tables),
            "POST /api/tables": (201, #"{"table_id":"t1","seat":0,"invite":"inv"}"#),
            "GET /api/invites/a%2Fb": (404, #"{"detail":"That invite has expired: its table has closed."}"#),
            "POST /api/tables/t%201/seat": (200, seat),
            "DELETE /api/tables/t%201/seat": (204, ""),
            "POST /api/tables/t%201/waitlist": (200, #"{"table_id":"t 1","position":1}"#),
            "DELETE /api/tables/t%201/waitlist": (204, ""),
            "POST /api/quick-seat": (200, seat),
            "POST /api/practice": (200, #"{"table_id":"t2","seat":0,"created":true,"bot":"heuristic","stack":10000}"#),
            "GET /api/hands": (200, #"{"hands":[],"more":false}"#),
            "GET /api/relations": (200, relations),
            "PUT /api/relations": (200, relations),
            "DELETE /api/relations/0123456789abcdef": (200, relations),
            "POST /api/reports": (201, #"{"recorded":true}"#),
            "GET /api/voice": (200, #"{"offered":false}"#),
            "POST /api/tables/t%201/voice": (200, #"{"table":"t 1","seat":2,"token":"x","url":"/voice"}"#),
        ])
        let client = APIClient(server: local, transport: server.transport)
        _ = try await client.tables(seats: 6, bigBlind: 100, open: true)
        // No bots is an explicit null: leaving `bots` out asks for the default bot.
        _ = try await client.newTable(NewTableRequest(seats: 6, bigBlind: 100, isPrivate: true, nulls: [.bots]))
        await #expect(throws: APIError.status(404, detail: "That invite has expired: its table has closed.")) {
            try await client.invite("a/b")
        }
        _ = try await client.takeSeat(table: "t 1", SeatRequest(buyIn: 5000, invite: "inv"))
        try await client.giveUpSeat(table: "t 1")
        _ = try await client.joinWaitlist(table: "t 1")
        try await client.leaveWaitlist(table: "t 1")
        _ = try await client.quickSeat(QuickSeatRequest(seats: 2))
        _ = try await client.practice(PracticeRequest(bot: "blueprint"))
        _ = try await client.hands(limit: 20, before: "19")
        _ = try await client.relations()
        _ = try await client.setRelation(RelationRequest(tableID: "t1", seat: 3, kind: .block))
        _ = try await client.removeRelation(ref: "0123456789abcdef")
        _ = try await client.report(ReportRequest(tableID: "t1", seat: 3, reason: .voice))
        #expect(try await client.voiceOffer().offered == false)
        #expect(try await client.voiceToken(table: "t 1").url == "/voice")

        let asked = server.requests.map { request in
            "\(request.httpMethod!) \(request.url!.absoluteString.dropFirst(local.origin.absoluteString.count)) \(request.body ?? "-")"
        }
        let want = [
            "GET /api/tables?seats=6&big_blind=100&open=true -",
            #"POST /api/tables {"bots":null,"big_blind":100,"private":true,"seats":6}"#,
            "GET /api/invites/a%2Fb -",
            #"POST /api/tables/t%201/seat {"buy_in":5000,"invite":"inv"}"#,
            "DELETE /api/tables/t%201/seat -",
            "POST /api/tables/t%201/waitlist {}",
            "DELETE /api/tables/t%201/waitlist -",
            #"POST /api/quick-seat {"seats":2}"#,
            #"POST /api/practice {"bot":"blueprint"}"#,
            "GET /api/hands?limit=20&before=19 -",
            "GET /api/relations -",
            #"PUT /api/relations {"kind":"block","seat":3,"table_id":"t1"}"#,
            "DELETE /api/relations/0123456789abcdef -",
            #"POST /api/reports {"reason":"voice","seat":3,"table_id":"t1"}"#,
            "GET /api/voice -",
            "POST /api/tables/t%201/voice -",
        ]
        #expect(asked.count == want.count)
        for (got, expected) in zip(asked, want) {
            // Bodies compare parsed: Swift's encoder does not keep the fields' order.
            let (gotHead, gotBody) = got.splitBody()
            let (wantHead, wantBody) = expected.splitBody()
            #expect(gotHead == wantHead)
            if wantBody == "-" { #expect(gotBody == "-", "\(got)") } else {
                #expect(try parsed(Data(gotBody.utf8)) == parsed(Data(wantBody.utf8)), "\(got)")
            }
        }
        #expect(server.requests.allSatisfy { $0.value(forHTTPHeaderField: "Origin") == nil })
        #expect(server.requests.filter { $0.httpBody != nil }.allSatisfy {
            $0.value(forHTTPHeaderField: "Content-Type") == "application/json"
        })
    }
}

extension String {
    /// `METHOD path` and the body after it.
    func splitBody() -> (String, String) {
        let parts = split(separator: " ", maxSplits: 2).map(String.init)
        return ("\(parts[0]) \(parts[1])", parts[2])
    }
}

@Suite struct SessionCookieTests {
    @Test(arguments: [
        ("rm_session=abc.123; HttpOnly; Max-Age=15552000; Path=/; SameSite=lax; Secure", "abc.123"),
        ("rm_session=abc.123; HttpOnly; Max-Age=15552000; Path=/; SameSite=lax", "abc.123"),
        ("other=1; Path=/, rm_session=xyz; Path=/", "xyz"),
        ("rm_session=; Max-Age=0; Path=/", ""),
    ])
    func readsTheSessionCookie(header: String, value: String) {
        #expect(SessionCookie.value(fromSetCookie: header) == value)
    }

    @Test func ignoresOtherCookies() {
        #expect(SessionCookie.value(fromSetCookie: "theme=dark; Path=/") == nil)
    }

    @Test func anEndedSessionIsForgotten() async throws {
        let server = FakeServer([
            "GET /api/wallet": [FakeServer.Reply(headers: ["Set-Cookie": "rm_session=; Max-Age=0; Path=/"],
                                                 body: Data(#"{"balance":0,"notice":"n","entries":[]}"#.utf8))]
        ])
        let store = MemorySessionStore("old")
        _ = try await APIClient(server: local, session: store, transport: server.transport).wallet()
        #expect(store.load() == nil)
    }
}

@Suite @MainActor struct LobbyModelTests {
    @Test func makesTheGuestThenLoadsTheConfig() async throws {
        let server = FakeServer([
            "POST /api/session": (200, guest),
            "GET /api/config": (200, config),
        ])
        let model = LobbyModel(client: APIClient(server: local, transport: server.transport))
        #expect(model.state == .loading)
        await model.load()
        guard case let .ready(config, guest) = model.state else {
            Issue.record("expected the config, got \(model.state)")
            return
        }
        #expect(config.seatCounts == Array(2...9))
        #expect(guest.name == "Guest 1234")
        // The config first, so an old build asks to be updated before it makes a guest.
        #expect(server.requests.map { $0.url!.path() } == ["/api/config", "/api/session"])
    }

    /// P5D.11: a build older than the server's oldest asks to be updated and makes no guest.
    @Test func anOldBuildAsksToBeUpdated() async throws {
        let raised = config.replacingOccurrences(of: #""practice_stack":10000"#, with: #""practice_stack":10000,"oldest_app_build":3"#)
        let server = FakeServer(["GET /api/config": (200, raised), "POST /api/session": (200, guest)])
        let old = LobbyModel(client: APIClient(server: local, transport: server.transport), build: 2)
        await old.load()
        #expect(old.state == .updateNeeded(oldest: 3))
        #expect(server.requests.map { $0.url!.path() } == ["/api/config"])
        let current = LobbyModel(client: APIClient(server: local, transport: server.transport), build: 3)
        await current.load()
        guard case .ready = current.state else {
            Issue.record("expected the lobby, got \(current.state)")
            return
        }
    }

    /// P5D.11: deleting the guest forgets the session and the table, and says whether
    /// everything is gone yet.
    @Test func deletesTheGuest() async throws {
        let server = FakeServer([
            "DELETE /api/guest": [
                FakeServer.Reply(
                    headers: ["Set-Cookie": "rm_session=; Max-Age=0; Path=/; SameSite=lax; HttpOnly"],
                    body: Data(#"{"erased":false}"#.utf8))
            ]
        ])
        let store = MemorySessionStore("abc.123")
        let client = APIClient(server: local, session: store, transport: server.transport)
        let memory = MemoryTableMemory("t1")
        let table = TableConnection(client: client, makeSocket: { _ in ClosedSocket() }, memory: memory)
        let model = LobbyModel(client: client)
        await model.deleteGuest(leaving: table)
        #expect(model.state == .deleted(erased: false))
        #expect(store.load() == nil)
        #expect(memory.load() == nil && table.tableID == nil)
        let sent = try #require(server.requests.first)
        #expect(sent.httpMethod == "DELETE" && sent.body == #"{"confirm":true}"#)
        #expect(sent.value(forHTTPHeaderField: "Cookie") == "rm_session=abc.123")
    }
}

/// A socket that never opens, for a connection that is not meant to connect.
final class ClosedSocket: TableSocket, @unchecked Sendable {
    func open() async throws { throw URLError(.cannotConnectToHost) }
    func send(_ text: String) async throws { throw URLError(.notConnectedToInternet) }
    func receive() async throws -> String { throw URLError(.notConnectedToInternet) }
    func close() {}
}

@Suite @MainActor struct AppBuildTests {
    /// Every request and the socket's handshake name the app and its build, and nothing else.
    @Test func everyRequestNamesTheAppAndItsBuild() async throws {
        let server = FakeServer(["GET /api/config": (200, config)])
        let client = APIClient(server: local, transport: server.transport)
        _ = try await client.config()
        #expect(server.requests.first?.value(forHTTPHeaderField: "RiverMind-Client") == "ios/\(AppBuild.number)")
        #expect(client.webSocketRequest("/ws").value(forHTTPHeaderField: "RiverMind-Client") == "ios/\(AppBuild.number)")
    }

    @Test func aBuildIsServedUnlessTheServerNamesANewerOldest() throws {
        let decoded = try JSONDecoder().decode(ConfigResponse.self, from: Data(config.utf8))
        #expect(decoded.oldestAppBuild == nil && AppBuild.isSupported(by: decoded, build: 1))
        var raised = decoded
        raised.oldestAppBuild = 2
        #expect(!AppBuild.isSupported(by: raised, build: 1))
        #expect(AppBuild.isSupported(by: raised, build: 2))
        #expect(AppBuild.isSupported(by: raised, build: 3))
    }

    @Test func saysWhyItFailed() async throws {
        let model = LobbyModel(
            client: APIClient(server: local) { _ in throw URLError(.cannotConnectToHost) })
        await model.load()
        guard case let .failed(message) = model.state else {
            Issue.record("expected a failure, got \(model.state)")
            return
        }
        #expect(message.hasPrefix("The server could not be reached"))
    }
}

/// Against a real server when `RIVERMIND_SERVER` names one: `ios/test.sh` starts the
/// Node server from `web/build` and sets it.
@Suite(.enabled(if: Server.from(environment: ProcessInfo.processInfo.environment) != nil,
                "RIVERMIND_SERVER names no server"))
struct LocalServerTests {
    let server = Server.from(environment: ProcessInfo.processInfo.environment)!

    @Test func readsTheConfigFromARealServer() async throws {
        let config = try await APIClient(server: server).config()
        #expect(config.protocolVersion == 2)
        #expect(config.seatCounts == Array(2...9))
        #expect(config.bots.contains { $0.kind == "heuristic" && $0.label == "RiverMind Easy" })
    }

    @Test func theSameSessionIsTheSameGuest() async throws {
        let store = MemorySessionStore()
        let client = APIClient(server: server, session: store)
        let first = try await client.startSession()
        #expect(first.created && store.load() != nil)
        let again = try await client.startSession()
        #expect(!again.created && again.playerID == first.playerID)
        let other = try await APIClient(server: server).startSession()
        #expect(other.playerID != first.playerID)
    }

    /// Every route the app uses, as a guest finding a table, playing and looking back would
    /// use them, within the API's limit of a burst of 60 and Caddy's of 30 new tables and
    /// 60 seatings a minute.
    @Test func everyRouteAnswersAsTheAppExpects() async throws {
        let counted = Counted(server: server)
        let client = APIClient(server: server, session: MemorySessionStore(), transport: counted.transport)
        let guest = try await client.startSession()
        let session = try #require(client.session.load())
        #expect(guest.balance > 0)
        let config = try await client.config()
        let wallet = try await client.wallet()
        #expect(wallet.balance == guest.balance && wallet.notice.hasPrefix("Play money only"))

        // A private table with bots, found by its invite.
        let stakes = try #require(config.stakes.first)
        let made = try await client.newTable(
            NewTableRequest(seats: 3, bots: "heuristic", bigBlind: stakes.bigBlind, isPrivate: true))
        let code = try #require(made.invite)
        let invited = try await client.invite(code)
        #expect(invited.tableID == made.tableID && invited.seated && invited.isPrivate)
        let listed = try await client.tables(seats: 3, bigBlind: stakes.bigBlind)
        #expect(listed.tables.contains { $0.tableID == made.tableID })
        await #expect(throws: APIError.status(404, detail: "That invite has expired: its table has closed.")) {
            try await client.invite("no-such-invite")
        }

        // A second guest sits there, gives the seat up, waits, and stops waiting.
        let other = APIClient(server: server, session: MemorySessionStore(), transport: counted.transport)
        _ = try await other.startSession()
        let held = try await other.takeSeat(table: made.tableID, SeatRequest(holdOnly: true, invite: code))
        #expect(held.hold != nil && !held.seated)
        try await other.giveUpSeat(table: made.tableID)
        await #expect(throws: APIError.self) {
            // The table has a free seat, so there is no line to join.
            try await other.joinWaitlist(table: made.tableID, WaitlistRequest(invite: code))
        }

        // Quick seat and practice.
        let quick = try await other.quickSeat(QuickSeatRequest(seats: 2, bigBlind: stakes.bigBlind))
        #expect(quick.seated)
        let practice = try await client.practice()
        #expect(practice.stack == config.practiceStack && practice.bot == "heuristic")

        // Mutes, blocks and reports need a person in the seat: a bot's seat is refused.
        let relations = try await client.relations()
        #expect(relations.players.isEmpty)
        await #expect(throws: APIError.self) {
            try await client.setRelation(RelationRequest(tableID: made.tableID, seat: 1, kind: .mute))
        }
        await #expect(throws: APIError.status(404, detail: "You have not muted or blocked that player.")) {
            try await client.removeRelation(ref: "0123456789abcdef")
        }
        await #expect(throws: APIError.self) {
            try await client.report(ReportRequest(tableID: made.tableID, seat: 1, reason: .abuse))
        }

        // No hands played yet, and voice is not offered by a server without a voice service.
        let hands = try await client.hands(limit: 5)
        #expect(hands.hands.isEmpty && !hands.more)
        #expect(try await client.voiceOffer().offered == false)
        await #expect(throws: APIError.status(503, detail: "Voice is not available here.")) {
            try await client.voiceToken(table: made.tableID)
        }

        // Deleting the guest (P5D.11) ends its session: the next request is a new guest. It
        // may still be in a hand at the table it made, so it may not be erased yet.
        _ = try await client.deleteGuest()
        #expect(client.session.load() == nil)
        // The old cookie opens nothing (the client would make a new guest on a 401, so ask bare).
        var request = URLRequest(url: server.url("/api/wallet"))
        request.setValue("\(SessionCookie.name)=\(session)", forHTTPHeaderField: "Cookie")
        let (_, answer) = try await URLSession(configuration: .ephemeral).data(for: request)
        #expect((answer as? HTTPURLResponse)?.statusCode == 401)
        let fresh = try await client.startSession()
        #expect(fresh.created && fresh.playerID != guest.playerID)

        #expect(counted.limited == 0)
        #expect(counted.count < 30)
    }
}

/// A real transport that counts what it sends and every 429 it gets.
final class Counted: Sendable {
    private let state = Mutex((count: 0, limited: 0))
    private let session: URLSession

    init(server _: Server) {
        // As the app's own client: no cookies of the URL session's own.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration)
    }

    var count: Int { state.withLock { $0.count } }
    var limited: Int { state.withLock { $0.limited } }

    var transport: Transport {
        { [self] request in
            let (data, response) = try await session.data(for: request)
            state.withLock { state in
                state.count += 1
                if (response as? HTTPURLResponse)?.statusCode == 429 { state.limited += 1 }
            }
            return (data, response)
        }
    }
}
