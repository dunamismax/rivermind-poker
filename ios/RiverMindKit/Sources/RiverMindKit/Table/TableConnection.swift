// The app's side of a no-limit table (protocol v2): a port of what the page's
// `NlConnection` (web/src/lib/nl/connection.svelte.ts) does on its socket. One
// WebSocket says hello and follows the guest's table. Each `table` message
// carries the guest's whole view, so the newest one is all the screens need;
// its events feed the hand log. Actions carry the view's `seq`, so an action
// meant for an earlier turn is refused rather than misapplied, and a refused
// one is never sent again by itself: the connection asks for a fresh view and
// the guest decides again. After a dropped connection or a server restart the
// socket says hello again and rejoins, with the page's backoff.
//
// What a page does not have to do (P5D.3, Q-16): when the app goes to the
// background without voice, it lets go of the socket and rejoins when it comes
// back; when the network moves between Wi-Fi and cellular, it rejoins at once
// rather than waiting for the old socket to time out.

import Foundation
import Observation

/// A logged event with the name of the player in its seat when it happened, so the log
/// still names a player who has since left and someone else sat down.
public struct LoggedEvent: Sendable, Hashable {
    public var event: TableEvent
    public var who: String?
}

/// A reaction showing beside a seat.
public struct ShownReaction: Sendable, Hashable {
    public var id: Int
    public var ref: String
    public var text: String
}

/// A short message to show, as for a refused request; `id` tells a repeat apart.
public struct Notice: Sendable, Hashable {
    public var id: Int
    public var text: String
}

public enum ConnectionStatus: Sendable, Hashable {
    case idle, connecting, open, closed
}

/// Where the app keeps the table it follows, so a relaunch rejoins it, as a page keeps
/// it in `localStorage`.
public protocol TableMemory: Sendable {
    func load() -> String?
    func save(_ tableID: String?)
}

/// The followed table in `UserDefaults`, per server.
public struct DefaultsTableMemory: TableMemory, @unchecked Sendable {
    let key: String
    let defaults: UserDefaults

    public init(server: Server, defaults: UserDefaults = .standard) {
        key = "rivermind.table." + server.origin.absoluteString
        self.defaults = defaults
    }

    public func load() -> String? { defaults.string(forKey: key) }
    public func save(_ tableID: String?) { defaults.set(tableID, forKey: key) }
}

/// The table in memory, for tests.
public final class MemoryTableMemory: TableMemory, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    public init(_ value: String? = nil) { self.value = value }
    public func load() -> String? { lock.withLock { value } }
    public func save(_ tableID: String?) { lock.withLock { value = tableID } }
}

/// Runs `work` after `seconds` on the main actor; the returned closure cancels it.
public typealias Scheduler = @MainActor (_ seconds: Double, _ work: @escaping @MainActor () -> Void) -> @MainActor () -> Void

@MainActor
@Observable
public final class TableConnection {
    public nonisolated static let maxBackoff = 8.0
    public nonisolated static let logLimit = 60
    public nonisolated static let reactionSeconds = Safety.reactionSeconds
    public nonisolated static let closedTableMessage = "That table has closed. Start a new one."

    /// The wait before the next try after `retries` failed ones: 1, 2, 4 and then 8 seconds.
    public nonisolated static func backoff(_ retries: Int) -> Double {
        min(pow(2, Double(min(retries, 10))), maxBackoff)
    }

    public private(set) var player: WelcomeMessage?
    public private(set) var tableID: String?
    public private(set) var view: TableView?
    /// Recent public events at the table, oldest first.
    public private(set) var log: [LoggedEvent] = []
    public private(set) var status: ConnectionStatus = .idle
    public private(set) var connected = false
    /// An action was sent and the table has not answered yet.
    public private(set) var pending = false
    public private(set) var notice: Notice?
    public private(set) var closedMessage: String?
    /// Local clock minus the server's, in seconds, for the turn clocks.
    public private(set) var clockOffset = 0.0
    /// Seat to the reaction showing beside it.
    public private(set) var reactions: [Int: ShownReaction] = [:]
    public private(set) var retries = 0
    /// Whether the app is in the background with the socket let go (Q-16).
    public private(set) var suspended = false
    /// Whether something the guest is in keeps the table connected in the background:
    /// table voice does (Q-16, P5D.10).
    public var keepsConnectedInBackground = false
    /// How many sockets this connection has opened: each a hello and a join.
    public private(set) var joins = 0
    /// Chips in the wallet, for the buy-in of a seat taken as soon as it is ready.
    public var balance: Int?
    /// Runs after each `table` message at the followed table has been taken in: for a
    /// screen that reacts to the change itself (a haptic on the guest's turn), and tests.
    public var onTable: (@MainActor (TableMessage) -> Void)?

    private let client: APIClient
    private let makeSocket: SocketMaker
    private let memory: TableMemory?
    private let schedule: Scheduler
    private let now: @Sendable () -> Double
    private var socket: (any TableSocket)?
    private var reader: Task<Void, Never>?
    private var cancelRetry: (@MainActor () -> Void)?
    private var reactionTimers: [Int: @MainActor () -> Void] = [:]
    private var notices = 0
    private var network: NetworkWatcher?
    private var reactionIDs = 0
    /// Sit as soon as the held seat is ready, with this buy-in (nil: as much as fits).
    private var autoSit: AutoSit?
    private struct AutoSit { var buyIn: Int? }
    /// Frames go out one after another, in the order they were sent.
    private var sending: Task<Void, Never>?

    public init(
        client: APIClient,
        makeSocket: @escaping SocketMaker = URLSessionTableSocket.maker,
        memory: TableMemory? = nil,
        schedule: Scheduler? = nil,
        now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }
    ) {
        self.client = client
        self.makeSocket = makeSocket
        self.memory = memory
        self.schedule = schedule ?? TableConnection.taskScheduler
        self.now = now
    }

    /// The default scheduler: a task that sleeps, then runs the work unless cancelled.
    public static let taskScheduler: Scheduler = { seconds, work in
        let task = Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            if !Task.isCancelled { work() }
        }
        return { task.cancel() }
    }

    // MARK: - Following a table

    /// Rejoins the table an earlier launch followed. Returns whether there was one.
    @discardableResult
    public func start() -> Bool {
        guard let saved = memory?.load(), !saved.isEmpty else { return false }
        follow(saved)
        return true
    }

    /// Follows a table, seated or not: the socket says hello and joins it.
    public func follow(_ tableID: String) {
        autoSit = nil
        closeSocket()
        self.tableID = tableID
        view = nil
        log = []
        clearReactions()
        closedMessage = nil
        memory?.save(tableID)
        open()
    }

    /// Follows the table a seat was taken or held at, and sits as soon as a held seat is
    /// ready, as the page does after the lobby's quick seat or “Sit down”.
    public func arrive(_ seat: SeatResponse, buyIn: Int?) {
        follow(seat.tableID)
        autoSit = seat.seated ? nil : AutoSit(buyIn: buyIn)
    }

    /// Leaves the table: gives up the seat, forgets the table and closes the socket.
    public func leave() {
        if let tableID { _ = send(.leaveTable(LeaveTableMessage(tableID: tableID)), isAction: false) }
        stop()
    }

    /// Forgets the table without a word to the server, as after the guest was deleted
    /// (P5D.11), whose seats the server gives up itself.
    public func forgetTable() {
        stop()
    }

    /// Closes the socket without leaving, as a page unload does.
    public func disconnect() {
        closeSocket()
        status = .idle
    }

    // MARK: - The app's life (Q-16)

    /// Where the app is, as SwiftUI's scene phase says it.
    public enum AppPhase: Sendable {
        case active, inactive, background
    }

    /// Follows the app's phase: lets go of the socket in the background unless voice keeps
    /// it, and rejoins when the app is active again. A passing `inactive` (Control Center,
    /// a call's banner) changes nothing.
    public func phase(_ phase: AppPhase) {
        switch phase {
        case .background where !keepsConnectedInBackground: suspend()
        case .active: resume()
        default: break
        }
    }

    /// Rejoins at once whenever the network moves to a new path, until `stopWatchingNetwork`.
    public func watchNetwork() {
        guard network == nil else { return }
        let watcher = NetworkWatcher()
        watcher.start { [weak self] in self?.networkChanged() }
        network = watcher
    }

    public func stopWatchingNetwork() {
        network?.stop()
        network = nil
    }

    /// The app went to the background, and nothing (voice) keeps it connected: lets go of
    /// the socket and keeps the table, to rejoin on `resume`.
    public func suspend() {
        guard tableID != nil, !suspended else { return }
        suspended = true
        closeSocket()
        status = .idle
    }

    /// The app came back: rejoins at once if the socket was let go or has dropped.
    public func resume() {
        guard suspended || status == .closed else { return }
        suspended = false
        guard tableID != nil else { return }
        closeSocket()
        open()
    }

    /// The network path changed (Wi-Fi to cellular, or back): the old socket's path is
    /// gone, so rejoin at once on the new one rather than waiting for it to time out.
    public func networkChanged() {
        guard tableID != nil, !suspended else { return }
        closeSocket()
        open()
    }

    // MARK: - Sending

    /// Acts on the current view's turn, with its `seq`. False when it is not the guest's
    /// turn, the socket is not open, or an action is already on its way.
    @discardableResult
    public func act(_ action: ActionKind, amount: Int? = nil) -> Bool {
        guard let view, view.you.legal != nil else { return false }
        return send(.act(ActMessage(tableID: view.tableID, seq: view.seq, action: action, amount: amount)), isAction: true)
    }

    /// Sits in the seat held for the guest, buying in for `buyIn`.
    @discardableResult
    public func sit(seat: Int, buyIn: Int) -> Bool {
        guard let tableID else { return false }
        return send(.sit(SitMessage(tableID: tableID, seat: seat, buyIn: buyIn)), isAction: false)
    }

    @discardableResult
    public func sitOut() -> Bool {
        guard let tableID else { return false }
        return send(.sitOut(SitOutMessage(tableID: tableID)), isAction: false)
    }

    @discardableResult
    public func sitIn() -> Bool {
        guard let tableID else { return false }
        return send(.sitIn(SitInMessage(tableID: tableID)), isAction: false)
    }

    @discardableResult
    public func rebuy(_ amount: Int) -> Bool {
        guard let tableID else { return false }
        return send(.rebuy(RebuyMessage(tableID: tableID, amount: amount)), isAction: false)
    }

    /// A fresh practice stack, for a guest out of chips at a practice table.
    @discardableResult
    public func refill() -> Bool {
        guard let view, view.practice == true else { return false }
        return rebuy(view.settings.maxBuyIn)
    }

    /// Sends a preset reaction from the guest's seat (Q-4: there is no free text).
    @discardableResult
    public func react(_ reaction: Reaction) -> Bool {
        guard let tableID else { return false }
        return send(.react(ReactMessage(tableID: tableID, reaction: reaction)), isAction: false)
    }

    /// Shows a short message, as for a refused request.
    public func notify(_ text: String) {
        notices += 1
        notice = Notice(id: notices, text: text)
    }

    /// Takes a reaction away from a seat at once, as after muting its player.
    public func clearReaction(seat: Int) {
        reactionTimers.removeValue(forKey: seat)?()
        reactions.removeValue(forKey: seat)
    }

    private func send(_ message: ClientMessage, isAction: Bool) -> Bool {
        guard let socket, connected, !(isAction && pending),
              let text = try? String(decoding: JSONEncoder().encode(message), as: UTF8.self)
        else { return false }
        if isAction { pending = true }
        enqueue(text, on: socket)
        return true
    }

    private func enqueue(_ text: String, on socket: any TableSocket) {
        let previous = sending
        sending = Task {
            await previous?.value
            try? await socket.send(text)
        }
    }

    // MARK: - The socket

    private func open() {
        guard let tableID else { return }
        let socket = makeSocket(client.webSocketRequest("/ws"))
        self.socket = socket
        joins += 1
        status = .connecting
        reader = Task { [weak self] in
            do {
                try await socket.open()
                guard let self, self.socket === socket else { return }
                let hello = String(decoding: try JSONEncoder().encode(HelloMessage.first), as: UTF8.self)
                let join = String(
                    decoding: try JSONEncoder().encode(ClientMessage.joinTable(JoinTableMessage(tableID: tableID))),
                    as: UTF8.self)
                self.sending = nil
                self.enqueue(hello, on: socket)
                self.enqueue(join, on: socket)
                self.connected = true
                while true {
                    let text = try await socket.receive()
                    guard self.socket === socket else { return }
                    self.receive(text)
                }
            } catch {
                self?.closed(socket, tableID: tableID)
            }
        }
    }

    private func closed(_ closing: any TableSocket, tableID: String) {
        guard socket === closing else { return }
        socket = nil
        reader = nil
        connected = false
        pending = false
        guard self.tableID != nil else { return }
        status = .closed
        let delay = Self.backoff(retries)
        retries += 1
        cancelRetry = schedule(delay) { [weak self] in
            guard let self else { return }
            self.cancelRetry = nil
            if self.tableID == tableID, self.socket == nil, !self.suspended { self.open() }
        }
    }

    private func closeSocket() {
        cancelRetry?()
        cancelRetry = nil
        let closing = socket
        socket = nil
        sending = nil
        reader?.cancel()
        reader = nil
        closing?.close()
        connected = false
        pending = false
        retries = 0
    }

    private func stop() {
        autoSit = nil
        closeSocket()
        memory?.save(nil)
        tableID = nil
        view = nil
        log = []
        clearReactions()
        status = .idle
        suspended = false
    }

    private func clearReactions() {
        for cancel in reactionTimers.values { cancel() }
        reactionTimers = [:]
        reactions = [:]
    }

    // MARK: - Receiving

    /// The name in the event's seat when it happened: before this change, unless it is the arrival.
    static func whoWas(_ event: TableEvent, before: TableView?, after: TableView) -> String? {
        guard let seat = event.seat else { return nil }
        if event.kind == .seated, let name = event.name, !name.isEmpty { return name }
        func name(_ view: TableView?) -> String? {
            guard let view, seat >= 0, seat < view.seats.count else { return nil }
            return view.seats[seat]?.name
        }
        return name(before) ?? name(after)
    }

    func receive(_ text: String) {
        guard let message = try? JSONDecoder().decode(ServerMessage.self, from: Data(text.utf8)) else { return }
        switch message {
        case let .welcome(welcome):
            player = welcome
        case let .table(table):
            guard table.tableID == tableID else { return }
            retries = 0
            status = .open
            pending = false
            let before = view?.tableID == table.tableID ? view : nil
            view = table.view
            clockOffset = now() - table.view.serverTime
            sitWhenReady(table.view)
            if !table.events.isEmpty {
                let logged = table.events.map {
                    LoggedEvent(event: $0, who: Self.whoWas($0, before: before, after: table.view))
                }
                log = Array((log + logged).suffix(Self.logLimit))
            }
            onTable?(table)
        case let .reaction(reaction):
            guard reaction.tableID == tableID else { return }
            reactionIDs += 1
            let id = reactionIDs
            let seat = reaction.seat
            reactionTimers.removeValue(forKey: seat)?()
            reactions[seat] = ShownReaction(id: id, ref: reaction.ref, text: reaction.text)
            reactionTimers[seat] = schedule(Self.reactionSeconds) { [weak self] in
                guard let self, self.reactions[seat]?.id == id else { return }
                self.reactionTimers.removeValue(forKey: seat)
                self.reactions.removeValue(forKey: seat)
            }
        case .leftTable:
            return
        case let .tableClosed(closed):
            guard closed.tableID == tableID else { return }
            stop()
            closedMessage = closed.message
        case let .error(error):
            pending = false
            if error.code == .unknownTable {
                stop()
                closedMessage = Self.closedTableMessage
                return
            }
            if error.code == .unauthorized {
                player = nil
                stop()
                closedMessage = error.message
                return
            }
            notify(error.message)
            // The view may have moved on while the action was on its way (but a refused
            // reaction or a flood changed nothing). Never send the action again: the
            // guest decides on the fresh view.
            if let tableID, error.code != .rateLimited, error.code != .notSeated {
                _ = send(.refresh(RefreshMessage(tableID: tableID)), isAction: false)
            }
        case .unknown:
            return
        }
    }

    private func sitWhenReady(_ view: TableView) {
        guard let auto = autoSit else { return }
        guard view.you.seat == nil, let hold = view.you.hold else {
            // Seated, or the hold is gone (it ran out, or was given up).
            autoSit = nil
            return
        }
        guard hold.ready else { return }
        autoSit = nil
        let most = view.settings.maxBuyIn
        sit(seat: hold.seat, buyIn: auto.buyIn ?? min(most, balance ?? most))
    }
}
