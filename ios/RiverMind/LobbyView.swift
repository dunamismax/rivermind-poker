import RiverMindKit
import SwiftUI

/// P5D.1's placeholder lobby: the guest this app is (`POST /api/session`, P5D.2) and what
/// the server offers (`GET /api/config`), on the site's night with its gold (P5D.5). P5D.6
/// brings the lobby.
struct LobbyView: View {
    let model: LobbyModel
    let table: TableConnection

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
                            NavigationLink {
                                GalleryView()
                            } label: {
                                Label("Gallery", systemImage: "swatchpalette")
                            }
                            .accessibilityIdentifier("lobby.gallery")
                        }
                    }
                #endif
        }
        .task { await model.load() }
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
            offer(config, guest: guest)
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

    private func offer(_ config: ConfigResponse, guest: SessionResponse) -> some View {
        List {
            #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-practice") {
                    PracticeProbe(model: model, table: table)
                }
            #endif
            Section {
                Text("No-limit Texas hold’em for play money only. Chips can never be bought, sold or cashed out.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Section {
                LabeledContent(guest.name, value: "\(ConfigResponse.chips(guest.balance)) chips")
                    .accessibilityIdentifier("lobby.guest")
            } header: {
                Text("You")
            } footer: {
                // Q-15: a guest here is not the browser's.
                Text("A guest in this app has its own chips, apart from any browser's.")
            }
            Section("Bots") {
                ForEach(config.bots) { bot in
                    LabeledContent(bot.label, value: seats(bot.seats ?? config.seatCounts))
                        .accessibilityIdentifier("lobby.bot.\(bot.kind)")
                }
            }
            Section("Tables") {
                LabeledContent("Seats", value: seats(config.seatCounts))
                    .accessibilityIdentifier("lobby.seats")
                LabeledContent(
                    "Blinds", value: config.stakes.map(ConfigResponse.blinds).joined(separator: " · "))
                if let stack = config.practiceStack {
                    LabeledContent("Practice stack", value: ConfigResponse.chips(stack))
                }
            }
            Section {
                Text(model.server.origin.host() ?? model.server.origin.absoluteString)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.tertiary)
                    .accessibilityIdentifier("lobby.server")
            } footer: {
                Text("Protocol \(config.protocolVersion)")
            }
            DeleteGuestSection(model: model, table: table)
        }
        .refreshable { await model.load() }
        .accessibilityIdentifier("lobby.ready")
    }

    private func seats(_ counts: [Int]) -> String {
        guard let first = counts.first, let last = counts.last else { return "none" }
        if first == last { return "\(first) seats" }
        return counts == Array(first...last)
            ? "\(first) to \(last) seats"
            : counts.map(String.init).joined(separator: ", ") + " seats"
    }
}

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

#if DEBUG
    /// A debug build launched with `-practice` joins a practice table and shows how its
    /// connection stands, for the UI tests of P5D.3 until P5D.7 brings the table itself.
    struct PracticeProbe: View {
        let model: LobbyModel
        let table: TableConnection
        @State private var failure: String?

        var body: some View {
            Section("Practice table (debug)") {
                LabeledContent("Connection", value: status)
                    .accessibilityIdentifier("probe.status")
                LabeledContent("Joins", value: String(table.joins))
                    .accessibilityIdentifier("probe.joins")
                LabeledContent("Hand", value: table.view?.hand.map { String($0.handNo) } ?? "none")
                    .accessibilityIdentifier("probe.hand")
                if let failure { Text(failure).accessibilityIdentifier("probe.failure") }
            }
            .task {
                guard table.tableID == nil else { return }
                do { try await model.practice(on: table) } catch { failure = error.localizedDescription }
            }
        }

        private var status: String {
            switch table.status {
            case .idle: table.suspended ? "suspended" : "idle"
            case .connecting: "connecting"
            case .open: "open"
            case .closed: "closed"
            }
        }
    }
#endif
