import RiverMindKit
import SafariServices
import SwiftUI

/// “Your hands” (the site's `/hands`, P5D.8): every hand the guest was dealt into, newest
/// first, each opened to replay with its written history, and practice again from a
/// practice hand.
struct HandsView: View {
    let lobby: LobbyModel
    let table: TableConnection
    @State private var model: HandsModel

    init(lobby: LobbyModel, table: TableConnection) {
        self.lobby = lobby
        self.table = table
        _model = State(initialValue: HandsModel(client: lobby.client))
    }

    var body: some View {
        List {
            Section {
                Text("Every hand you were dealt into, newest first. Open one to step through it: your cards, the board, every action and the hands shown at showdown. Folded and mucked hands stay hidden.")
                    .font(.system(size: Metrics.textS))
                    .foregroundStyle(Palette.mist.color)
            }
            if let error = model.error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Palette.redLight.color)
                        .accessibilityIdentifier("hands.error")
                }
            }
            Section {
                if model.loaded && model.hands.isEmpty && model.error == nil {
                    Text("No hands yet. Sit down at a table and they will appear here.")
                        .foregroundStyle(Palette.mist.color)
                        .accessibilityIdentifier("hands.empty")
                }
                ForEach(model.hands, id: \.handID) { hand in
                    NavigationLink {
                        HandDetailView(lobby: lobby, table: table, model: model, handID: hand.handID)
                    } label: {
                        HandRow(hand: hand)
                    }
                    .accessibilityIdentifier("hands.row.\(hand.handNo)")
                }
                if model.more {
                    Button("Older hands") { Task { await model.load(older: true) } }
                        .disabled(model.loading)
                        .accessibilityIdentifier("hands.more")
                }
                if model.loading && model.hands.isEmpty {
                    ProgressView("Loading hands…")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .navigationTitle("Your hands")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load() }
        .task { if !model.loaded { await model.load() } }
        .kitPage()
        .accessibilityIdentifier("hands")
    }
}

/// A listed hand: where and when, the guest's cards and what they won or lost.
struct HandRow: View {
    let hand: HandSummary

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(HandWords.title(hand))
                    .foregroundStyle(Palette.paper.color)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if hand.practice == true { Tag(text: "Practice", colour: Palette.gold, ink: Palette.ink) }
                    Text(HandWords.when(hand.at))
                        .foregroundStyle(Palette.paperShade.color)
                }
                .font(.system(size: Metrics.textS))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: -CardView.width * 0.36 * 0.5) {
                ForEach(Array(hand.cards.enumerated()), id: \.offset) { CardView($0.element, k: 0.36) }
            }
            .accessibilityHidden(true)
            Text(HandWords.signed(hand.net))
                .foregroundStyle(HandTone.colour(hand.net))
                .frame(minWidth: 60, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One hand: the replayer, its written history, and for a practice hand a way back to play.
struct HandDetailView: View {
    let lobby: LobbyModel
    let table: TableConnection
    let model: HandsModel
    let handID: String

    var body: some View {
        ScrollView {
            if let detail = model.open, detail.hand.handID == handID {
                VStack(alignment: .leading, spacing: 14) {
                    Text(HandWords.meta(detail.hand))
                        .font(.system(size: Metrics.textS))
                        .foregroundStyle(Palette.paperShade.color)
                        .accessibilityIdentifier("hand.meta")
                    HandReplayView(detail: detail, roomy: true)
                        .padding(12)
                        .kitFrame(.inset)
                    if detail.hand.practice == true {
                        Button {
                            Task { await lobby.startPractice(on: table) }
                        } label: {
                            Text(lobby.busy == .practice(bot: nil) ? "Dealing…" : "Practice again")
                        }
                        .buttonStyle(.kit(.amber, wide: true))
                        .disabled(lobby.busy != nil)
                        .accessibilityIdentifier("hand.practiceAgain")
                    }
                    Text("Hand history")
                        .font(.system(size: Metrics.textM))
                        .foregroundStyle(Palette.goldLight.color)
                    Text(detail.text)
                        .font(.system(size: Metrics.textS).monospaced())
                        .foregroundStyle(Palette.paper.color)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .kitFrame(.inset)
                        .accessibilityIdentifier("hand.history")
                }
                .padding()
            } else if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(Palette.redLight.color)
                    .padding()
            } else {
                ProgressView().padding(40)
            }
        }
        .navigationTitle(model.hands.first { $0.handID == handID }.map { "Hand #\($0.handNo)" } ?? "Hand")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: handID) { await model.show(handID) }
        .kitPage()
        .accessibilityIdentifier("hand.detail")
    }
}

// MARK: - The bots

/// The bots (the site's `/bots`, D-7): every bot labelled, and each trained bot's published
/// evaluation of the strategy the site serves, linking the full report.
struct BotsView: View {
    let config: ConfigResponse
    let server: Server
    @State private var reading: URL?

    var body: some View {
        List {
            Section {
                Text(ContentWords.botsLead)
                    .foregroundStyle(Palette.paper.color)
            }
            Section("The simple bots") {
                ForEach(ContentWords.simpleBots, id: \.label) { bot in
                    Text("\(Text(bot.label).bold().foregroundStyle(Palette.paper.color)) \(bot.text)")
                        .foregroundStyle(Palette.mist.color)
                }
            }
            ForEach(config.bots.filter { !BotsView.models($0).isEmpty }, id: \.kind) { bot in
                ForEach(BotsView.models(bot), id: \.name) { champion in
                    TrainedBotSection(bot: bot, champion: champion, read: { reading = $0 })
                }
            }
            Section {
                Button("Every model put to the gate") {
                    reading = ContentWords.reportURL("docs/models.md")
                }
                .accessibilityIdentifier("bots.registry")
                Link("The bots on the site", destination: server.url("/bots"))
            } footer: {
                Text("The site's page also shows how each model played before rounding, and the SHA-256 of the files the server checks before it plays.")
            }
        }
        .scrollContentBackground(.hidden)
        .font(.system(size: Metrics.textS))
        .navigationTitle("The bots")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $reading) { url in
            SafariView(url: url).ignoresSafeArea()
        }
        .kitPage()
        .accessibilityIdentifier("bots")
    }

    /// A trained bot's models: one for each format it plays, or its one model.
    static func models(_ bot: BotOption) -> [BotChampion] {
        bot.champions ?? bot.champion.map { [$0] } ?? []
    }
}

struct TrainedBotSection: View {
    let bot: BotOption
    let champion: BotChampion
    let read: (URL) -> Void

    /// The table size the model was measured at: its largest.
    private var seats: Int { champion.seats?.max() ?? bot.seats?.max() ?? 2 }

    private var sizes: String {
        let sizes = champion.seats ?? bot.seats ?? []
        guard let low = sizes.min(), let high = sizes.max() else { return "" }
        return low == high ? "\(low) seats" : "\(low) to \(high) seats"
    }

    var body: some View {
        Section {
            Text(
                "A trained bot. The model it plays is \(Text(champion.name).foregroundStyle(Palette.greenLight.color)), trained for \(ConfigResponse.chips(champion.iterations)) iterations and promoted on \(champion.promoted)."
            )
            .foregroundStyle(Palette.mist.color)
            Text(ContentWords.measuredText(seats: seats))
                .foregroundStyle(Palette.mist.color)
            VStack(spacing: 6) {
                HStack {
                    Text("Against, at \(Int(champion.stackBB.rounded())) bb").frame(maxWidth: .infinity, alignment: .leading)
                    Text("Won per 100").frame(width: 84, alignment: .trailing)
                    Text("95% interval").frame(width: 112, alignment: .trailing)
                }
                .foregroundStyle(Palette.goldLight.color)
                ForEach(champion.results, id: \.opponent) { row in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.label.prefix(1).uppercased() + row.label.dropFirst())
                                .foregroundStyle(Palette.paper.color)
                            Text("\(ConfigResponse.chips(row.hands)) hands").foregroundStyle(Palette.haze.color)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Text(Faces.winRate(row.bbPer100)).frame(width: 84, alignment: .trailing)
                        Text(interval(row)).frame(width: 112, alignment: .trailing)
                    }
                    .foregroundStyle(Palette.paper.color)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("bots.result.\(bot.kind).\(row.opponent)")
                }
            }
            .padding(.vertical, 4)
            if let report = champion.report, let url = ContentWords.reportURL(report) {
                Button("The full report") { read(url) }
                    .foregroundStyle(Palette.goldLight.color)
                    .accessibilityIdentifier("bots.report.\(bot.kind).\(champion.name)")
            }
            DisclosureGroup("What these numbers do not say") {
                ForEach(ContentWords.botCaveats, id: \.self) { Text($0).foregroundStyle(Palette.mist.color) }
            }
        } header: {
            Text("\(bot.label), \(sizes)")
        } footer: {
            Text("The strategy this site serves, as measured. The full report has every input, so anyone can rerun it and get the same numbers.")
        }
        .accessibilityIdentifier("bots.trained.\(bot.kind).\(champion.name)")
    }

    private func interval(_ row: BotResult) -> String {
        guard row.ci95.count == 2 else { return "" }
        return "\(Faces.winRate(row.ci95[0])) to \(Faces.winRate(row.ci95[1]))"
    }
}

// MARK: - Fairness

/// Rules and fair dealing (the site's `/fairness`, D-8): how the cards are dealt and kept
/// private, how bots play, and the table rules, which are the page's own words.
struct FairnessView: View {
    let lobby: LobbyModel
    let table: TableConnection

    var body: some View {
        List {
            Section {
                Text("RiverMind Poker deals no-limit Texas hold’em for play chips only: chips can never be bought, sold or cashed out, and have no value. This explains how every hand is dealt and how the tables run.")
                    .foregroundStyle(Palette.paper.color)
            }
            Section("How the cards are dealt") {
                bullet("Every hand uses a full 52-card deck, shuffled from scratch on the server before the hand. The shuffle draws on the operating system’s cryptographic random number generator, the same source used for passwords and keys, so no one can predict or influence the order of the cards.")
                bullet("Cards come off the top of the deck in order, as a dealer deals them: two hole cards to each player, starting left of the button, and a burn card before the flop, the turn and the river.")
                bullet("The server deals and keeps the deck. This app is sent your own cards and the board, never anyone else’s hole cards or the cards still in the deck, as a browser at the same table is. Cards are revealed only when a hand is shown at showdown.")
                bullet("Hands that are folded or mucked stay hidden from everyone, including in hand histories.")
            }
            Section("Bots play by the same rules") {
                ForEach(ContentWords.botRules, id: \.self) { bullet($0) }
            }
            Section("Check any hand you played") {
                Text("Every finished hand is stored. Your hands lists the hands you were dealt into, with your cards, the board, every action and every hand shown at showdown, so you can check how each one played out.")
                    .foregroundStyle(Palette.mist.color)
                NavigationLink("Your hands") { HandsView(lobby: lobby, table: table) }
                    .accessibilityIdentifier("fairness.hands")
            }
            Section("Table rules") {
                ForEach(ContentWords.tableRules, id: \.term) { rule in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(rule.term).foregroundStyle(Palette.paper.color)
                        Text(rule.text).foregroundStyle(Palette.mist.color)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            Section("Playing fair") {
                Text(ContentWords.conduct).foregroundStyle(Palette.mist.color)
            }
            Section {
                Link("Rules and fair dealing on the site", destination: lobby.server.url("/fairness"))
            }
        }
        .scrollContentBackground(.hidden)
        .font(.system(size: Metrics.textS))
        .navigationTitle("Rules and fair dealing")
        .navigationBarTitleDisplayMode(.inline)
        .kitPage()
        .accessibilityIdentifier("fairness")
    }

    private func bullet(_ text: String) -> some View {
        Text(text).foregroundStyle(Palette.mist.color)
    }
}

// MARK: - Reading a page

/// A page opened to read without leaving the app: Safari's own view, which shares nothing
/// with the app (no cookies, no script of ours).
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}
