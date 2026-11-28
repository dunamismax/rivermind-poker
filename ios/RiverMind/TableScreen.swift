import RiverMindKit
import SwiftUI

/// The table the guest follows, as far as P5D.6 needs it: who sits where, the guest's own
/// place (seated, a held seat, in line or watching), the private table's invite through
/// the share sheet, and the way back to the lobby. P5D.7 brings the table itself, with
/// its felt, cards and action panel.
struct TableScreen: View {
    let model: LobbyModel
    let table: TableConnection

    var body: some View {
        NavigationStack {
            List {
                if let view = table.view {
                    content(view)
                } else {
                    Section {
                        ProgressView("Joining the table")
                    }
                }
                Section {
                    LabeledContent("Connection", value: status)
                        .accessibilityIdentifier("table.status")
                    #if DEBUG
                        LabeledContent("Joins", value: String(table.joins))
                            .accessibilityIdentifier("table.joins")
                    #endif
                    LabeledContent("Hand", value: table.view?.hand.map { String($0.handNo) } ?? "none")
                        .accessibilityIdentifier("table.hand")
                } footer: {
                    Text("The full table, with its cards and actions, comes in the next build of the app.")
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle(table.view?.name ?? "Table")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        table.leave()
                    } label: {
                        Label(seated ? "Leave table" : "Lobby", systemImage: "chevron.backward")
                            .labelStyle(.titleAndIcon)
                    }
                    .accessibilityIdentifier("table.leave")
                }
                if let invite = table.view?.invite, let link = URL(string: inviteLink(invite)) {
                    ToolbarItem(placement: .topBarTrailing) {
                        ShareLink(
                            item: link, subject: Text("RiverMind Poker"),
                            message: Text("Join my private table at RiverMind Poker (play money only).")
                        ) {
                            Label("Invite", systemImage: "square.and.arrow.up")
                        }
                        .accessibilityIdentifier("table.invite")
                    }
                }
            }
            .kitPage()
        }
        .accessibilityIdentifier("table.screen")
    }

    private var seated: Bool { table.view?.you.seat != nil }

    private func inviteLink(_ code: String) -> String {
        LobbyWords.inviteLink(origin: model.server.origin.absoluteString, code: code)
    }

    @ViewBuilder private func content(_ view: TableView) -> some View {
        Section {
            Text(
                "Blinds \(view.settings.smallBlind)/\(view.settings.bigBlind) · \(view.settings.seatCount) seats"
                    + (view.practice == true ? " · practice chips" : ""))
                .foregroundStyle(Palette.mist.color)
                .accessibilityIdentifier("table.stakes")
            you(view)
            if let notice = table.notice {
                Text(notice.text)
                    .foregroundStyle(Palette.amber.color)
                    .accessibilityIdentifier("table.notice")
            }
        }
        Section("Seats") {
            ForEach(Array(view.seats.enumerated()), id: \.offset) { index, seat in
                SeatRow(index: index, seat: seat, mine: view.you.seat == index)
            }
        }
        if let invite = view.invite {
            Section {
                Text(inviteLink(invite))
                    .font(.footnote.monospaced())
                    .textSelection(.enabled)
                    .accessibilityIdentifier("table.inviteLink")
            } header: {
                Text("Invite")
            } footer: {
                Text("A private table is not listed. Share this link with the people you want to play.")
            }
        }
    }

    @ViewBuilder private func you(_ view: TableView) -> some View {
        let you = view.you
        if let seat = you.seat {
            Text(you.sittingOut ? "You are sitting out in seat \(seat + 1)." : "You are in seat \(seat + 1).")
                .accessibilityIdentifier("table.you")
        } else if let hold = you.hold {
            Text(
                hold.ready
                    ? "Seat \(hold.seat + 1) is yours: sitting down…"
                    : "Seat \(hold.seat + 1) is yours when the bot there finishes this hand."
            )
            .accessibilityIdentifier("table.you")
            Button("Give up the seat") { Task { await model.giveUpHold(at: view.tableID) } }
                .buttonStyle(.kit(small: true))
        } else if let position = you.waitlistPosition {
            Text("You are number \(position) in line. A seat is held for you when one opens.")
                .accessibilityIdentifier("table.you")
            Button("Leave the line") { Task { await model.leaveWaitlist(at: view.tableID) } }
                .buttonStyle(.kit(small: true))
                .accessibilityIdentifier("table.leaveLine")
        } else {
            let short = (model.balance ?? .max) < view.settings.minBuyIn
            Text("You are watching." + (short ? " You need more play chips to sit at this table." : ""))
                .accessibilityIdentifier("table.you")
            let room = view.seats.contains { $0 == nil || $0?.kind == .bot }
            Button(room ? "Sit down" : "Join the waitlist") {
                Task {
                    if room {
                        await model.takeSeat(at: view.tableID, on: table)
                    } else {
                        _ = await model.joinWaitlist(at: view.tableID)
                    }
                }
            }
            .buttonStyle(.kit(.amber, small: true))
            .disabled(short || model.busy != nil)
            .accessibilityIdentifier("table.sit")
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

/// One seat: who sits there, a bot's label (D-7), the stack and how they stand in the hand.
struct SeatRow: View {
    let index: Int
    let seat: SeatInfo?
    let mine: Bool

    var body: some View {
        HStack(spacing: 10) {
            if let seat {
                Avatar(name: Faces.avatar(seat), size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(seat.name).foregroundStyle(mine ? Palette.gold.color : Palette.paper.color)
                        if seat.kind == .bot { Tag(text: "Bot", colour: Palette.blueDark, ink: Palette.white) }
                    }
                    let status = Faces.status(seat)
                    if !status.isEmpty {
                        Text(status)
                            .font(.system(size: Metrics.textS))
                            .foregroundStyle(Palette.mist.color)
                    }
                }
                Spacer()
                Text(ConfigResponse.chips(seat.stack))
                    .monospacedDigit()
                    .foregroundStyle(Palette.goldLight.color)
            } else {
                Text("Seat \(index + 1) · empty").foregroundStyle(Palette.haze.color)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(seat.map { Faces.label($0, me: mine) } ?? "Seat \(index + 1): empty")
        .accessibilityIdentifier("table.seat.\(index)")
    }
}
