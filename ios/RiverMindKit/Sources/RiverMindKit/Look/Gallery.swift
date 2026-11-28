import SwiftUI

// Debug builds only, as the gallery screen is: a release build of the app carries none of it.
#if DEBUG

/// Every component of the kit in its states (P5D.5): the app's `/style`. The debug build's
/// gallery screen shows these, and `KitSnapshotTests` renders each and compares it with
/// its recorded snapshot.
public struct GalleryItem: Identifiable, Sendable {
    public let id: String
    public let section: String
    public let title: String
    /// The item's size on the page, in points.
    public let width: Double
    public let height: Double
    let make: @MainActor @Sendable () -> AnyView

    @MainActor public var view: some View {
        make()
            .frame(width: width, height: height)
            .background(Palette.night.color)
            .environment(\.colorScheme, .dark)
    }
}

public enum KitGallery {
    public static let sections = ["Buttons", "Frames", "Fields", "Type", "Palette", "Cards", "Sprites", "Table"]

    public static var items: [GalleryItem] {
        buttons + frames + fields + type + palette + cards + sprites + table
    }

    static func item(
        _ id: String, _ section: String, _ title: String, width: Double, height: Double,
        @ViewBuilder _ view: @escaping @MainActor @Sendable () -> some View
    ) -> GalleryItem {
        GalleryItem(id: id, section: section, title: title, width: width, height: height) { AnyView(view()) }
    }

    static var buttons: [GalleryItem] {
        var items: [GalleryItem] = []
        for kind in ButtonKind.allCases {
            items.append(
                item("button-\(kind.rawValue)", "Buttons", kind.rawValue.capitalized, width: 330, height: 64) {
                    HStack(spacing: 8) {
                        KitButtonFace(kind: kind) { Text("Raise") }
                        KitButtonFace(kind: kind, state: .pressed) { Text("Pressed") }
                        KitButtonFace(kind: kind, state: .disabled) { Text("Off") }
                        KitButtonFace(kind: kind, small: true) { Text("Small") }
                    }
                })
        }
        items.append(
            item("button-choice", "Buttons", "A choice", width: 330, height: 64) {
                HStack(spacing: 8) {
                    KitButtonFace(kind: .slate) { Text("2 seats") }
                    KitButtonFace(kind: .slate, chosen: true) { Text("6 seats") }
                    KitButtonFace(kind: .slate) { Text("9 seats") }
                }
            })
        items.append(
            item("button-action", "Buttons", "The turn’s actions", width: 330, height: 64) {
                HStack(spacing: 8) {
                    KitButtonFace(kind: .red, wide: true) { Text("Fold") }
                    KitButtonFace(kind: .blue, wide: true) { Text("Call 40") }
                    KitButtonFace(kind: .gold, wide: true) { Text("Raise to 120") }
                }
                .padding(.horizontal, 8)
            })
        return items
    }

    static var frames: [GalleryItem] {
        FrameKind.allCases.map { kind in
            item("frame-\(kind.rawValue)", "Frames", kind.rawValue.capitalized, width: 330, height: 76) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(frameTitle(kind)).font(.system(size: Metrics.textM, weight: .semibold))
                    Text(frameNote(kind)).font(.system(size: Metrics.textS))
                        .foregroundStyle(kind == .paper ? Palette.ink.color : Palette.mist.color)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .kitFrame(kind)
                .padding(10)
            }
        }
    }

    static func frameTitle(_ kind: FrameKind) -> String {
        switch kind {
        case .panel: "Panel"
        case .raised: "Raised"
        case .inset: "Inset"
        case .paper: "Paper"
        case .gold: "Your seat"
        case .glow: "To act"
        case .danger: "Something went wrong"
        }
    }

    static func frameNote(_ kind: FrameKind) -> String {
        switch kind {
        case .panel: "A panel on the page"
        case .raised: "A panel on a panel"
        case .inset: "A well sunk into a panel"
        case .paper: "Dark text on light"
        case .gold: "The viewer’s own seat"
        case .glow: "The seat whose turn it is"
        case .danger: "The connection dropped"
        }
    }

    static var fields: [GalleryItem] {
        [
            item("field", "Fields", "Text and number fields", width: 330, height: 110) {
                // The field's chrome round text, as `KitFieldStyle` puts it round a text field.
                VStack(spacing: 10) {
                    Text("Buy-in").foregroundStyle(Palette.haze.color)
                        .frame(maxWidth: .infinity, alignment: .leading).modifier(KitFieldChrome())
                    Text("1,250")
                        .frame(maxWidth: .infinity, alignment: .leading).modifier(KitFieldChrome())
                }
                .font(.system(size: Metrics.textM))
                .padding(10)
            }
        ]
    }

    static var type: [GalleryItem] {
        [
            item("type", "Type", "Text sizes", width: 330, height: 150) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("RiverMind Poker").font(.system(size: Metrics.textXL, weight: .bold))
                    Text("Your table").font(.system(size: Metrics.textL, weight: .semibold))
                    Text("Raise to 120 chips").font(.system(size: Metrics.textM))
                    Text("Blinds 10/20 · 6 seats").font(.system(size: Metrics.textS)).foregroundStyle(
                        Palette.mist.color)
                    Text("Bots are always labelled").font(.system(size: Metrics.textXS)).foregroundStyle(
                        Palette.haze.color)
                }
                .foregroundStyle(Palette.paper.color)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            },
            item("type-colours", "Type", "Text colours on surfaces", width: 330, height: 200) {
                Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                    ForEach(ContrastPairs.surfaces, id: \.self) { surface in
                        GridRow {
                            ForEach(ContrastPairs.text, id: \.self) { text in
                                Text("A")
                                    .font(.system(size: Metrics.textS, weight: .semibold))
                                    .foregroundStyle(colour(text))
                                    .frame(width: 26, height: 30)
                                    .background(colour(surface))
                            }
                        }
                    }
                }
                .padding(4)
            },
        ]
    }

    static func colour(_ name: String) -> Color {
        Palette.all.first { $0.name == name }?.rgb.color ?? .clear
    }

    static var palette: [GalleryItem] {
        [
            item("palette", "Palette", "Every colour", width: 330, height: 250) {
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(36), spacing: 4), count: 8), spacing: 4) {
                    ForEach(Palette.all, id: \.name) { entry in
                        RoundedRectangle(cornerRadius: 4).fill(entry.rgb.color)
                            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Shadows.edge.color))
                            .frame(width: 36, height: 30)
                    }
                }
                .padding(4)
            }
        ]
    }

    static var cards: [GalleryItem] {
        var items: [GalleryItem] = []
        for suit in Suit.known {
            items.append(
                item("cards-\(suit.rawValue)", "Cards", suit.rawValue.capitalized, width: 330, height: 130) {
                    // Thirteen faces fanned, each 36 card units along from the one before, where a
                    // ten's index ends, as the site's compact hand has them (kit.css `.card-peek`).
                    HStack(spacing: (36 - CardView.width) * 0.6) {
                        ForEach(2...14, id: \.self) { rank in
                            CardView(Card(rank: rank, suit: suit), k: 0.6)
                        }
                    }
                })
        }
        items.append(
            item("cards-backs", "Cards", "Backs and the slot", width: 330, height: 120) {
                HStack(spacing: 8) {
                    ForEach(CardBack.allCases, id: \.self) { CardView(.back($0)) }
                    CardView(.slot).padding(4).background(Palette.felt.color, in: .rect(cornerRadius: 8))
                }
            })
        items.append(
            item("cards-sizes", "Cards", "At a seat, on the board and in a list", width: 330, height: 130) {
                HStack(alignment: .bottom, spacing: 10) {
                    CardView(Card(rank: 14, suit: .spades), k: 1.2)
                    CardView(Card(rank: 10, suit: .hearts), k: 1)
                    CardView(Card(rank: 12, suit: .diamonds), k: 0.75)
                    CardView(Card(rank: 7, suit: .clubs), k: 0.5)
                }
            })
        return items
    }

    static var sprites: [GalleryItem] {
        let groups: [(String, String, [String])] = [
            ("sprites-chips", "Chips, the pot and the button",
             ["chip-white", "chip-red", "chip-blue", "chip-green", "chip-black", "chip-violet", "chip-gold", "dealer"]),
            ("sprites-people", "People and bots",
             (0..<6).map { "avatar-person-\($0)" } + ["avatar-heuristic", "avatar-random", "avatar-calling-station",
                                                     "avatar-medium", "avatar-hard", "avatar-bot"]),
            ("sprites-voice", "The mark, a hidden hand and voice",
             ["emblem", "mini-cards", "pot", "voice-mic", "voice-mic-muted", "voice-phones", "voice-phones-muted",
              "voice-out"]),
        ]
        return groups.map { id, title, names in
            item(id, "Sprites", title, width: 330, height: 100) {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 6), spacing: 6) {
                    ForEach(names, id: \.self) { name in
                        let art = ArtLibrary.pieces[name]!
                        ArtView(art).frame(width: art.width, height: art.height)
                    }
                }
                .padding(8)
                .background(Palette.felt.color)
            }
        }
    }

    static var table: [GalleryItem] {
        [
            item("table", "Table", "The felt and its rail", width: 330, height: 220) {
                ZStack {
                    TableFelt(unit: 2)
                    HStack(spacing: 4) {
                        ForEach([Card(rank: 14, suit: .hearts), Card(rank: 13, suit: .spades), Card(rank: 7, suit: .clubs)], id: \.self) {
                            CardView($0, k: 0.6)
                        }
                        CardView(.slot, k: 0.6)
                        CardView(.slot, k: 0.6)
                    }
                }
                .padding(12)
            }
        ]
    }
}

#endif
