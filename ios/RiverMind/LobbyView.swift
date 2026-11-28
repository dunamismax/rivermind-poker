import RiverMindKit
import SwiftUI

/// The app's root: the lobby, or the table the guest follows.
struct RootView: View {
    let model: LobbyModel
    let table: TableConnection

    var body: some View {
        Group {
            if table.tableID != nil {
                TableScreen(model: model, table: table)
            } else {
                LobbyView(model: model, table: table)
            }
        }
        .task { await model.load() }
        // An invite link opens the lobby at it (P5D.8 makes the site's links open the app).
        .onOpenURL { url in
            guard let code = LobbyWords.inviteCode(in: url.absoluteString) else { return }
            Task { await model.openInvite(code) }
        }
        #if DEBUG
            // `-practice` sits the guest at their practice table at launch, for the UI tests.
            .task(id: model.isReady) {
                guard model.isReady, ProcessInfo.processInfo.arguments.contains("-practice"),
                      table.tableID == nil
                else { return }
                await model.startPractice(on: table)
            }
            // `RIVERMIND_TABLE_SEATS=n` (and `RIVERMIND_TABLE_BOTS=kind`) sits the guest at a new
            // table of n seats with bots at launch, for the table's UI tests and screenshots.
            .task(id: model.isReady) {
                let environment = ProcessInfo.processInfo.environment
                guard model.isReady, let seats = environment["RIVERMIND_TABLE_SEATS"].flatMap(Int.init),
                      let config = model.config
                else { return }
                await leaveRejoined(but: nil)
                model.form.seats = seats
                model.form.bots = environment["RIVERMIND_TABLE_BOTS"] ?? "calling_station"
                model.form.buyInBlinds = Int(environment["RIVERMIND_TABLE_BUY_IN"] ?? "") ?? 100
                await model.newTable(config, on: table)
            }
            // `RIVERMIND_JOIN_TABLE=id` takes a seat at that table at launch, for the UI tests.
            .task(id: model.isReady) {
                guard model.isReady, let id = ProcessInfo.processInfo.environment["RIVERMIND_JOIN_TABLE"]
                else { return }
                await leaveRejoined(but: id)
                await model.takeSeat(at: id, on: table)
            }
        #endif
    }

    #if DEBUG
        /// Leaves the table a launch rejoined, which an earlier run may have left, unless it is
        /// `keep`. The leave goes once the socket is open, or the server would never hear it
        /// and keep the guest's chips at that table.
        private func leaveRejoined(but keep: String?) async {
            guard let rejoined = table.tableID, rejoined != keep else { return }
            for _ in 0..<100 where table.status != .open && table.tableID != nil {
                try? await Task.sleep(for: .milliseconds(100))
            }
            if table.tableID != nil { table.leave() }
            await model.refreshWallet()
        }
    #endif
}

/// The lobby (P5D.6), as the site's has it: practice first, then the guest's chips, the
/// open tables with quick seat and the filters, and a new table of the guest's own.
struct LobbyView: View {
    let model: LobbyModel
    let table: TableConnection
    #if DEBUG
        /// The gallery is pushed from the stack's own state, not a link's: a link in the
        /// toolbar is replaced when the lobby finishes loading, which popped a gallery
        /// opened before that (CI, iOS 26.5).
        @State private var showingGallery = false
    #endif

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("RiverMind Poker")
                .toolbarTitleDisplayMode(.inlineLarge)
                .scrollContentBackground(.hidden)
                .kitPage()
                #if DEBUG
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                showingGallery = true
                            } label: {
                                Label("Gallery", systemImage: "swatchpalette")
                            }
                            .accessibilityIdentifier("lobby.gallery")
                        }
                    }
                    .navigationDestination(isPresented: $showingGallery) { GalleryView() }
                #endif
        }
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            ProgressView("Finding the tables")
                .accessibilityIdentifier("lobby.loading")
        case let .failed(message):
            ContentUnavailableView {
                Label("No connection", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await model.load() } }
                    .buttonStyle(.borderedProminent)
            }
            .accessibilityIdentifier("lobby.failed")
        case let .ready(config, guest):
            LobbyList(model: model, table: table, config: config, guest: guest)
        case .updateNeeded:
            // P5D.11: a build the server no longer serves asks to be updated instead of failing.
            ContentUnavailableView {
                Label("Update RiverMind Poker", systemImage: "arrow.down.app")
            } description: {
                Text("This version of the app is too old for the tables. Update it from the App Store to keep playing.")
            } actions: {
                if let store = AppStoreLink.url {
                    Link("Open the App Store", destination: store)
                        .buttonStyle(.borderedProminent)
                }
                Button("Try again") { Task { await model.load() } }
            }
            .accessibilityIdentifier("lobby.update")
        case let .deleted(erased):
            ContentUnavailableView {
                Label("Your guest has been deleted", systemImage: "person.crop.circle.badge.xmark")
            } description: {
                Text(
                    erased
                        ? "Its chips, its hands and everything else it had are gone."
                        : "It was in a hand still being played. It checks or folds until the hand ends, and then its chips and everything else it had are gone."
                )
            } actions: {
                Button("Play as a new guest") { Task { await model.load() } }
                    .buttonStyle(.borderedProminent)
            }
            .accessibilityIdentifier("lobby.deleted")
        }
    }
}

extension LobbyModel {
    var isReady: Bool {
        if case .ready = state { true } else { false }
    }
}

/// The lobby's sections, once the server has said what it offers.
struct LobbyList: View {
    let model: LobbyModel
    let table: TableConnection
    let config: ConfigResponse
    let guest: SessionResponse

    var body: some View {
        List {
            Section {
                Text("Play money only: chips can never be bought, sold or cashed out, and have no value. Every bot is labelled as a bot.")
                    .font(.callout)
                    .foregroundStyle(Palette.mist.color)
            }
            if let message = table.closedMessage {
                Section {
                    Label(message, systemImage: "info.circle")
                        .foregroundStyle(Palette.mist.color)
                        .accessibilityIdentifier("lobby.closed")
                }
            }
            if let error = model.error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Palette.redLight.color)
                        .accessibilityIdentifier("lobby.error")
                }
            }
            if model.invite != nil {
                InviteSection(model: model, table: table)
            }
            PracticeSection(model: model, table: table, config: config)
            WalletSection(model: model, guest: guest)
            TablesSection(model: model, table: table, config: config)
            Section {
                NavigationLink {
                    NewTableView(model: model, table: table, config: config)
                } label: {
                    Label("Start a table", systemImage: "plus.circle")
                }
                .accessibilityIdentifier("lobby.newTable")
            } footer: {
                Text("Choose the seats, the bots, the blinds and the buy-in, or make a private table to share.")
            }
            OpenInviteSection(model: model)
            Section {
                NavigationLink {
                    HandsView(lobby: model, table: table)
                } label: {
                    Label("Your hands", systemImage: "rectangle.stack")
                }
                .accessibilityIdentifier("lobby.hands")
                NavigationLink {
                    BotsView(config: config, server: model.server)
                } label: {
                    Label("The bots", systemImage: "cpu")
                }
                .accessibilityIdentifier("lobby.bots")
                NavigationLink {
                    FairnessView(lobby: model, table: table)
                } label: {
                    Label("Rules and fair dealing", systemImage: "checkmark.shield")
                }
                .accessibilityIdentifier("lobby.fairness")
            } footer: {
                Text("Step through any hand you played, see how each bot was measured, and how the cards are dealt.")
            }
            Section {
                Text(model.server.origin.host() ?? model.server.origin.absoluteString)
                    .font(.footnote.monospaced())
                    .foregroundStyle(Palette.haze.color)
                    .accessibilityIdentifier("lobby.server")
            } footer: {
                Text("Protocol \(config.protocolVersion)")
            }
            DeleteGuestSection(model: model, table: table)
        }
        .refreshable {
            await model.refreshWallet()
            await model.refreshTables()
        }
        .task { await model.refreshWallet() }
        // The list is read again every few seconds while the lobby shows, as a page's is.
        .task { await model.watchTables() }
        .accessibilityIdentifier("lobby.ready")
    }
}

// MARK: - Practice

/// One-click practice at any balance (P6.0b), and each trained bot with its published
/// evaluation (D-7, P5.7a).
struct PracticeSection: View {
    let model: LobbyModel
    let table: TableConnection
    let config: ConfigResponse

    var body: some View {
        Section {
            Button {
                Task { await model.startPractice(on: table) }
            } label: {
                Text(model.busy == .practice(bot: nil) ? "Dealing…" : "Practice vs bots")
                    .font(.system(size: Metrics.textL))
            }
            .buttonStyle(.kit(.amber, wide: true))
            .disabled(model.busy != nil)
            .accessibilityIdentifier("lobby.practice")
            .listRowBackground(Palette.deepSlate.color)
            Text(LobbyWords.practiceNote(stack: config.practiceStack))
                .font(.system(size: Metrics.textS))
                .foregroundStyle(Palette.mist.color)
            ForEach(LobbyWords.practiceBots(config.bots)) { bot in
                TrainedBotRow(model: model, table: table, bot: bot)
            }
        } header: {
            Text("Practice")
        }
    }
}

struct TrainedBotRow: View {
    let model: LobbyModel
    let table: TableConnection
    let bot: BotOption

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Avatar(name: Faces.avatar(kind: .bot, bot: bot.kind, name: ""))
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(Text(bot.label).foregroundStyle(Palette.gold.color).bold()) \(LobbyWords.trainedNote(bot.kind))")
                    if let champion = bot.champion {
                        Text(Faces.championLine(champion))
                            .foregroundStyle(Palette.mist.color)
                    }
                    if let config = model.config {
                        NavigationLink("How it was measured") {
                            BotsView(config: config, server: model.server)
                        }
                        .foregroundStyle(Palette.goldLight.color)
                        .accessibilityIdentifier("lobby.measured.\(bot.kind)")
                    }
                }
                .font(.system(size: Metrics.textS))
            }
            Button {
                Task { await model.startPractice(bot: bot.kind, on: table) }
            } label: {
                Text(model.busy == .practice(bot: bot.kind) ? "Dealing…" : "Practice vs \(bot.label)")
                    .multilineTextAlignment(.center)
            }
            .buttonStyle(.kit(.blue, wide: true))
            .disabled(model.busy != nil)
            .accessibilityIdentifier("lobby.practice.\(bot.kind)")
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(bot.label)
    }
}

// MARK: - The wallet

struct WalletSection: View {
    let model: LobbyModel
    let guest: SessionResponse

    var body: some View {
        Section {
            LabeledContent(guest.name, value: "\(ConfigResponse.chips(model.balance ?? guest.balance)) chips")
                .accessibilityIdentifier("lobby.guest")
            HStack(spacing: 8) {
                ArtView(named: "chip-gold").frame(width: 22, height: 22)
                Text(ConfigResponse.chips(model.balance ?? guest.balance))
                    .font(.system(size: Metrics.textL).bold())
                    .foregroundStyle(Palette.gold.color)
                    .accessibilityIdentifier("lobby.wallet")
            }
            .accessibilityElement(children: .combine)
            Text(LobbyWords.walletHint)
                .font(.system(size: Metrics.textS))
                .foregroundStyle(Palette.haze.color)
        } header: {
            Text("Your play chips")
        } footer: {
            // Q-15: a guest here is not the browser's.
            Text("A guest in this app has its own chips, apart from any browser's.")
        }
    }
}

// MARK: - The tables

/// The open tables (P4.3): public ones, and private ones the guest is at, most people first.
struct TablesSection: View {
    let model: LobbyModel
    let table: TableConnection
    let config: ConfigResponse

    var body: some View {
        Section {
            Button {
                Task { await model.quickSeat(on: table) }
            } label: {
                Text(model.busy == .quickSeat ? "Finding a seat…" : "Quick seat")
            }
            .buttonStyle(.kit(.amber, wide: true))
            .disabled(model.busy != nil)
            .accessibilityIdentifier("lobby.quickSeat")
            Text("Quick seat joins the busiest table that fits your filters, or starts one with bots. Bots give up their seats to people.")
                .font(.system(size: Metrics.textS))
                .foregroundStyle(Palette.mist.color)
            Filters(model: model, config: config)
            if let tables = model.tables {
                if tables.isEmpty {
                    Text("No tables match. Quick seat starts one, or set up your own below.")
                        .font(.system(size: Metrics.textS))
                        .foregroundStyle(Palette.mist.color)
                        .accessibilityIdentifier("lobby.noTables")
                }
                ForEach(tables, id: \.tableID) { listed in
                    TableRow(model: model, table: table, listed: listed)
                }
            } else {
                Text("Looking for tables…")
                    .font(.system(size: Metrics.textS))
                    .foregroundStyle(Palette.mist.color)
            }
        } header: {
            Text("Tables")
        }
    }
}

struct Filters: View {
    @Bindable var model: LobbyModel
    let config: ConfigResponse

    var body: some View {
        Picker("Seats", selection: $model.filters.seats) {
            Text("Any").tag(Int?.none)
            ForEach(config.seatCounts, id: \.self) { Text(String($0)).tag(Int?.some($0)) }
        }
        .accessibilityIdentifier("lobby.filter.seats")
        Picker("Blinds", selection: $model.filters.bigBlind) {
            Text("Any").tag(Int?.none)
            ForEach(config.stakes, id: \.bigBlind) { Text(ConfigResponse.blinds($0)).tag(Int?.some($0.bigBlind)) }
        }
        .accessibilityIdentifier("lobby.filter.blinds")
        Toggle("Has a seat", isOn: $model.filters.openOnly)
            .accessibilityIdentifier("lobby.filter.open")
    }
}

/// A listed table: its name and stakes, who sits there, and what the guest can do.
struct TableRow: View {
    let model: LobbyModel
    let table: TableConnection
    let listed: TableSummary

    private var id: String { listed.tableID }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(listed.name).foregroundStyle(Palette.paper.color).lineLimit(1)
                if listed.isPrivate { Tag(text: "Private", colour: Palette.gold, ink: Palette.ink) }
                if listed.blocked { Tag(text: "Blocked player", colour: Palette.redDark, ink: Palette.white) }
            }
            Text(LobbyWords.tableDetail(listed))
                .font(.system(size: Metrics.textS))
                .foregroundStyle(Palette.mist.color)
            HStack(spacing: 8) {
                HStack(spacing: 2) {
                    ForEach(Array(LobbyWords.pips(listed).enumerated()), id: \.offset) { _, pip in
                        PipView(pip: pip)
                    }
                }
                .accessibilityHidden(true)
                Text(LobbyWords.seatsText(listed))
                    .accessibilityIdentifier("lobby.table.\(id).seats")
            }
            .font(.system(size: Metrics.textS))
            .foregroundStyle(Palette.mist.color)
            actions
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lobby.table.\(id)")
    }

    @ViewBuilder private var actions: some View {
        let busy = model.busy != nil
        HStack(spacing: 8) {
            switch LobbyWords.choice(listed, balance: model.balance) {
            case .seated:
                action("Back to your seat", .green, "back") { model.watch(id, on: table) }
            case let .ready(note):
                state(note)
                action("Sit down", .amber, "sit", disabled: busy) {
                    Task { await model.takeSeat(at: id, on: table) }
                }
                action("Give up", .slate, "giveUp", disabled: busy) { Task { await model.giveUpHold(at: id) } }
            case let .held(note):
                state(note)
                action("Go to the table", .slate, "go") { Task { await model.takeSeat(at: id, on: table) } }
            case let .waiting(note):
                state(note)
                action("Leave the line", .slate, "leaveLine", disabled: busy) {
                    Task { await model.leaveWaitlist(at: id) }
                }
            case let .sit(afford):
                action(model.busy == .table(id) ? "Seating…" : "Sit down", .amber, "sit", disabled: busy || !afford) {
                    Task { await model.takeSeat(at: id, on: table) }
                }
                action("Watch", .slate, "watch") { model.watch(id, on: table) }
            case let .waitlist(afford):
                action("Join the waitlist", .amber, "waitlist", disabled: busy || !afford) {
                    Task { _ = await model.joinWaitlist(at: id) }
                }
                action("Watch", .slate, "watch") { model.watch(id, on: table) }
            }
        }
    }

    private func state(_ note: String) -> some View {
        Text(note)
            .font(.system(size: Metrics.textS))
            .foregroundStyle(Palette.greenLight.color)
            .accessibilityIdentifier("lobby.table.\(id).state")
    }

    private func action(
        _ title: String, _ kind: ButtonKind, _ name: String, disabled: Bool = false, perform: @escaping () -> Void
    ) -> some View {
        Button(title, action: perform)
            .buttonStyle(.kit(kind, small: true))
            .disabled(disabled)
            .accessibilityIdentifier("lobby.table.\(id).\(name)")
    }
}

/// One seat of a listed table, by who has it (`LobbyTables.svelte`'s pips).
struct PipView: View {
    let pip: LobbyWords.Pip

    var body: some View {
        switch pip {
        case .person: Circle().fill(Palette.gold.color).frame(width: 10, height: 10)
        case .bot: Circle().fill(Palette.blueLight.color).frame(width: 10, height: 10)
        case .held: Circle().fill(Palette.amber.color.opacity(0.6)).frame(width: 10, height: 10)
        case .empty: Circle().strokeBorder(Palette.haze.color, lineWidth: 2).frame(width: 10, height: 10)
        }
    }
}

struct Tag: View {
    let text: String
    let colour: RGB
    let ink: RGB

    var body: some View {
        Text(text)
            .font(.system(size: Metrics.textXS).bold())
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(colour.color, in: .rect(cornerRadius: Metrics.radiusS / 2))
            .foregroundStyle(ink.color)
    }
}

struct Avatar: View {
    let name: String
    var size = 32.0

    var body: some View {
        ArtView(named: name).frame(width: size, height: size)
    }
}

// MARK: - Invites

/// An invite a friend sent: the table it is for, and a seat or a place in line there.
struct InviteSection: View {
    let model: LobbyModel
    let table: TableConnection

    var body: some View {
        if let invite = model.invite {
            Section {
                if let listed = invite.table {
                    Text(LobbyWords.inviteLine(listed))
                        .accessibilityIdentifier("lobby.invite.table")
                    if let position = listed.waitlistPosition {
                        Text("You are number \(position) in line for a seat.")
                            .foregroundStyle(Palette.greenLight.color)
                            .accessibilityIdentifier("lobby.invite.waiting")
                    } else {
                        let room = LobbyWords.hasRoom(listed) || listed.hold != nil
                        Button {
                            Task { await model.acceptInvite(on: table) }
                        } label: {
                            Text(
                                model.busy != nil
                                    ? "Seating…" : room ? "Take a seat" : "Join the waitlist")
                        }
                        .buttonStyle(.kit(.amber, wide: true))
                        .disabled(model.busy != nil || (model.balance ?? .max) < listed.minBuyIn)
                        .accessibilityIdentifier("lobby.invite.accept")
                    }
                } else if let error = invite.error {
                    Text(error)
                        .foregroundStyle(Palette.redLight.color)
                        .accessibilityIdentifier("lobby.invite.error")
                } else {
                    ProgressView()
                }
                Button("Not now") { model.dismissInvite() }
                    .accessibilityIdentifier("lobby.invite.dismiss")
            } header: {
                Text("You are invited")
            }
        }
    }
}

/// A friend's invite link, pasted: the app opens it as the site would.
struct OpenInviteSection: View {
    let model: LobbyModel
    @State private var text = ""

    var body: some View {
        Section {
            HStack {
                TextField("Paste an invite link", text: $text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit(open)
                    .accessibilityIdentifier("lobby.invite.field")
                Button("Open", action: open)
                    .disabled(LobbyWords.inviteCode(in: text) == nil)
                    .accessibilityIdentifier("lobby.invite.open")
            }
        } header: {
            Text("An invite")
        } footer: {
            Text("A private table is joined from its invite link. Paste one a friend sent you.")
        }
    }

    private func open() {
        guard let code = LobbyWords.inviteCode(in: text) else { return }
        text = ""
        Task { await model.openInvite(code) }
    }
}

// MARK: - Deleting the guest

/// Deleting the guest and their data (P5D.11, App Review's guideline 5.1.1(v)), asked
/// twice: the button, then a dialog that says what goes.
struct DeleteGuestSection: View {
    let model: LobbyModel
    let table: TableConnection
    @State private var asking = false
    @State private var deleting = false

    var body: some View {
        Section {
            Button("Delete this guest", role: .destructive) { asking = true }
                .disabled(deleting)
                .accessibilityIdentifier("lobby.delete")
        } footer: {
            Text("Removes its name, chips, hands, mutes, blocks and reports for good. In other players’ hands its seat shows as “Former guest”.")
        }
        .confirmationDialog("Delete this guest for good?", isPresented: $asking, titleVisibility: .visible) {
            Button("Delete for good", role: .destructive) {
                deleting = true
                Task {
                    await model.deleteGuest(leaving: table)
                    deleting = false
                }
            }
            .accessibilityIdentifier("lobby.delete.confirm")
            Button("Keep my guest", role: .cancel) {}
        } message: {
            Text("Its chips and hands go with it, and the app starts again as a new guest. If it is in a hand, it checks or folds until the hand ends.")
        }
    }
}

/// The app's App Store page, once Q-13 gives the app its id; until then the update
/// screen has no link.
enum AppStoreLink {
    static let url: URL? = nil
}
