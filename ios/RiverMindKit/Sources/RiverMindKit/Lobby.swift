import Foundation
import Observation

/// The lobby (P5D.6), as the site's `NlLobby.svelte` and `LobbyTables.svelte` have it:
/// the guest and their wallet, one-click practice against each labelled bot, the open
/// tables with the seat and blind filters, quick seat, sitting down, holds and the
/// waitlist, the new-table form with private tables and their invites, and an invite
/// a friend sent. It makes or renews the guest and reads what the server offers first.
/// Every request goes through `APIClient`, one for each thing the guest does, and the
/// table list is read again every few seconds while the lobby is on screen, as a page's is.
@MainActor
@Observable
public final class LobbyModel {
    public enum State: Equatable, Sendable {
        case loading
        case ready(ConfigResponse, guest: SessionResponse)
        /// The server no longer serves this build (P5D.11): it names the oldest it does.
        case updateNeeded(oldest: Int)
        /// The guest was deleted (P5D.11); `erased` is false while a hand under way still
        /// held their seat, whose chips and data go when it ends.
        case deleted(erased: Bool)
        case failed(String)
    }

    public private(set) var state: State = .loading
    public let server: Server
    /// Play chips in the wallet, once known.
    public private(set) var balance: Int?
    /// The open tables that match `filters`, once read.
    public private(set) var tables: [TableSummary]?
    /// The table list's filters; setting them reads the list again.
    public var filters = TableFilters() {
        didSet { if filters != oldValue { tablesTask?.cancel(); tablesTask = Task { await refreshTables() } } }
    }
    /// The new-table form's choices.
    public var form = NewTableForm()
    /// What the guest asked for that is still on its way, so its button can say so.
    public private(set) var busy: Busy?
    /// The last request the server refused or that failed, in words.
    public private(set) var error: String?
    /// An invite the guest opened, and the table it is for once read.
    public private(set) var invite: InviteState?
    private var tablesTask: Task<Void, Never>?

    /// What is on its way.
    public enum Busy: Sendable, Hashable {
        case practice(bot: String?)
        case quickSeat
        case table(String)
        case newTable
        case invite
    }

    /// An invite code, and what the server said of it.
    public struct InviteState: Sendable, Hashable {
        public var code: String
        public var table: TableSummary?
        public var error: String?
    }
    private let client: APIClient
    /// The build checked against the server's oldest: this one, or in a debug build's
    /// UI test an older one it pretends to be.
    private let build: Int

    public init(client: APIClient, build: Int = AppBuild.number) {
        self.client = client
        self.server = client.server
        self.build = build
    }

    /// One-click practice (P6.0b): the guest's practice table, followed by `table`, heads-up
    /// against RiverMind Easy or the trained bot `bot` (P5.7a), whatever the wallet holds.
    public func practice(bot: String? = nil, on table: TableConnection) async throws {
        let started = try await client.practice(PracticeRequest(bot: bot))
        if table.tableID != started.tableID || table.status == .idle { table.follow(started.tableID) }
    }

    /// The lobby's practice button: as `practice`, with its failure shown.
    public func startPractice(bot: String? = nil, on table: TableConnection) async {
        await run(.practice(bot: bot)) { try await self.practice(bot: bot, on: table) }
    }

    // MARK: - The wallet and the tables

    /// `GET /api/wallet`: the balance, for the buy-ins and the list's “Sit down”.
    public func refreshWallet() async {
        guard let wallet = try? await client.wallet() else { return }
        balance = wallet.balance
    }

    /// `GET /api/tables` with the filters. An answer to filters that have changed since is
    /// dropped, as the page drops it.
    public func refreshTables() async {
        let asked = filters
        do {
            let listed = try await client.tables(
                seats: asked.seats, bigBlind: asked.bigBlind, open: asked.openOnly ? true : nil)
            if asked == filters { tables = listed.tables }
        } catch is CancellationError {
            return
        } catch {
            if asked == filters { self.error = "Could not load the tables: \(error.localizedDescription)" }
        }
    }

    /// Reads the table list every `seconds` until the task is cancelled, as a page does
    /// while its lobby shows (`LobbyTables.svelte`, every 3 seconds).
    public func watchTables(every seconds: Double = 3) async {
        while !Task.isCancelled {
            await refreshTables()
            try? await Task.sleep(for: .seconds(seconds))
        }
    }

    /// Quick seat: the busiest table that fits the filters, or a new one with bots.
    public func quickSeat(on table: TableConnection) async {
        await run(.quickSeat) {
            let seat = try await self.client.quickSeat(
                QuickSeatRequest(seats: self.filters.seats, bigBlind: self.filters.bigBlind))
            self.arrive(seat, on: table)
        }
    }

    /// “Sit down” at a listed or invited table: a seat now, or held until a bot there
    /// finishes its hand, and taken as soon as it is ready.
    public func takeSeat(at id: String, invite code: String? = nil, on table: TableConnection) async {
        await run(.table(id)) {
            let seat = try await self.client.takeSeat(table: id, SeatRequest(invite: code))
            self.arrive(seat, on: table)
        }
    }

    /// “Give up” a seat held at a listed table.
    public func giveUpHold(at id: String) async {
        await run(.table(id)) { try await self.client.giveUpSeat(table: id) }
    }

    /// “Join the waitlist” of a full table; a seat is held for the guest when one opens.
    @discardableResult
    public func joinWaitlist(at id: String, invite code: String? = nil) async -> Int? {
        var position: Int?
        await run(.table(id)) {
            position = try await self.client.joinWaitlist(
                table: id, WaitlistRequest(invite: code)
            ).position
        }
        return position
    }

    /// “Leave the line”.
    public func leaveWaitlist(at id: String) async {
        await run(.table(id)) { try await self.client.leaveWaitlist(table: id) }
    }

    /// “Watch” a listed table, or go back to the guest's seat there.
    public func watch(_ id: String, on table: TableConnection) {
        table.follow(id)
    }

    /// “Sit down” on the new-table form: a table with the form's choices, the guest in seat 0.
    public func newTable(_ config: ConfigResponse, on table: TableConnection) async {
        let request = form.normalized(config: config, balance: balance).request
        await run(.newTable) {
            let created = try await self.client.newTable(request)
            table.follow(created.tableID)
            await self.refreshWallet()
        }
    }

    // MARK: - Invites

    /// Opens an invite from a link or a code: reads the table it is for (`GET /api/invites`).
    public func openInvite(_ code: String) async {
        invite = InviteState(code: code)
        do {
            let listed = try await client.invite(code)
            if invite?.code == code { invite?.table = listed }
        } catch is CancellationError {
            return
        } catch {
            if invite?.code == code { invite?.error = error.localizedDescription }
        }
    }

    /// Takes a seat at the invited table, or joins its waitlist when it is full.
    public func acceptInvite(on table: TableConnection) async {
        guard let state = invite, let listed = state.table else { return }
        if LobbyWords.hasRoom(listed) || listed.hold != nil {
            await takeSeat(at: listed.tableID, invite: state.code, on: table)
            if error == nil { invite = nil }
        } else if await joinWaitlist(at: listed.tableID, invite: state.code) != nil {
            await openInvite(state.code)
        }
    }

    /// Puts the invite away.
    public func dismissInvite() {
        invite = nil
    }

    // MARK: - Running a request

    private func arrive(_ seat: SeatResponse, on table: TableConnection) {
        table.balance = balance
        table.arrive(seat, buyIn: nil)
        Task { await refreshWallet() }
    }

    /// Runs what the guest asked for with its button marked busy, and shows a refusal or a
    /// failure in words. The table list is read again afterwards.
    private func run(_ what: Busy, _ work: @escaping @MainActor () async throws -> Void) async {
        busy = what
        error = nil
        defer { busy = nil }
        do {
            try await work()
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
        await refreshTables()
    }

    /// `GET /api/config`, then `POST /api/session`, as a page does on load. The config
    /// comes first so that a build the server no longer serves asks to be updated before
    /// it makes a guest.
    public func load() async {
        state = .loading
        do {
            let config = try await client.config()
            guard AppBuild.isSupported(by: config, build: build) else {
                state = .updateNeeded(oldest: config.oldestAppBuild ?? AppBuild.number)
                return
            }
            let guest = try await client.startSession()
            balance = guest.balance
            form = form.normalized(config: config, balance: guest.balance)
            state = .ready(config, guest: guest)
        } catch is CancellationError {
            return
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Deletes this guest and their data (P5D.11), after the screen has asked twice. The
    /// table connection lets go of the table first, so it does not try to rejoin.
    public func deleteGuest(leaving table: TableConnection? = nil) async {
        table?.disconnect()
        do {
            let answer = try await client.deleteGuest()
            table?.forgetTable()
            state = .deleted(erased: answer.erased)
        } catch is CancellationError {
            return
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

/// The table list's filters (`LobbyTables.svelte`): nil is “Any”.
public struct TableFilters: Sendable, Hashable {
    public var seats: Int?
    public var bigBlind: Int?
    /// Only tables with a seat a person can take.
    public var openOnly = false

    public init(seats: Int? = nil, bigBlind: Int? = nil, openOnly: Bool = false) {
        self.seats = seats
        self.bigBlind = bigBlind
        self.openOnly = openOnly
    }
}

/// The new-table form (`NlLobby.svelte`): its defaults, and the rules that keep its
/// choices to what the server offers and the wallet covers.
public struct NewTableForm: Sendable, Hashable {
    /// The kind `bots` takes for a table that waits for people.
    public static let noBots = "none"

    public var seats = 6
    /// A bot kind, or `noBots` to leave the other seats for people.
    public var bots = "heuristic"
    public var isPrivate = false
    public var bigBlind = 100
    /// The buy-in in big blinds, one of `LobbyWords.buyIns`.
    public var buyInBlinds = 100

    public init() {}

    /// The buy-ins the wallet covers at the chosen blinds.
    public func affordable(balance: Int?) -> [Int] {
        LobbyWords.affordableBuyIns(bigBlind: bigBlind, balance: balance)
    }

    /// The form with its choices kept to what is offered, as the page's effects keep them:
    /// seats and blinds the server offers, a bot that plays the chosen size (RiverMind
    /// Easy when the chosen one does not), and the largest buy-in the wallet covers when
    /// the chosen one is more than it holds.
    public func normalized(config: ConfigResponse, balance: Int?) -> NewTableForm {
        var form = self
        if !config.seatCounts.contains(form.seats), let fallback = config.seatCounts.last(where: { $0 <= 6 })
            ?? config.seatCounts.first
        {
            form.seats = fallback
        }
        if !config.stakes.contains(where: { $0.bigBlind == form.bigBlind }),
           let first = config.stakes.first(where: { $0.bigBlind == 100 }) ?? config.stakes.first
        {
            form.bigBlind = first.bigBlind
        }
        let offered = LobbyWords.bots(config.bots, for: form.seats)
        if form.bots != Self.noBots, !offered.contains(where: { $0.kind == form.bots }) {
            form.bots = offered.first { $0.kind == "heuristic" }?.kind ?? offered.first?.kind ?? Self.noBots
        }
        let affordable = form.affordable(balance: balance)
        if let most = affordable.last, !affordable.contains(form.buyInBlinds) { form.buyInBlinds = most }
        return form
    }

    /// `POST /api/tables`'s body. No bots is an explicit null: a missing `bots` would be
    /// the server's default bot.
    public var request: NewTableRequest {
        NewTableRequest(
            seats: seats, bots: bots == Self.noBots ? nil : bots, bigBlind: bigBlind,
            buyIn: buyInBlinds * bigBlind, isPrivate: isPrivate, nulls: bots == Self.noBots ? [.bots] : [])
    }
}

extension ConfigResponse {
    /// Blinds as the lobby's form writes them, such as `500/1000`, ungrouped (`NlLobby.svelte`).
    public static func blinds(_ stakes: Stakes) -> String {
        "\(stakes.smallBlind)/\(stakes.bigBlind)"
    }

    /// A chip count grouped by commas, as the site's `toLocaleString('en-US')` writes it.
    public static func chips(_ amount: Int) -> String {
        let digits = String(amount.magnitude)
        var grouped = ""
        for (index, digit) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { grouped.append(",") }
            grouped.append(digit)
        }
        return amount < 0 ? "-" + grouped : grouped
    }
}
