import RiverMindKit
import SwiftUI

/// The menu for another person's seat (P4.5, App Review's guideline 1.2): mute, which hides
/// their reactions; block, which also keeps quick seat from seating the two together; and
/// a report, for review.
struct SeatMenu: View {
    let model: TableModel
    let table: TableConnection
    let seat: Int
    @State private var reason = ReportReason.abuse
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            if let info = table.view?.seats[safe: seat] ?? nil, info.kind == .human {
                let relation = model.relationOf(info.ref)
                Form {
                    Section {
                        HStack(spacing: 10) {
                            ArtView(named: Faces.avatar(info)).frame(width: 32, height: 32)
                            Text(info.name).foregroundStyle(Palette.goldLight.color)
                            if relation != nil {
                                Text(Safety.relationText(relation))
                                    .foregroundStyle(Palette.greenLight.color)
                                    .accessibilityIdentifier("seatMenu.relation")
                            }
                        }
                        HStack(spacing: 10) {
                            Button(relation == .mute ? "Unmute" : "Mute") {
                                Task { await model.toggle(.mute, seat: seat) }
                            }
                            .buttonStyle(.kit(chosen: relation == .mute, small: true))
                            .accessibilityIdentifier("seatMenu.mute")
                            Button(relation == .block ? "Unblock" : "Block") {
                                Task { await model.toggle(.block, seat: seat) }
                            }
                            .buttonStyle(.kit(.red, chosen: relation == .block, small: true))
                            .accessibilityIdentifier("seatMenu.block")
                        }
                        .disabled(model.busy)
                    } footer: {
                        Text("Muting hides their reactions. Blocking also keeps quick seat from seating you together.")
                    }
                    Section {
                        Picker("Reason", selection: $reason) {
                            ForEach(Safety.reportReasons, id: \.reason) { Text($0.text).tag($0.reason) }
                        }
                        .accessibilityIdentifier("seatMenu.reason")
                        Button("Report") { Task { await model.report(seat: seat, reason: reason) } }
                            .buttonStyle(.kit(.amber, small: true))
                            .disabled(model.busy)
                            .accessibilityIdentifier("seatMenu.report")
                        if let reported = model.reported {
                            Text(reported)
                                .foregroundStyle(Palette.greenLight.color)
                                .accessibilityIdentifier("seatMenu.reported")
                        }
                    } header: {
                        Text("Report")
                    } footer: {
                        if reason == .voice { Text(Safety.voiceReportNote) }
                    }
                }
                .scrollContentBackground(.hidden)
                .navigationTitle("Player")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Close") { dismiss() }.accessibilityIdentifier("seatMenu.close")
                    }
                }
            } else {
                ContentUnavailableView("They left the seat", systemImage: "person.slash")
            }
        }
        .kitPage()
        .accessibilityIdentifier("seatMenu")
    }
}

/// The hand log: the table's events, newest first, each naming who sat there then.
struct HandLogSheet: View {
    let model: TableModel
    let table: TableConnection
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let view = table.view {
                    let lines = TableWords.logLines(table.log, view)
                    List {
                        ForEach(Array(lines.enumerated()), id: \.element.seq) { index, line in
                            Text(line.text)
                                .font(.system(size: Metrics.textS))
                                .foregroundStyle(index == 0 ? Palette.paper.color : Palette.mist.color)
                        }
                        .listRowBackground(Palette.deepSlate.color)
                    }
                    .scrollContentBackground(.hidden)
                    .accessibilityIdentifier("table.log")
                    .overlay {
                        if lines.isEmpty { ContentUnavailableView("Nothing yet", systemImage: "list.bullet") }
                    }
                }
            }
            .navigationTitle("Hand log")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // “Review last hand” is in the log's heading, as on the site (P6.1).
                if let view = table.view, TableWords.me(view) != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Review last hand") {
                            let settled = view.hand.flatMap { hand in
                                hand.result != nil && TableWords.dealtIn(view) ? hand.handNo : nil
                            }
                            dismiss()
                            Task { await model.openReview(handNo: settled) }
                        }
                        .disabled(!TableWords.reviewable(view) || model.review.loading)
                        .accessibilityIdentifier("table.reviewLast")
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Close") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                Text("Play chips only: they can never be bought, sold or cashed out.")
                    .font(.system(size: Metrics.textXS))
                    .foregroundStyle(Palette.haze.color)
                    .padding(.bottom, 8)
            }
        }
        .kitPage()
    }
}

/// Adding chips to the stack, up to the table's maximum; it lands after the hand under way.
struct RebuySheet: View {
    let table: TableConnection
    @State private var amount = 0
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let room = table.view.map(TableWords.rebuyRoom) ?? 0
        NavigationStack {
            VStack(spacing: 14) {
                Text("Add up to \(ConfigResponse.chips(max(0, room))) play chips from your wallet.")
                    .font(.system(size: Metrics.textS))
                    .foregroundStyle(Palette.mist.color)
                HStack(spacing: 10) {
                    TextField("Amount", value: $amount, format: .number.grouping(.never))
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .textFieldStyle(KitFieldStyle())
                        .frame(width: 130)
                        .accessibilityLabel("Rebuy amount")
                        .accessibilityIdentifier("rebuy.amount")
                    Button("Rebuy") {
                        if table.rebuy(min(max(1, amount), room)) { dismiss() }
                    }
                    .buttonStyle(.kit(.amber))
                    .disabled(room <= 0 || amount <= 0 || !table.connected)
                    .accessibilityIdentifier("rebuy.confirm")
                }
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .navigationTitle("Rebuy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .onAppear { amount = max(0, room) }
        }
        .kitPage()
    }
}
