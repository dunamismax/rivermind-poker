import RiverMindKit
import SwiftUI

/// The felt and everything on it: the seats around the tall map (`Layout`, ported from
/// layout.ts), their bets, the pot, the board and each pot's winner, with the guest's own
/// seat at the bottom centre and the others clockwise in seat order.
struct TableArena: View {
    let view: TableView
    let model: TableModel
    let table: TableConnection
    let onSelect: (Int) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// What hangs below the felt for the guest's own seat.
    static let hang = 44.0
    /// The lengths the page writes as CSS variables, for a phone (`phone:` in NlTable.svelte).
    static func length(_ length: TableLayout.Length) -> Double {
        switch length {
        case .podDrop: 56
        case .podLift: -40
        case .seatDrop: 88
        case .tagLevel: 64
        case .tagSide: 92
        case .boardBelow: 86
        case .boardAbove: -82
        case let .points(value): Double(value)
        }
    }

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let stage = CGSize(width: width, height: max(200, geometry.size.height - Self.hang))
            let count = view.settings.seatCount
            let mine = view.you.seat
            let spots = TableLayout.places(count, .tall)
            let mySeat = MySeatView.size(width: width)
            ZStack(alignment: .topLeading) {
                TableFelt(unit: 1.5)
                    .frame(width: width, height: stage.height)
                centre(stage: stage)
                ForEach(Array(view.seats.enumerated()), id: \.offset) { seat, info in
                    let place = TableLayout.placeOf(seat, anchor: mine, count: count)
                    if place < spots.count {
                        let spot = spots[place]
                        let point = CGPoint(x: spot.left / 100 * stage.width, y: spot.top / 100 * stage.height)
                        if let info {
                            seatView(info, seat: seat, place: place, spot: spot, at: point, stage: stage, mine: mySeat)
                        } else {
                            EmptySeatView(kind: TableWords.emptySeat(view, seat), seat: seat, busy: model.busy) {
                                Task { await model.holdSeat(seat) }
                            }
                            .position(point)
                        }
                    }
                }
            }
            .frame(width: width, height: geometry.size.height, alignment: .topLeading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Table")
    }

    // MARK: The centre

    @ViewBuilder private func centre(stage: CGSize) -> some View {
        let hand = view.hand
        let result = hand?.result
        let k = min(0.95, (stage.width - 28) / (5 * CardView.width + 4 * 4))
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                if let hand, result == nil {
                    ArtView(named: "pot").frame(width: 40, height: 22)
                    Text("Pot \(hand.pot)")
                        .font(.system(size: Metrics.textM, weight: .semibold))
                        .foregroundStyle(Palette.goldLight.color)
                        .inkShadow()
                        .accessibilityIdentifier("table.pot")
                }
            }
            .frame(height: 24)
            HStack(spacing: 4) {
                ForEach(0..<5, id: \.self) { index in
                    if let card = hand?.board[safe: index] {
                        CardView(card, k: k)
                            .transition(reduceMotion ? .identity : .scale(scale: 0.8).combined(with: .opacity))
                    } else {
                        CardView(.slot, k: k)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(boardLabel)
            .accessibilityIdentifier("table.board")
            VStack(spacing: 2) {
                if let result {
                    ForEach(Array(Bet.potLines(result) { TableWords.nameOf(view, $0) }.enumerated()), id: \.offset) {
                        Text($0.element)
                    }
                }
            }
            .font(.system(size: Metrics.textS, weight: .semibold))
            .foregroundStyle(Palette.gold.color)
            .inkShadow()
            .multilineTextAlignment(.center)
            .frame(minHeight: 36, alignment: .top)
            .frame(maxWidth: stage.width - 120)
            .accessibilityElement(children: .ignore)
            // One line per pot, as the page's result reads.
            .accessibilityLabel(result.map { Bet.potLines($0) { TableWords.nameOf(view, $0) }.joined(separator: "\n") } ?? "")
            .accessibilityIdentifier("table.result")
        }
        .position(x: stage.width / 2, y: stage.height * 0.5)
    }

    private var boardLabel: String {
        let cards = view.hand?.board ?? []
        return cards.isEmpty ? "Board: no cards" : "Board: " + cards.map(Wording.cardName).joined(separator: ", ")
    }

    // MARK: A seat

    @ViewBuilder private func seatView(
        _ info: SeatInfo, seat: Int, place: Int, spot: TableLayout.Spot, at point: CGPoint, stage: CGSize, mine: CGSize
    ) -> some View {
        let hand = view.hand
        let result = hand?.result
        let turn = TableWords.inHand(view) ? view.turn : nil
        let won = result.flatMap { $0.winnings[safe: seat] } ?? 0
        let relation = Safety.relationText(model.relationOf(info.ref))
        let reaction = table.reactions[seat]?.text
        let side = TableLayout.sideOf(spot, place: place)
        if place == 0 && seat == view.you.seat {
            MySeatView(
                info: info, cards: info.cards, button: hand?.button == seat, turn: turn,
                clockOffset: table.clockOffset, won: won, reaction: reaction, width: mine.width
            )
            .position(x: point.x, y: stage.height + Self.hang - mine.height / 2)
        } else {
            PodView(
                info: info, side: side, button: hand?.button == seat, turn: turn, clockOffset: table.clockOffset,
                won: won, reaction: reaction, relation: relation
            )
            .position(point)
            .onTapGesture { if info.kind == .human { onSelect(seat) } }
            .accessibilityAddTraits(info.kind == .human ? .isButton : [])
            .accessibilityAction { if info.kind == .human { onSelect(seat) } }
        }
        if info.bet > 0 && result == nil {
            let bet = TableLayout.betSpot(spot, place: place, shape: .tall)
            let y = bet.top / 100 * stage.height + (bet.shift.map(Self.length) ?? 0)
            let x = bet.left / 100 * stage.width
            // The guest's bet stands clear of their own cards, which are larger than a pod.
            let top = place == 0 ? min(y, stage.height + Self.hang - mine.height - 16) : y
            BetChip(amount: info.bet, bigBlind: view.settings.bigBlind)
                .position(x: x, y: top)
                .transition(reduceMotion ? .identity : .scale(scale: 0.6).combined(with: .opacity))
                .accessibilityIdentifier("table.bet.\(seat)")
        }
    }
}

/// A bet in front of a seat: its chip and amount.
struct BetChip: View {
    let amount: Int
    let bigBlind: Int

    var body: some View {
        HStack(spacing: 3) {
            ArtView(named: Faces.chip(amount, bigBlind: bigBlind)).frame(width: 14, height: 14)
            Text("Bet \(amount)")
                .font(.system(size: Metrics.textXS, weight: .semibold))
                .foregroundStyle(Palette.paper.color)
                .monospacedDigit()
        }
        .padding(.leading, 3)
        .padding(.trailing, 6)
        .padding(.vertical, 1)
        .background(Palette.ink.color.opacity(0.94), in: .capsule)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Bet \(amount)")
    }
}

/// A place nobody sits in: a dashed outline, held for someone, or a button to take it.
struct EmptySeatView: View {
    let kind: TableWords.EmptySeat
    let seat: Int
    let busy: Bool
    let take: () -> Void

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Metrics.radiusM)
        let colour: RGB =
            switch kind {
            case .open: Palette.gold
            case .mine, .held: Palette.amberDark
            case .empty: Palette.feltLight
            }
        let label = Text(kind.text)
            .font(.system(size: Metrics.textXS, weight: kind == .open ? .semibold : .regular))
            .foregroundStyle(kind == .open ? Palette.goldLight.color : kind == .empty ? Palette.haze.color : Palette.amber.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Palette.ink.color.opacity(kind == .open ? 0.6 : 0.35), in: shape)
            .overlay(shape.strokeBorder(colour.color, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])))
        if kind == .open {
            Button(action: take) { label }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityLabel("Sit here, seat \(seat + 1)")
                .accessibilityIdentifier("table.sitHere.\(seat)")
        } else {
            label
                .accessibilityLabel("Seat \(seat + 1): \(kind.text)")
                .accessibilityIdentifier("table.seat.\(seat)")
        }
    }
}

// MARK: - Seats

/// The words a seat says for VoiceOver: its name, the stack and how it stands.
func seatLabel(_ info: SeatInfo, me: Bool) -> String {
    var words = [Faces.label(info, me: me), "\(ConfigResponse.chips(info.stack)) chips"]
    let status = Faces.status(info)
    if !status.isEmpty { words.append(status) }
    return words.joined(separator: ", ")
}

/// The turn's clock: a bar that shortens, gold, then red once the time bank runs.
struct TurnClock: View {
    let turn: Turn
    let clockOffset: Double
    let width: Double
    var showsSeconds = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.25)) { context in
            let left = TableLayout.clockLeft(turn, now: context.date.timeIntervalSince1970 - clockOffset)
            HStack(spacing: 4) {
                Capsule()
                    .fill(Palette.ink.color.opacity(0.6))
                    .frame(width: width, height: 4)
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(left.bank ? Palette.red.color : Palette.greenLight.color)
                            .frame(width: max(4, width * left.fraction), height: 4)
                    }
                if showsSeconds {
                    Text(left.bank ? "bank \(left.seconds)s" : "\(left.seconds)s")
                        .font(.system(size: Metrics.textXS).monospacedDigit())
                        .foregroundStyle(left.bank ? Palette.redLight.color : Palette.greenLight.color)
                }
            }
            .accessibilityElement()
            .accessibilityLabel(left.bank ? "Time bank, \(left.seconds) seconds" : "\(left.seconds) seconds")
        }
    }
}

/// A reaction showing beside a seat for a few seconds.
struct ReactionBubble: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: Metrics.textXS, weight: .semibold))
            .foregroundStyle(Palette.ink.color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Palette.paper.color, in: .capsule)
            .fixedSize()
            .accessibilityLabel("Reaction: \(text)")
    }
}

/// Another player's seat on a phone: a compact pod of a fixed size centred on its place, so
/// nothing that comes and goes in it moves it. The cards they show sit beside it, towards
/// the middle, and a small card-back badge says they hold cards.
struct PodView: View {
    let info: SeatInfo
    let side: TableLayout.Side
    let button: Bool
    let turn: Turn?
    let clockOffset: Double
    let won: Int
    let reaction: String?
    let relation: String

    /// The pod's outer size; its frame's border takes six points of each side.
    static let size = CGSize(width: 86, height: 64)
    static let inner = CGSize(width: size.width - 12, height: size.height - 12)

    var body: some View {
        let acting = turn?.seat == info.seat
        let dim = info.folded || info.sittingOut
        VStack(spacing: 2) {
            HStack(spacing: 4) {
                ArtView(named: Faces.avatar(info)).frame(width: 20, height: 20)
                Text(name)
                    .font(.system(size: Metrics.textXS, weight: .semibold))
                    .foregroundStyle(Palette.paper.color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Text(ConfigResponse.chips(info.stack))
                .font(.system(size: Metrics.textXS).monospacedDigit())
                .foregroundStyle(Palette.goldLight.color)
            HStack(spacing: 3) {
                if info.kind == .bot { SmallTag(text: "Bot", colour: Palette.violetDeep, ink: Palette.violetLight) }
                let status = Faces.status(info)
                if !status.isEmpty { SmallTag(text: status, colour: Palette.ink, ink: Palette.paperShade) }
                if !relation.isEmpty { SmallTag(text: relation, colour: Palette.redDeep, ink: Palette.redLight) }
            }
            .frame(height: 13)
        }
        .frame(width: Self.inner.width, height: Self.inner.height)
        .kitFrame(acting ? .glow : .panel)
        .opacity(dim ? 0.6 : 1)
        .overlay(alignment: .bottom) {
            if let turn, acting {
                TurnClock(turn: turn, clockOffset: clockOffset, width: Self.size.width - 16).offset(y: 6)
            }
        }
        .overlay(alignment: badgeCorner) {
            if info.hasCards && info.cards == nil && !info.folded {
                ArtView(named: "mini-cards").frame(width: 18, height: 14).offset(x: badgeX, y: -6)
            }
        }
        .overlay(alignment: buttonCorner) {
            if button { ArtView(named: "dealer").frame(width: 16, height: 16).offset(x: buttonX, y: buttonY) }
        }
        .overlay(alignment: shownAlignment) {
            if let cards = info.cards, !cards.isEmpty {
                HStack(spacing: -8) {
                    ForEach(Array(cards.enumerated()), id: \.offset) { CardView($0.element, k: 0.42) }
                }
                .offset(shownOffset)
            }
        }
        .overlay(alignment: .top) {
            VStack(spacing: 2) {
                if let reaction { ReactionBubble(text: reaction) }
                if won > 0 {
                    Text("+\(ConfigResponse.chips(won))")
                        .font(.system(size: Metrics.textS, weight: .bold))
                        .foregroundStyle(Palette.goldLight.color)
                        .inkShadow()
                        .fixedSize()
                }
            }
            .offset(y: -16)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(seatLabel(info, me: false) + shownWords + (won > 0 ? ", wins \(won)" : ""))
        .accessibilityIdentifier("table.seat.\(info.seat)")
    }

    /// The cards they show, in words.
    private var shownWords: String {
        guard let cards = info.cards, !cards.isEmpty else { return "" }
        return ", shows " + cards.map(Wording.cardName).joined(separator: " and ")
    }

    /// A bot's pod shows the part of its name that tells it from the others (D-7: the tag
    /// says it is a bot); a person's shows their whole handle.
    private var name: String {
        info.kind == .bot ? Faces.podName(info.name).filter(\.pod).map(\.text).joined() : info.name
    }

    private var badgeCorner: Alignment {
        switch side {
        case .right, .lowLeft: .topLeading
        default: .topTrailing
        }
    }

    private var badgeX: Double { badgeCorner == .topLeading ? -8 : 8 }

    private var buttonCorner: Alignment {
        switch side {
        case .right: .topTrailing
        case .lowLeft: .bottomLeading
        case .lowRight: .bottomTrailing
        default: .topLeading
        }
    }

    private var buttonX: Double { buttonCorner == .topTrailing || buttonCorner == .bottomTrailing ? 6 : -6 }
    private var buttonY: Double { buttonCorner == .bottomLeading || buttonCorner == .bottomTrailing ? 6 : -8 }

    private var shownAlignment: Alignment {
        switch side {
        case .left: .trailing
        case .right: .leading
        case .top: .bottom
        default: .top
        }
    }

    private var shownOffset: CGSize {
        switch side {
        case .left: CGSize(width: 50, height: 0)
        case .right: CGSize(width: -50, height: 0)
        case .top: CGSize(width: 0, height: 44)
        default: CGSize(width: 0, height: -36)
        }
    }
}

struct SmallTag: View {
    let text: String
    let colour: RGB
    let ink: RGB

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .lineLimit(1)
            .padding(.horizontal, 3)
            .background(colour.color, in: .rect(cornerRadius: 3))
            .foregroundStyle(ink.color)
    }
}

/// The guest's own seat at the bottom centre: their cards, larger than a pod, over a plate
/// with their name and stack, and the turn's clock hanging under it.
struct MySeatView: View {
    let info: SeatInfo
    let cards: [Card]?
    let button: Bool
    let turn: Turn?
    let clockOffset: Double
    let won: Int
    let reaction: String?
    let width: Double

    static let cardK = 0.8
    /// The plate's outer height; its frame's border takes six points of each side.
    static let plate = 48.0
    /// How far the cards sink behind the plate.
    static let tuck = CardView.height * cardK * 0.22
    /// Room under the plate for the turn's clock.
    static let clockRoom = 18.0

    static func size(width: Double) -> CGSize {
        CGSize(width: min(220, width * 0.75 - 92), height: CardView.height * cardK - tuck + plate + clockRoom)
    }

    var body: some View {
        let acting = turn?.seat == info.seat
        VStack(spacing: -Self.tuck) {
            HStack(spacing: -CardView.width * Self.cardK * 0.35) {
                if let cards, !cards.isEmpty {
                    ForEach(Array(cards.enumerated()), id: \.offset) { index, card in
                        CardView(card, k: Self.cardK)
                            .rotationEffect(.degrees(index == 0 ? -4 : 4), anchor: .bottom)
                    }
                } else {
                    Color.clear.frame(width: CardView.width * Self.cardK, height: CardView.height * Self.cardK)
                }
            }
            .opacity(info.folded ? 0.5 : 1)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(cardsLabel)
            .accessibilityIdentifier("table.myCards")
            HStack(spacing: 6) {
                ArtView(named: Faces.avatar(info)).frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 0) {
                    Text(info.name)
                        .font(.system(size: Metrics.textS, weight: .semibold))
                        .foregroundStyle(Palette.goldLight.color)
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        Text(ConfigResponse.chips(info.stack))
                            .font(.system(size: Metrics.textS).monospacedDigit())
                            .foregroundStyle(Palette.paper.color)
                            .accessibilityIdentifier("table.myStack")
                        let status = Faces.status(info)
                        if !status.isEmpty { SmallTag(text: status, colour: Palette.ink, ink: Palette.paperShade) }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 2)
            .frame(width: width - 12, height: Self.plate - 12)
            .kitFrame(acting ? .glow : .gold)
            .overlay(alignment: .topTrailing) {
                if button { ArtView(named: "dealer").frame(width: 16, height: 16).offset(x: 6, y: -6) }
            }
            .overlay(alignment: .bottom) {
                if let turn, acting {
                    TurnClock(turn: turn, clockOffset: clockOffset, width: width - 60, showsSeconds: true)
                        .offset(y: Self.clockRoom)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(seatLabel(info, me: true) + (won > 0 ? ", wins \(won)" : ""))
            .accessibilityIdentifier("table.seat.\(info.seat)")
        }
        .overlay(alignment: .topTrailing) {
            VStack(alignment: .trailing, spacing: 2) {
                if let reaction { ReactionBubble(text: reaction) }
                if won > 0 {
                    Text("+\(ConfigResponse.chips(won))")
                        .font(.system(size: Metrics.textM, weight: .bold))
                        .foregroundStyle(Palette.goldLight.color)
                        .inkShadow()
                        .fixedSize()
                        .accessibilityIdentifier("table.myWin")
                }
            }
            .offset(x: 8, y: 4)
        }
        .padding(.bottom, Self.clockRoom)
        .frame(width: width)
    }

    private var cardsLabel: String {
        guard let cards, !cards.isEmpty else { return "Your cards: none" }
        return "Your cards: " + cards.map(Wording.cardName).joined(separator: ", ")
    }
}
