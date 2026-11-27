import RiverMindKit
import SwiftUI

/// P5D.1's placeholder lobby: what the server offers, read from `GET /api/config`.
/// P5D.5 brings the clean look and P5D.6 the lobby itself.
struct LobbyView: View {
    let model: LobbyModel

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
        case let .ready(config):
            offer(config)
        }
    }

    private func offer(_ config: ConfigResponse) -> some View {
        List {
            Section {
                Text("No-limit Texas hold’em for play money only. Chips can never be bought, sold or cashed out.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
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
