import RiverMindKit
import SwiftUI

/// P5D.1's placeholder lobby: the guest this app is (`POST /api/session`, P5D.2) and what
/// the server offers (`GET /api/config`). P5D.5 brings the clean look and P5D.6 the lobby.
struct LobbyView: View {
    let model: LobbyModel
    let table: TableConnection

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("RiverMind Poker")
                .toolbarTitleDisplayMode(.inlineLarge)
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
