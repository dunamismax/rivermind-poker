import RiverMindKit
import SwiftUI

/// “Start a table” (`NlLobby.svelte`'s form): the seats, the bots in the other seats or
/// none, private or listed, the blinds and the buy-in the wallet covers.
struct NewTableView: View {
    @Bindable var model: LobbyModel
    let table: TableConnection
    let config: ConfigResponse

    private var offered: [BotOption] { LobbyWords.bots(config.bots, for: model.form.seats) }
    private var affordable: [Int] { model.form.affordable(balance: model.balance) }

    var body: some View {
        Form {
            Section("Seats") {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                    ForEach(config.seatCounts, id: \.self) { count in
                        Button(String(count)) { model.form.seats = count }
                            .buttonStyle(.kit(chosen: model.form.seats == count, wide: true))
                            .accessibilityIdentifier("newTable.seats.\(count)")
                            .accessibilityAddTraits(model.form.seats == count ? .isSelected : [])
                    }
                }
                .padding(.vertical, 4)
            }
            Section {
                ForEach(offered) { bot in
                    opponent(
                        kind: bot.kind, name: bot.label, note: LobbyWords.botNote(bot),
                        avatar: Faces.avatar(kind: .bot, bot: bot.kind, name: ""))
                }
                opponent(
                    kind: NewTableForm.noBots, name: "No bots", note: "Seats wait for people.",
                    avatar: Faces.avatar(kind: .human, bot: nil, name: "You"))
            } header: {
                Text("Opponents")
            } footer: {
                Text("Bots give up their seats when people want them.")
            }
            Section {
                Toggle(isOn: $model.form.isPrivate) {
                    VStack(alignment: .leading) {
                        Text("Private table")
                        Text("Not listed; share its invite link.")
                            .font(.system(size: Metrics.textS))
                            .foregroundStyle(Palette.mist.color)
                    }
                }
                .accessibilityIdentifier("newTable.private")
            }
            Section {
                Picker("Blinds", selection: $model.form.bigBlind) {
                    ForEach(config.stakes, id: \.bigBlind) { Text(ConfigResponse.blinds($0)).tag($0.bigBlind) }
                }
                .accessibilityIdentifier("newTable.blinds")
                Picker("Buy-in", selection: $model.form.buyInBlinds) {
                    ForEach(LobbyWords.buyIns, id: \.self) { blinds in
                        Text(LobbyWords.buyInLabel(blinds, bigBlind: model.form.bigBlind))
                            .tag(blinds)
                            .selectionDisabled(!affordable.contains(blinds))
                    }
                }
                .accessibilityIdentifier("newTable.buyIn")
                if affordable.isEmpty {
                    Text("Not enough play chips for these blinds. Pick lower blinds, or come back tomorrow for a top-up.")
                        .font(.system(size: Metrics.textS))
                        .foregroundStyle(Palette.mist.color)
                        .accessibilityIdentifier("newTable.short")
                }
            }
            if let error = model.error {
                Section {
                    Text(error)
                        .foregroundStyle(Palette.redLight.color)
                        .accessibilityIdentifier("newTable.error")
                }
            }
            Section {
                Button {
                    Task { await model.newTable(config, on: table) }
                } label: {
                    Text(model.busy == .newTable ? "Dealing…" : "Sit down")
                        .font(.system(size: Metrics.textL))
                }
                .buttonStyle(.kit(.amber, wide: true))
                .disabled(model.busy != nil || affordable.isEmpty)
                .accessibilityIdentifier("newTable.start")
                .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .navigationTitle("Start a table")
        .navigationBarTitleDisplayMode(.inline)
        .kitPage()
        // The page's rules: a bot that does not play the size gives way to RiverMind Easy,
        // and a buy-in the wallet does not cover gives way to the largest it does.
        .onChange(of: model.form) { _, form in
            let kept = form.normalized(config: config, balance: model.balance)
            if kept != form { model.form = kept }
        }
    }

    private func opponent(kind: String, name: String, note: String, avatar: String) -> some View {
        let chosen = model.form.bots == kind
        return Button {
            model.form.bots = kind
        } label: {
            HStack(spacing: 10) {
                Avatar(name: avatar)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).foregroundStyle(chosen ? Palette.gold.color : Palette.paper.color)
                    if !note.isEmpty {
                        Text(note)
                            .font(.system(size: Metrics.textS))
                            .foregroundStyle(Palette.mist.color)
                    }
                }
                Spacer()
                if chosen { Image(systemName: "checkmark").foregroundStyle(Palette.gold.color) }
            }
        }
        .accessibilityIdentifier("newTable.bot.\(kind)")
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}
