import RiverMindKit
import SwiftUI

/// The table (P5D.7), the site's `NlTable.svelte` drawn natively for a phone held upright.
///
/// The first screen is the game: the bar, the table and, at the foot, a zone as tall as the
/// action panel, which never change size. The seat tools sit at the top of the zone and the
/// line about the hand under them; on the guest's turn the action panel covers the zone, its
/// Fold, Call and Raise in a row at the foot, where no other control ever is, so nothing
/// moves under a finger when the turn comes round. The hand log, the seat menu, the rebuy
/// and the reactions open over the table as sheets and menus, never pushing it.
struct TableScreen: View {
    let model: LobbyModel
    let table: TableConnection
    @State private var tableModel: TableModel?

    var body: some View {
        Group {
            if let tableModel {
                TableContent(lobby: model, model: tableModel, table: table)
            } else {
                Color.clear
            }
        }
        .task(id: table.tableID) {
            let made = TableModel(connection: table, client: model.client)
            tableModel = made
            await made.load(config: model.config)
        }
        // A container, so the controls inside keep identifiers of their own.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("table.screen")
        .kitPage()
    }
}

/// The zone's height: the action panel's, which fits the sizing rows and the main buttons.
enum TableMetrics {
    static let bar = 44.0
    static let zone = 184.0
    static let main = 60.0
    static let gap = 8.0
}

struct TableContent: View {
    let lobby: LobbyModel
    @Bindable var model: TableModel
    let table: TableConnection

    @State private var showingLog = false
    @State private var menuSeat: Int?
    @State private var rebuying = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            TableBar(lobby: lobby, model: model, table: table, showingLog: $showingLog)
                .frame(height: TableMetrics.bar)
            if let view = table.view {
                TableArena(view: view, model: model, table: table) { seat in
                    model.forgetReport()
                    menuSeat = seat
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .top) { NoticeBanner(notice: table.notice) }
            } else {
                ProgressView("Joining the table")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("table.joining")
            }
        }
        // The zone is pinned to the foot of the safe area, and the table takes what is left,
        // so the main buttons stand in the same place whatever the table holds.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let view = table.view {
                TableZone(lobby: lobby, model: model, table: table, view: view, rebuying: $rebuying)
                    .frame(height: TableMetrics.zone)
            }
        }
        .padding(.horizontal, 4)
        // The keyboard covers the zone rather than moving the table; the amount it edits is
        // shown above it (`ActionPanelView`).
        .ignoresSafeArea(.keyboard)
        .animation(reduceMotion ? nil : .easeOut(duration: Motion.drop.duration), value: table.view?.hand?.board)
        .sensoryFeedback(.impact(weight: .medium), trigger: turnKey) { old, new in new != nil && new != old }
        .sheet(isPresented: $showingLog) {
            HandLogSheet(table: table)
                .presentationDetents([.medium, .large])
        }
        .sheet(item: $menuSeat) { seat in
            SeatMenu(model: model, table: table, seat: seat)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $rebuying) {
            RebuySheet(table: table)
                .presentationDetents([.height(260)])
        }
        .onChange(of: table.view?.seats.compactMap { $0?.ref }) { _, refs in
            // The menu closes when its player leaves the seat.
            if let seat = menuSeat, table.view?.seats[safe: seat]??.kind != .human { menuSeat = nil }
            _ = refs
        }
    }

    /// The turn the guest is to act on, for the haptic that marks its start.
    private var turnKey: Int? {
        guard let view = table.view, TableWords.myTurn(view) else { return nil }
        return view.turn?.seq
    }
}

extension Int: @retroactive Identifiable {
    public var id: Int { self }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

// MARK: - The bar

/// Leave, invite, the practice tag, the hand's number and street, the blinds, the hand log
/// and the connection's lamp.
struct TableBar: View {
    let lobby: LobbyModel
    let model: TableModel
    let table: TableConnection
    @Binding var showingLog: Bool

    var body: some View {
        let view = table.view
        HStack(spacing: 8) {
            Button {
                table.leave()
            } label: {
                // The way back, as a navigation bar's: the word is for VoiceOver.
                Image(systemName: "chevron.backward")
            }
            .buttonStyle(.kit(small: true))
            .accessibilityLabel(view?.you.seat != nil ? "Leave table" : "Lobby")
            .accessibilityIdentifier("table.leave")
            if let invite = view?.invite, let link = URL(string: inviteLink(invite)) {
                ShareLink(
                    item: link, subject: Text("RiverMind Poker"),
                    message: Text("Join my private table at RiverMind Poker (play money only).")
                ) {
                    Text("Invite")
                }
                .buttonStyle(.kit(small: true))
                .accessibilityIdentifier("table.invite")
            }
            if view?.practice == true {
                Text("Practice")
                    .font(.system(size: Metrics.textS, weight: .semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Palette.gold.color, in: .capsule)
                    .foregroundStyle(Palette.ink.color)
                    .fixedSize()
                    .accessibilityLabel("Practice: your wallet is not touched")
            }
            // The site's bar capitalizes each word of the street (“Pre-Flop”).
            Text(view.map { TableWords.handLine($0).capitalized } ?? "")
                .font(.system(size: Metrics.textS))
                .foregroundStyle(Palette.mist.color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity)
                .accessibilityLabel(view?.hand.map { "Hand #\($0.handNo), \($0.street.rawValue)" } ?? "Waiting for players")
                .accessibilityIdentifier("table.hand")
            if let view {
                HStack(spacing: 4) {
                    ArtView(named: "chip-red").frame(width: 14, height: 14)
                    Text("\(view.settings.smallBlind)/\(view.settings.bigBlind)")
                        .font(.system(size: Metrics.textS))
                        .foregroundStyle(Palette.paperShade.color)
                }
                .fixedSize()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    "Blinds \(view.settings.smallBlind)/\(view.settings.bigBlind), \(view.settings.seatCount) seats"
                        + (view.practice == true ? ", practice chips" : ""))
                .accessibilityIdentifier("table.stakes")
            }
            Button {
                showingLog = true
            } label: {
                Image(systemName: "list.bullet.rectangle")
            }
            .buttonStyle(.kit(small: true))
            .accessibilityLabel("Hand log")
            .accessibilityIdentifier("table.logButton")
            Lamp(status: table.status, suspended: table.suspended, joins: table.joins)
        }
        .padding(.horizontal, 4)
    }

    private func inviteLink(_ code: String) -> String {
        LobbyWords.inviteLink(origin: lobby.server.origin.absoluteString, code: code)
    }
}

/// The connection's lamp: green when the table is live, amber while it rejoins.
struct Lamp: View {
    let status: ConnectionStatus
    let suspended: Bool
    let joins: Int

    var body: some View {
        Circle()
            .fill(status == .open ? Palette.green.color : status == .connecting ? Palette.amber.color : Palette.red.color)
            .frame(width: 10, height: 10)
            .padding(4)
            .accessibilityElement()
            .accessibilityLabel("Connection, \(word)")
            #if DEBUG
                // The UI tests count the sockets the connection opened (P5D.3).
                .accessibilityValue("Joins \(joins)")
            #endif
            .accessibilityIdentifier("table.status")
    }

    private var word: String {
        switch status {
        case .idle: suspended ? "suspended" : "idle"
        case .connecting: "connecting"
        case .open: "open"
        case .closed: "closed"
        }
    }
}

/// A short message over the top of the table, such as a refused request, gone after a while.
struct NoticeBanner: View {
    let notice: Notice?
    @State private var shown: Notice?

    var body: some View {
        Group {
            if let shown {
                Text(shown.text)
                    .font(.system(size: Metrics.textS))
                    .foregroundStyle(Palette.paper.color)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .kitFrame(.danger)
                    .padding(.top, 6)
                    .padding(.horizontal, 16)
                    .accessibilityIdentifier("table.notice")
                    .transition(.opacity)
            }
        }
        .allowsHitTesting(false)
        .task(id: notice) {
            shown = notice
            guard notice != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { shown = nil }
        }
    }
}

// MARK: - The zone

/// The foot of the screen: the seat tools and the line about the hand, the join panel for
/// someone watching, the refill at a practice table, or on the guest's turn the action panel
/// over all of it.
struct TableZone: View {
    let lobby: LobbyModel
    let model: TableModel
    let table: TableConnection
    let view: TableView
    @Binding var rebuying: Bool

    var body: some View {
        ZStack(alignment: .bottom) {
            if TableWords.me(view) == nil {
                JoinPanel(lobby: lobby, model: model, table: table, view: view)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                VStack(spacing: TableMetrics.gap) {
                    SeatTools(model: model, table: table, view: view, rebuying: $rebuying)
                        .frame(height: ButtonPalette.smallHeight)
                    DockLine(table: table, view: view)
                    Spacer(minLength: 0)
                }
                .padding(.top, 6)
                if let legal = view.you.legal, let hand = view.hand, let turn = view.turn {
                    ActionPanelView(
                        legal: legal, hand: hand, turnSeq: turn.seq,
                        disabled: !table.connected || table.pending
                    ) { action, amount in
                        table.act(action, amount: amount)
                    }
                    .transition(.opacity)  // it never slides: nothing moves under a finger
                }
            }
        }
    }
}

/// The line about the hand while it is not the guest's turn, and the refill at a practice
/// table once out of chips. It stands above the main buttons' row, never in it.
struct DockLine: View {
    let table: TableConnection
    let view: TableView

    var body: some View {
        if TableWords.busted(view) && view.practice == true {
            VStack(spacing: 6) {
                Text("You are out of practice chips.")
                    .font(.system(size: Metrics.textS))
                    .foregroundStyle(Palette.mist.color)
                Button(TableWords.refillText(view)) { table.refill() }
                    .buttonStyle(.kit(.amber, small: true))
                    .disabled(!table.connected)
                    .accessibilityIdentifier("table.refill")
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Out of practice chips")
            .accessibilityIdentifier("table.outOfChips")
        } else {
            Text(TableWords.dockLine(view))
                .font(.system(size: Metrics.textS))
                .foregroundStyle(Palette.mist.color)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 20)
                .accessibilityIdentifier("table.dock")
        }
    }
}

/// Sit out or back in, the practice opponent, the reactions and the rebuy, in one row.
struct SeatTools: View {
    let model: TableModel
    let table: TableConnection
    let view: TableView
    @Binding var rebuying: Bool

    var body: some View {
        HStack(spacing: 6) {
            if view.you.sittingOut || view.you.sittingOutNext {
                Button("I’m back") { table.sitIn() }
                    .buttonStyle(.kit(.green, small: true))
                    .accessibilityIdentifier("table.sitIn")
            } else {
                Button("Sit out") { table.sitOut() }
                    .buttonStyle(.kit(small: true))
                    .accessibilityLabel("Sit out next hand")
                    .accessibilityIdentifier("table.sitOut")
            }
            if view.practice == true && model.opponents.count > 1 {
                Menu {
                    ForEach(model.opponents) { option in
                        let current = option.kind == (model.asked ?? model.opponent)
                        Button {
                            Task { await model.playAgainst(option.kind) }
                        } label: {
                            if current { Label(option.label, systemImage: "checkmark") } else { Text(option.label) }
                        }
                        .disabled(!table.connected || current)
                    }
                } label: {
                    Text("Opponent")
                }
                .buttonStyle(.kit(small: true))
                .accessibilityIdentifier("table.opponent")
            }
            Menu {
                ForEach(Safety.reactions, id: \.kind) { option in
                    Button(option.text) { table.react(option.kind) }
                }
            } label: {
                Text("React")
            }
            .buttonStyle(.kit(small: true))
            .disabled(!table.connected)
            .accessibilityIdentifier("table.react")
            if TableWords.rebuyRoom(view) > 0, TableWords.me(view)?.leaving == false, view.practice != true {
                Button("Rebuy") { rebuying = true }
                    .buttonStyle(.kit(small: true))
                    .accessibilityIdentifier("table.rebuy")
            }
            if let pending = TableWords.pendingRebuyText(view) {
                Text(pending)
                    .font(.system(size: Metrics.textXS))
                    .foregroundStyle(Palette.greenLight.color)
                    .accessibilityIdentifier("table.pendingRebuy")
            } else if let arriving = model.arriving {
                Text("\(arriving.label) sits down after this hand")
                    .font(.system(size: Metrics.textXS))
                    .foregroundStyle(Palette.greenLight.color)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// For someone without a seat: a held seat to buy into, a place in line, or watching.
struct JoinPanel: View {
    let lobby: LobbyModel
    let model: TableModel
    let table: TableConnection
    let view: TableView
    @State private var buyIn = 0

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let now = context.date.timeIntervalSince1970 - table.clockOffset
            let holdLeft = view.you.hold?.until.map { max(0, Int(($0 - now).rounded(.up))) }
            let balance = table.balance ?? lobby.balance
            let short = balance.map { $0 < view.settings.minBuyIn } ?? false
            VStack(spacing: 8) {
                Text(TableWords.joinLine(view, holdLeft: holdLeft, short: short))
                    .font(.system(size: Metrics.textS))
                    .foregroundStyle(Palette.mist.color)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("table.you")
                buttons(short: short, balance: balance)
            }
            .padding(10)
            .frame(maxWidth: .infinity)
            .kitFrame(.inset)
            .padding(.top, 6)
        }
    }

    @ViewBuilder private func buttons(short: Bool, balance: Int?) -> some View {
        if let hold = view.you.hold, hold.ready {
            HStack(spacing: 8) {
                TextField("Buy-in", value: $buyIn, format: .number)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
                    .textFieldStyle(KitFieldStyle())
                    .frame(width: 110)
                    .accessibilityLabel("Buy-in")
                    .accessibilityIdentifier("table.buyIn")
                Button("Sit down") { table.sit(seat: hold.seat, buyIn: buyIn) }
                    .buttonStyle(.kit(.amber, small: true))
                    .disabled(short || !table.connected)
                    .accessibilityIdentifier("table.sitDown")
                Button("Give up") { Task { await model.giveUpHold() } }
                    .buttonStyle(.kit(small: true))
                    .disabled(model.busy)
            }
            Text(TableWords.buyInHint(view))
                .font(.system(size: Metrics.textXS))
                .foregroundStyle(Palette.haze.color)
                .onAppear {
                    let most = min(view.settings.maxBuyIn, balance ?? .max)
                    buyIn = max(view.settings.minBuyIn, most)
                }
        } else if view.you.hold != nil {
            Button("Give up the seat") { Task { await model.giveUpHold() } }
                .buttonStyle(.kit(small: true))
                .disabled(model.busy)
                .accessibilityIdentifier("table.giveUp")
        } else if view.you.waitlistPosition != nil {
            Button("Leave the line") { Task { await lobby.leaveWaitlist(at: view.tableID) } }
                .buttonStyle(.kit(small: true))
                .accessibilityIdentifier("table.leaveLine")
        } else {
            let room = TableWords.hasSeatRoom(view)
            Button(room ? "Sit down" : "Join the waitlist") {
                Task {
                    if room {
                        await lobby.takeSeat(at: view.tableID, on: table)
                    } else {
                        _ = await lobby.joinWaitlist(at: view.tableID)
                    }
                }
            }
            .buttonStyle(.kit(.amber, small: true))
            .disabled(short || lobby.busy != nil)
            .accessibilityIdentifier("table.sit")
        }
    }
}
