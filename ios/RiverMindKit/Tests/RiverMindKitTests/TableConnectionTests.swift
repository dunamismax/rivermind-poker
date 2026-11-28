import Foundation
import Testing
@testable import RiverMindKit

/// A socket the test drives: what the app sent, and what the server says next.
final class FakeSocket: TableSocket, @unchecked Sendable {
    let request: URLRequest
    private let lock = NSLock()
    private var _sent: [String] = []
    private var queued: [Result<String, any Error>] = []
    private var waiting: CheckedContinuation<String, any Error>?
    private var _closed = false

    init(request: URLRequest) { self.request = request }

    var sent: [[String: Any]] {
        lock.withLock { _sent }.map { try! JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    }
    var types: [String] { sent.map { $0["type"] as! String } }
    var closed: Bool { lock.withLock { _closed } }

    func open() async throws {}

    func send(_ text: String) async throws {
        lock.withLock { _sent.append(text) }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if !queued.isEmpty {
                let next = queued.removeFirst()
                lock.unlock()
                continuation.resume(with: next)
            } else {
                waiting = continuation
                lock.unlock()
            }
        }
    }

    func close() {
        lock.withLock { _closed = true }
        finish(.failure(URLError(.cancelled)))
    }

    /// The server sends `message`, a JSON object.
    func deliver(_ message: Any) {
        let data = try! JSONSerialization.data(withJSONObject: message)
        finish(.success(String(decoding: data, as: UTF8.self)))
    }

    /// The connection drops under the app.
    func drop() { finish(.failure(URLError(.networkConnectionLost))) }

    private func finish(_ result: Result<String, any Error>) {
        lock.lock()
        if let waiting {
            self.waiting = nil
            lock.unlock()
            waiting.resume(with: result)
        } else {
            queued.append(result)
            lock.unlock()
        }
    }
}

/// Timers the test fires by hand.
@MainActor
final class ManualScheduler {
    struct Timer {
        let seconds: Double
        let work: @MainActor () -> Void
        var cancelled = false
    }
    private(set) var timers: [Timer] = []

    var scheduler: Scheduler {
        { [self] seconds, work in
            let index = timers.count
            timers.append(Timer(seconds: seconds, work: work))
            return { [self] in timers[index].cancelled = true }
        }
    }

    var pending: [Double] { timers.filter { !$0.cancelled }.map(\.seconds) }

    /// Runs every timer still pending, in the order they were set.
    func fire() {
        let due = timers.indices.filter { !timers[$0].cancelled }
        for index in due {
            timers[index].cancelled = true
            timers[index].work()
        }
    }
}

/// Waits until `condition` holds, for at most `seconds`: bounded by time, never only by
/// turns of the loop (AGENTS.md).
@MainActor
func eventually(_ seconds: Double = 2, _ condition: @MainActor () -> Bool) async {
    let end = Date().addingTimeInterval(seconds)
    while !condition() && Date() < end { try? await Task.sleep(for: .milliseconds(2)) }
    #expect(condition())
}

/// A recorded table message from the protocol fixture, as a JSON object to change.
func recordedTable(where match: ([String: Any]) -> Bool) -> [String: Any] {
    for data in ProtocolFixture.shared.server {
        let message = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        if message["type"] as? String == "table", match(message["view"] as! [String: Any]) { return message }
    }
    fatalError("no such recorded table message")
}

func you(_ view: [String: Any]) -> [String: Any] { view["you"] as! [String: Any] }

/// The sockets the connection made, newest last.
final class Sockets: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [FakeSocket] = []
    func add(_ socket: FakeSocket) { lock.withLock { list.append(socket) } }
    var all: [FakeSocket] { lock.withLock { list } }
}

@MainActor
final class Harness {
    let sockets = Sockets()
    let memory = MemoryTableMemory()
    let clock = ManualScheduler()
    let connection: TableConnection
    let tableID: String
    /// A view at the recorded table with the guest to act.
    let turn: [String: Any]

    init() {
        let client = APIClient(
            server: Server(origin: "http://127.0.0.1:9")!, session: MemorySessionStore("cookie-1")
        ) { _ in throw URLError(.cannotConnectToHost) }
        let made = sockets
        let clock = clock
        connection = TableConnection(
            client: client,
            makeSocket: { request in
                let socket = FakeSocket(request: request)
                made.add(socket)
                return socket
            },
            memory: memory, schedule: clock.scheduler, now: { 2_000_000_000 })
        turn = recordedTable { you($0)["legal"] is [String: Any] }
        tableID = turn["table_id"] as! String
    }

    var socket: FakeSocket { sockets.all.last! }
    var count: Int { sockets.all.count }

    /// The recorded turn with its `seq` and table changed.
    func view(seq: Int, legal: Bool = true, table: String? = nil) -> [String: Any] {
        var message = turn
        var view = message["view"] as! [String: Any]
        view["seq"] = seq
        if let table { view["table_id"] = table; message["table_id"] = table }
        if !legal {
            var me = you(view)
            me["legal"] = NSNull()
            view["you"] = me
        }
        message["view"] = view
        message["events"] = [] as [Any]
        return message
    }

    /// Follows the recorded table and waits for hello and join.
    func joined() async {
        let before = count
        connection.follow(tableID)
        await eventually { count == before + 1 && socket.types == ["hello", "join_table"] && connection.connected }
    }
}

@MainActor
@Suite struct TableConnectionTests {
    @Test func backoffDoublesToEightSeconds() {
        #expect((0..<6).map(TableConnection.backoff) == [1, 2, 4, 8, 8, 8])
        #expect(TableConnection.backoff(1_000) == 8)
    }

    @Test func saysHelloJoinsAndKeepsTheNewestView() async throws {
        let h = Harness()
        await h.joined()
        let request = h.socket.request
        #expect(request.url?.absoluteString == "ws://127.0.0.1:9/ws")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "rm_session=cookie-1")
        #expect(request.value(forHTTPHeaderField: "Origin") == nil)
        #expect(h.socket.sent[0]["protocol"] as? Int == 2)
        #expect(h.socket.sent[1]["table_id"] as? String == h.tableID)
        #expect(h.memory.load() == h.tableID)
        #expect(h.connection.status == .connecting)

        h.socket.deliver(["type": "welcome", "protocol": 2, "player_id": "p_1", "name": "Quiet Heron 42"])
        h.socket.deliver(h.view(seq: 5))
        await eventually { h.connection.view?.seq == 5 }
        #expect(h.connection.player?.name == "Quiet Heron 42")
        #expect(h.connection.status == .open)
        #expect(h.connection.clockOffset == 2_000_000_000 - h.connection.view!.serverTime)

        // Another table's message changes nothing.
        h.socket.deliver(h.view(seq: 9, table: "elsewhere"))
        h.socket.deliver(h.view(seq: 6))
        await eventually { h.connection.view?.seq == 6 }
        #expect(h.connection.tableID == h.tableID)
    }

    @Test func logsEachEventWithTheNameInItsSeatAtTheTime() throws {
        let message = recordedTable { _ in true }
        let view = try JSONDecoder().decode(TableMessage.self, from: JSONSerialization.data(withJSONObject: message)).view
        let seat = view.seats.firstIndex { $0 != nil }!
        var after = view
        after.seats[seat]!.name = "Newcomer"
        let left = TableEvent(seq: 1, kind: .left, seat: seat)
        #expect(TableConnection.whoWas(left, before: view, after: after) == view.seats[seat]!.name)
        #expect(TableConnection.whoWas(left, before: nil, after: after) == "Newcomer")
        let seated = TableEvent(seq: 2, kind: .seated, seat: seat, name: "Arriving")
        #expect(TableConnection.whoWas(seated, before: view, after: after) == "Arriving")
        #expect(TableConnection.whoWas(TableEvent(seq: 3, kind: .board), before: view, after: after) == nil)
    }

    @Test func actsWithTheViewsSeqOneAtATime() async {
        let h = Harness()
        await h.joined()
        h.socket.deliver(h.view(seq: 7, legal: false))
        await eventually { h.connection.view?.seq == 7 }
        #expect(!h.connection.act(.call), "not the guest's turn")

        h.socket.deliver(h.view(seq: 8))
        await eventually { h.connection.view?.seq == 8 }
        #expect(h.connection.act(.raise, amount: 400))
        #expect(!h.connection.act(.fold), "one action at a time")
        #expect(h.connection.pending)
        await eventually { h.socket.types.last == "act" }
        let act = h.socket.sent.last!
        #expect(act["seq"] as? Int == 8)
        #expect(act["action"] as? String == "raise")
        #expect(act["amount"] as? Int == 400)
        #expect(h.socket.types.filter { $0 == "act" }.count == 1)

        h.socket.deliver(h.view(seq: 9))
        await eventually { !h.connection.pending }
        #expect(h.connection.act(.call))
        await eventually { h.socket.types.filter { $0 == "act" }.count == 2 }
        #expect(h.socket.sent.last!["amount"] == nil)
    }

    @Test func aRefusedActionAsksForAFreshViewAndIsNeverSentAgain() async {
        let h = Harness()
        await h.joined()
        h.socket.deliver(h.view(seq: 8))
        await eventually { h.connection.view?.seq == 8 }
        #expect(h.connection.act(.call))
        h.socket.deliver(["type": "error", "code": "stale", "message": "That turn has passed.", "table_id": h.tableID])
        await eventually { h.connection.notice?.text == "That turn has passed." }
        #expect(!h.connection.pending)
        await eventually { h.socket.types.last == "refresh" }
        #expect(h.socket.types.filter { $0 == "act" }.count == 1)

        // A flood or a refused reaction changed nothing: no refresh.
        let sent = h.socket.sent.count
        h.socket.deliver(["type": "error", "code": "rate_limited", "message": "Slow down."])
        await eventually { h.connection.notice?.text == "Slow down." }
        h.socket.deliver(["type": "error", "code": "not_seated", "message": "Sit down first."])
        await eventually { h.connection.notice?.text == "Sit down first." }
        #expect(h.socket.sent.count == sent)
        // An error code this build does not know is shown, and the view refreshed.
        h.socket.deliver(["type": "error", "code": "brand_new", "message": "Something new."])
        await eventually { h.connection.notice?.text == "Something new." && h.socket.sent.count == sent + 1 }
    }

    @Test func rejoinsWithBackoffAfterADrop() async {
        let h = Harness()
        await h.joined()
        h.socket.drop()
        await eventually { h.connection.status == .closed }
        #expect(!h.connection.connected)
        #expect(h.clock.pending == [1])
        #expect(!h.connection.act(.call))

        h.clock.fire()
        await eventually { h.count == 2 && h.socket.types == ["hello", "join_table"] }
        h.socket.drop()
        await eventually { h.clock.pending == [2] }
        h.clock.fire()
        await eventually { h.count == 3 && h.socket.types == ["hello", "join_table"] }
        // A view resets the backoff, as after a server restart mid-hand.
        h.socket.deliver(h.view(seq: 12))
        await eventually { h.connection.view?.seq == 12 }
        #expect(h.connection.retries == 0)
        h.socket.drop()
        await eventually { h.clock.pending == [1] }
    }

    @Test func forgetsAClosedTableButKeepsTheGuest() async {
        let h = Harness()
        await h.joined()
        h.socket.deliver(["type": "welcome", "protocol": 2, "player_id": "p_1", "name": "Ann"])
        h.socket.deliver(["type": "table_closed", "table_id": h.tableID, "message": "The table closed."])
        await eventually { h.connection.tableID == nil }
        #expect(h.connection.closedMessage == "The table closed.")
        #expect(h.connection.player?.name == "Ann")
        #expect(h.memory.load() == nil)
        #expect(h.socket.closed)
        #expect(h.clock.pending.isEmpty)

        await h.joined()
        h.socket.deliver(["type": "error", "code": "unknown_table", "message": "No such table."])
        await eventually { h.connection.tableID == nil }
        #expect(h.connection.closedMessage == TableConnection.closedTableMessage)
    }

    @Test func anEndedSessionReturnsToTheLobbyWithTheServersMessage() async {
        let h = Harness()
        await h.joined()
        h.socket.deliver(["type": "welcome", "protocol": 2, "player_id": "p_1", "name": "Ann"])
        h.socket.deliver(["type": "error", "code": "unauthorized", "message": "Your session has ended."])
        await eventually { h.connection.tableID == nil }
        #expect(h.connection.player == nil)
        #expect(h.connection.closedMessage == "Your session has ended.")
    }

    @Test func leavesOnRequest() async {
        let h = Harness()
        await h.joined()
        let socket = h.socket
        h.connection.leave()
        await eventually { socket.types.last == "leave_table" }
        #expect(socket.closed)
        #expect(h.connection.tableID == nil)
        #expect(h.connection.status == .idle)
        #expect(h.memory.load() == nil)
    }

    @Test func rejoinsTheTableAnEarlierLaunchFollowed() async {
        let h = Harness()
        #expect(!h.connection.start())
        h.memory.save(h.tableID)
        #expect(h.connection.start())
        await eventually { h.count == 1 && h.socket.types == ["hello", "join_table"] }
    }

    @Test func showsReactionsForAMomentAndSendsPresetOnes() async {
        let h = Harness()
        await h.joined()
        h.socket.deliver(h.view(seq: 3))
        await eventually { h.connection.view != nil }
        let reaction: [String: Any] = [
            "type": "reaction", "table_id": h.tableID, "seat": 1, "name": "Bob", "ref": "r_bob",
            "reaction": "nice_hand", "text": "Nice hand",
        ]
        h.socket.deliver(reaction)
        await eventually { h.connection.reactions[1]?.text == "Nice hand" }
        #expect(h.clock.pending == [TableConnection.reactionSeconds])
        h.clock.fire()
        #expect(h.connection.reactions.isEmpty)

        h.socket.deliver(reaction)
        await eventually { h.connection.reactions[1] != nil }
        h.connection.clearReaction(seat: 1)
        #expect(h.connection.reactions.isEmpty)
        #expect(h.clock.pending.isEmpty)

        #expect(h.connection.react(.thanks))
        await eventually { h.socket.types.last == "react" }
        #expect(h.socket.sent.last!["reaction"] as? String == "thanks")
    }

    @Test func letsGoInTheBackgroundAndRejoinsWhenItComesBack() async {
        let h = Harness()
        await h.joined()
        let first = h.socket
        h.connection.suspend()
        #expect(first.closed)
        #expect(h.connection.status == .idle)
        #expect(h.connection.suspended)
        #expect(h.connection.tableID == h.tableID)
        #expect(h.clock.pending.isEmpty, "no retry while suspended")
        #expect(h.count == 1)

        h.connection.resume()
        await eventually { h.count == 2 && h.socket.types == ["hello", "join_table"] }
        #expect(!h.connection.suspended)
        // Coming back while the socket waits on its backoff rejoins at once.
        h.socket.drop()
        await eventually { h.connection.status == .closed }
        h.connection.resume()
        await eventually { h.count == 3 && h.socket.types == ["hello", "join_table"] }
        #expect(h.clock.pending.isEmpty)
    }

    @Test func followsTheAppsPhase() async {
        let h = Harness()
        await h.joined()
        #expect(h.connection.joins == 1)
        h.connection.phase(.inactive)
        #expect(!h.socket.closed, "a passing inactive changes nothing")
        h.connection.phase(.background)
        #expect(h.socket.closed && h.connection.suspended)
        h.connection.phase(.active)
        await eventually { h.connection.joins == 2 && h.socket.types == ["hello", "join_table"] }

        // In voice the table stays connected in the background (Q-16).
        h.connection.keepsConnectedInBackground = true
        let socket = h.socket
        h.connection.phase(.background)
        #expect(!socket.closed && !h.connection.suspended)
        h.connection.phase(.active)
        #expect(h.connection.joins == 2)
    }

    @Test func rejoinsAtOnceWhenTheNetworkMoves() async {
        let h = Harness()
        await h.joined()
        let first = h.socket
        h.connection.networkChanged()
        #expect(first.closed)
        await eventually { h.count == 2 && h.socket.types == ["hello", "join_table"] }
        #expect(h.clock.pending.isEmpty)
    }

    @Test func sitsAsSoonAsTheHeldSeatIsReady() async throws {
        let h = Harness()
        var held = recordedTable { you($0)["hold"] is [String: Any] }
        let table = held["table_id"] as! String
        let seat = try JSONDecoder().decode(
            SeatResponse.self,
            from: Data(#"{"table_id":"\#(table)","seat":1,"seated":false,"hold":null}"#.utf8))
        h.connection.balance = 700
        h.connection.arrive(seat, buyIn: nil)
        await eventually { h.socket.types == ["hello", "join_table"] && h.connection.connected }
        var view = held["view"] as! [String: Any]
        var me = you(view)
        var hold = me["hold"] as! [String: Any]
        hold["ready"] = false
        me["hold"] = hold
        view["you"] = me
        held["view"] = view
        h.socket.deliver(held)
        await eventually { h.connection.view != nil }
        #expect(!h.socket.types.contains("sit"), "the seat is not ready yet")

        hold["ready"] = true
        me["hold"] = hold
        view["you"] = me
        view["seq"] = (view["seq"] as! Int) + 1
        held["view"] = view
        h.socket.deliver(held)
        await eventually { h.socket.types.last == "sit" }
        let sit = h.socket.sent.last!
        let most = (view["settings"] as! [String: Any])["max_buy_in"] as! Int
        #expect(sit["buy_in"] as? Int == min(most, 700))
        #expect(sit["seat"] as? Int == hold["seat"] as? Int)
    }

    @Test func theWatcherReportsAMoveOnlyToANewUsablePath() {
        let watcher = NetworkWatcher()
        let wifi = NetworkWatcher.Path(usable: true, interfaces: ["wifi en0"])
        let cellular = NetworkWatcher.Path(usable: true, interfaces: ["cellular pdp_ip0"])
        #expect(!watcher.moved(to: wifi), "the first path is where it starts")
        #expect(!watcher.moved(to: wifi))
        #expect(!watcher.moved(to: NetworkWatcher.Path(usable: false, interfaces: [])))
        #expect(watcher.moved(to: cellular))
        #expect(watcher.moved(to: wifi))
    }
}
