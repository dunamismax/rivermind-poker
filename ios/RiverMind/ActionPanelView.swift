import RiverMindKit
import SwiftUI

/// The turn's actions (the site's `ActionPanel.svelte`): the size presets, a slider and an
/// exact amount above, and Fold, Call and Raise in a row at the foot. The panel is as tall
/// as the zone it covers whether or not it offers sizing, so the main buttons stand in the
/// same place at every turn.
struct ActionPanelView: View {
    let legal: Legal
    let hand: HandInfo
    let turnSeq: Int
    let disabled: Bool
    let act: (ActionKind, Int?) -> Void

    @State private var sizing = ActionSizing()
    /// Inside the frame's own six-point border: the rows fill the rest of the zone exactly
    /// (two rows of small buttons, the main row and the gaps between them).
    static let inset = (TableMetrics.zone - 12 - 2 * ButtonPalette.smallHeight - TableMetrics.main - 2 * TableMetrics.gap) / 2
    @FocusState private var typing: Bool

    var body: some View {
        let presets = Bet.presets(legal, hand)
        let target = sizing.target(legal)
        let lit = sizing.lit(presets, legal)
        // No spacing of the stack's own: a spacer is one of its children, and spacing around
        // it made the panel taller than the zone, which moved the main row (P5D.7).
        VStack(spacing: 0) {
            if ActionSizing.hasSizing(legal) {
                VStack(spacing: TableMetrics.gap) {
                    HStack(spacing: 6) {
                        ForEach(presets, id: \.label) { preset in
                            Button(ActionSizing.face(preset.label)) { sizing.pick(preset) }
                                .buttonStyle(.kit(chosen: preset.label == lit, small: true, wide: true))
                                .accessibilityLabel("\(preset.label): \(preset.amount)")
                                .accessibilityAddTraits(preset.label == lit ? .isSelected : [])
                                .accessibilityIdentifier("table.preset.\(preset.label)")
                        }
                    }
                    .frame(height: ButtonPalette.smallHeight)
                    HStack(spacing: 10) {
                        Slider(
                            value: Binding(
                                get: { Double(target) },
                                set: { sizing.set($0.rounded()) }),
                            in: Double(legal.minTo)...Double(legal.maxTo), step: 1
                        )
                        .accessibilityLabel(legal.raiseKind == .bet ? "Bet amount" : "Raise to")
                        .accessibilityValue(String(target))
                        .accessibilityIdentifier("table.slider")
                        TextField(
                            "Amount",
                            value: Binding(get: { target }, set: { sizing.set(Double($0)) }),
                            format: .number.grouping(.never)
                        )
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                        .textFieldStyle(KitFieldStyle())
                        .focused($typing)
                        .frame(width: 96)
                        .accessibilityLabel(legal.raiseKind == .bet ? "Bet amount in chips" : "Raise to, in chips")
                        .accessibilityIdentifier("table.amount")
                    }
                    // The field is a little taller than the row and draws into the gaps; the
                    // row itself keeps its height, so the main row never moves.
                    .frame(height: ButtonPalette.smallHeight)
                }
            }
            Spacer(minLength: TableMetrics.gap)
            // Three fixed places, so each button stands in its own at every turn: where the
            // guest may check there is no Fold, and its place stays empty.
            HStack(spacing: TableMetrics.gap) {
                if legal.canFold {
                    Button("Fold") { act(.fold, nil) }
                        .buttonStyle(MainActionStyle(kind: .red))
                        .accessibilityIdentifier("table.fold")
                } else {
                    Color.clear.frame(maxWidth: .infinity)
                }
                Button(Bet.callLabel(legal)) { act(legal.canCheck ? .check : .call, nil) }
                    .buttonStyle(MainActionStyle(kind: .blue))
                    .accessibilityIdentifier("table.call")
                if ActionSizing.canRaise(legal), let kind = legal.raiseKind {
                    Button(Bet.raiseLabel(legal, target)) {
                        typing = false
                        act(kind == .bet ? .bet : .raise, target)
                    }
                    .buttonStyle(MainActionStyle(kind: .amber))
                    .accessibilityIdentifier("table.raise")
                } else {
                    Color.clear.frame(maxWidth: .infinity)
                }
            }
            .frame(height: TableMetrics.main)
        }
        .disabled(disabled)
        .padding(Self.inset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .kitFrame(.panel)
        // Exactly the zone's height whatever it offers, so the main row stands at its foot.
        .frame(height: TableMetrics.zone)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Your action")
        .accessibilityIdentifier("table.actions")
        .onAppear { sizing.follow(turnSeq: turnSeq, legal: legal) }
        .onChange(of: turnSeq) { _, seq in sizing.follow(turnSeq: seq, legal: legal) }
        .toolbar {
            // The keyboard covers the panel: the amount being typed is shown above it.
            ToolbarItemGroup(placement: .keyboard) {
                Text(Bet.raiseLabel(legal, target))
                    .foregroundStyle(Palette.goldLight.color)
                Spacer()
                Button("Done") { typing = false }
            }
        }
    }
}

/// Fold, Call and Raise: tall, with room for a label on two lines, filling their share of
/// the row.
struct MainActionStyle: ButtonStyle {
    let kind: ButtonKind
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        KitButtonFace(
            kind: kind, wide: true,
            state: !isEnabled ? .disabled : configuration.isPressed ? .pressed : .normal
        ) {
            configuration.label
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(maxHeight: .infinity)
        }
    }
}
