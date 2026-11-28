import SwiftUI

/// Draws one of the site's drawings (`ArtLibrary`) natively, scaled to fill its frame
/// (P5D.5). A shape's stroke is drawn in the shape's own space, so a scaled shape's stroke
/// scales with it, as in SVG.
public struct ArtView: View {
    public let art: Art

    public init(_ art: Art) { self.art = art }

    /// A piece of the library by name; an unknown name draws nothing.
    public init(named name: String) {
        art = ArtLibrary.pieces[name] ?? Art(width: 1, height: 1, shapes: [])
    }

    public var body: some View {
        Canvas { context, size in
            context.scaleBy(x: size.width / art.width, y: size.height / art.height)
            for shape in art.shapes {
                var drawn = context
                drawn.concatenate(shape.affine)
                let path = shape.path
                if let fill = shape.fill { drawn.fill(path, with: .color(fill.color)) }
                if let pen = shape.stroke { drawn.stroke(path, with: .color(pen.paint.color), style: pen.style) }
            }
        }
        .aspectRatio(art.width / art.height, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// The card backs, the site's default first (deck.js `BACKS`).
public enum CardBack: String, CaseIterable, Sendable {
    case burgundy = "lattice-burgundy"
    case navy = "lattice-navy"
    case green = "lattice-green"

    public var art: Art { ArtLibrary.pieces["back-\(rawValue)"]! }
}

/// A card of the site's deck at `k` points per card unit (the site's `--k`): a face, a
/// face-down card, or the empty board slot.
public struct CardView: View {
    public enum Showing: Sendable, Hashable {
        case face(Card)
        case back(CardBack)
        case slot
    }

    public static let width = 71.0
    public static let height = 95.0

    public let showing: Showing
    public let k: Double

    public init(_ showing: Showing, k: Double = 1) {
        self.showing = showing
        self.k = k
    }

    public init(_ card: Card, k: Double = 1) {
        self.init(.face(card), k: k)
    }

    public var body: some View {
        ArtView(art)
            .frame(width: Self.width * k, height: Self.height * k)
            .accessibilityElement()
            .accessibilityLabel(label)
    }

    var art: Art {
        switch showing {
        case let .face(card):
            // A suit or rank this build does not know shows face down rather than wrong.
            ArtLibrary.pieces["\(card.rank)-\(card.suit.rawValue)"] ?? CardBack.burgundy.art
        case let .back(back): back.art
        case .slot: ArtLibrary.pieces["slot"]!
        }
    }

    /// What the site's alt text says: “Ace of spades”, “Face-down card”, “Empty card slot”.
    public var label: String {
        switch showing {
        case let .face(card):
            let names = [11: "Jack", 12: "Queen", 13: "King", 14: "Ace"]
            return "\(names[card.rank] ?? String(card.rank)) of \(card.suit.rawValue)"
        case .back: return "Face-down card"
        case .slot: return "Empty card slot"
        }
    }
}

/// The RiverMind mark: a gold spade with a river running across it.
public struct Mark: View {
    public init() {}

    public var body: some View {
        ArtView(named: "emblem")
            .accessibilityElement()
            .accessibilityLabel("RiverMind")
    }
}
