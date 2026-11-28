import RiverMindKit
import SwiftUI

/// A finished hand to step through (the site's `HandReplay.svelte`, P6.1): the blinds, each
/// action, each street, the showdown and the result, with the board, the pot, every seat's
/// cards and bets as they stood, and why each pot went where it did. It opens on the result,
/// so the hand reads as it ended. The steps are `Replay.steps`, held to the page's by the
/// display fixture; they hold only the cards the guest may see.
struct HandReplayView: View {
    let detail: HandDetail
    /// On a screen of its own: larger cards.
    var roomy = false

    @State private var chosen: (hand: String, index: Int)?

    private var steps: [ReplayStep] { Replay.steps(detail) }

    private var index: Int {
        let last = max(0, steps.count - 1)
        guard let chosen, chosen.hand == detail.hand.handID else { return last }
        return min(chosen.index, last)
    }

    var body: some View {
        let steps = steps
        if steps.isEmpty {
            Text("This hand has nothing to step through.").foregroundStyle(Palette.mist.color)
        } else {
            let step = steps[index]
            VStack(alignment: .leading, spacing: 10) {
                controls(count: steps.count)
                HStack(alignment: .firstTextBaseline) {
                    Text("\(Replay.stage(step)) · step \(index + 1) of \(steps.count)")
                        .foregroundStyle(Palette.paperShade.color)
                        .accessibilityIdentifier("replay.stage")
                    Spacer()
                    Text("Pot \(ConfigResponse.chips(step.pot))")
                        .foregroundStyle(Palette.goldLight.color)
                        .accessibilityIdentifier("replay.pot")
                }
                .font(.system(size: Metrics.textS))
                // Room for three lines, so a short step and a long one leave the board where it is.
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(step.lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                    }
                }
                .font(.system(size: Metrics.textS))
                .foregroundStyle(Palette.paper.color)
                .frame(maxWidth: .infinity, minHeight: 58, alignment: .topLeading)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("replay.lines")
                board(step)
                VStack(spacing: 2) {
                    ForEach(step.seats, id: \.seat) { seat in
                        seatRow(seat, acting: step.acting == seat.seat)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("replay")
        }
    }

    private func go(_ to: Int, count: Int) {
        chosen = (detail.hand.handID, max(0, min(count - 1, to)))
    }

    private func controls(count: Int) -> some View {
        let last = count - 1
        return HStack(spacing: 6) {
            control("First", "first", disabled: index == 0) { go(0, count: count) }
            control("Back", "back", disabled: index == 0) { go(index - 1, count: count) }
            control("Next", "next", disabled: index == last) { go(index + 1, count: count) }
            control("Last", "last", disabled: index == last) { go(last, count: count) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Steps of the hand")
    }

    private func control(_ title: String, _ name: String, disabled: Bool, perform: @escaping () -> Void) -> some View {
        Button(title, action: perform)
            .buttonStyle(.kit(small: true, wide: true))
            .disabled(disabled)
            .accessibilityIdentifier("replay.\(name)")
    }

    private var cardK: Double { roomy ? 0.62 : 0.5 }

    private func board(_ step: ReplayStep) -> some View {
        HStack(spacing: 4) {
            ForEach(0..<5, id: \.self) { place in
                if place < step.board.count {
                    CardView(step.board[place], k: cardK)
                } else {
                    CardView(.slot, k: cardK)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Board")
        .accessibilityIdentifier("replay.board")
    }

    private func seatRow(_ seat: ReplaySeat, acting: Bool) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if acting { Text("→").foregroundStyle(Palette.goldLight.color).accessibilityHidden(true) }
                    Text(seat.name)
                        .foregroundStyle(seat.you ? Palette.goldLight.color : Palette.paper.color)
                        .lineLimit(1)
                        .opacity(seat.folded ? 0.55 : 1)
                }
                HStack(spacing: 4) {
                    if seat.kind == .bot { Tag(text: "Bot", colour: Palette.ink, ink: Palette.violetLight) }
                    if seat.you { Tag(text: "You", colour: Palette.gold, ink: Palette.ink) }
                    if detail.button == seat.seat { Tag(text: "Button", colour: Palette.ink, ink: Palette.violetLight) }
                    if seat.folded {
                        Tag(text: "Folded", colour: Palette.ink, ink: Palette.paperShade)
                    } else if seat.allIn {
                        Tag(text: "All-in", colour: Palette.ink, ink: Palette.paperShade)
                    }
                }
            }
            .font(.system(size: Metrics.textS))
            .frame(maxWidth: .infinity, alignment: .leading)
            hole(seat)
            amount(seat)
                .frame(width: 72, alignment: .trailing)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(acting ? Palette.deepSlate.color : .clear, in: .rect(cornerRadius: 4))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("replay.seat.\(seat.seat)")
    }

    /// The guest's cards as they held them; anyone else's face down until shown.
    @ViewBuilder private func hole(_ seat: ReplaySeat) -> some View {
        let k = roomy ? 0.42 : 0.36
        if let cards = seat.cards {
            HStack(spacing: -CardView.width * k * 0.5) {
                ForEach(Array(cards.enumerated()), id: \.offset) { CardView($0.element, k: k) }
            }
            .opacity(seat.folded ? 0.55 : 1)
            .accessibilityLabel("Cards")
        } else if !seat.folded {
            HStack(spacing: -CardView.width * k * 0.5) {
                CardView(.back(.burgundy), k: k)
                CardView(.back(.burgundy), k: k)
            }
            .accessibilityElement()
            .accessibilityLabel("Cards not shown")
        }
    }

    @ViewBuilder private func amount(_ seat: ReplaySeat) -> some View {
        if let net = seat.net {
            Text(HandWords.signed(net))
                .foregroundStyle(HandTone.colour(net))
                .accessibilityLabel(net > 0 ? "Won \(net)" : net < 0 ? "Lost \(-net)" : "Even")
        } else if seat.bet > 0 {
            HStack(spacing: 4) {
                ArtView(named: "chip-gold").frame(width: 14, height: 14)
                Text(ConfigResponse.chips(seat.bet)).foregroundStyle(Palette.paper.color)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Bet \(seat.bet)")
        }
    }
}

/// A result's colour: won, lost or even.
enum HandTone {
    static func colour(_ net: Int) -> Color {
        switch HandWords.tone(net) {
        case .won: Palette.greenLight.color
        case .lost: Palette.redLight.color
        case .even: Palette.paperShade.color
        }
    }
}
