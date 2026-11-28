import Foundation
import SwiftUI
import Testing
@testable import RiverMindKit

/// The site's tokens in the app (P5D.5): Tokens.swift is what `pnpm art` wrote from
/// theme.css, and the app's text and controls meet the contrast theme.spec.ts measures
/// on the same pairs.
struct TokenTests {
    static func rgb(_ name: String) throws -> RGB {
        try #require(Palette.all.first { $0.name == name }?.rgb, "no colour \(name)")
    }

    @Test("the palette is theme.css's, name for name")
    func paletteMatchesTheSite() throws {
        let css = try String(contentsOf: repository.appending(path: "web/src/styles/theme.css"), encoding: .utf8)
        let named = css.matches(of: /--color-([a-z0-9-]+): #([0-9a-f]{6});/).map {
            (String($0.output.1), String($0.output.2))
        }
        #expect(named.count == Palette.all.count)
        for ((name, hex), entry) in zip(named, Palette.all) {
            #expect(entry.name == name)
            #expect(entry.rgb.description == "#\(hex)", "\(name)")
        }
        #expect(Palette.night.description == "#11141b")
        #expect(Palette.gold.description == "#f0bd4f")
    }

    @Test("text meets 4.5:1 on every surface, and on the colours of its own")
    func textContrast() throws {
        for text in ContrastPairs.text {
            for surface in ContrastPairs.surfaces {
                let ratio = try Self.rgb(text).contrast(with: Self.rgb(surface))
                #expect(ratio >= 4.5, "\(text) on \(surface): \(ratio)")
            }
        }
        for (text, surface) in ContrastPairs.labels {
            let ratio = try Self.rgb(text).contrast(with: Self.rgb(surface))
            #expect(ratio >= 4.5, "\(text) on \(surface): \(ratio)")
        }
    }

    @Test("controls and focus meet 3:1 on what they sit on")
    func controlContrast() throws {
        for (control, surface) in ContrastPairs.controls {
            let ratio = try Self.rgb(control).contrast(with: Self.rgb(surface))
            #expect(ratio >= 3, "\(control) on \(surface): \(ratio)")
        }
    }

    @Test("the buttons' labels meet 4.5:1 on their faces, pressed or not")
    func buttonLabels() {
        let all = ButtonKind.allCases.map(\.colours) + [ButtonPalette.chosen]
        for colours in all {
            #expect(colours.label.rgb.contrast(with: colours.face.rgb) >= 4.5, "\(colours)")
            #expect(colours.label.rgb.contrast(with: colours.down.rgb) >= 4.5, "\(colours) pressed")
        }
        // A disabled button's label is quieter, as WCAG allows an inactive control.
        #expect(ButtonPalette.disabled.label.rgb.contrast(with: ButtonPalette.disabled.face.rgb) >= 3)
    }

    @Test("the contrast is WCAG's", arguments: [
        (RGB(0x000000), RGB(0xffffff), 21.0), (RGB(0x777777), RGB(0xffffff), 4.48), (RGB(0x11141b), RGB(0x11141b), 1.0),
    ])
    func wcag(a: RGB, b: RGB, ratio: Double) {
        #expect(abs(a.contrast(with: b) - ratio) < 0.01)
    }

    @Test("the motion is the site's")
    func motion() {
        #expect(Motion.easeOut == Curve(0.2, 0.7, 0.2, 1))
        #expect(Motion.drop.duration == 0.24 && !Motion.drop.repeats)
        #expect(Motion.nudge.repeats)
        #expect(Shadows.elevation2.radius == 7)
        #expect(Metrics.radiusM == 10 && Metrics.textM == 16)
    }
}

/// SVG path data as the art uses it, and the rest of SVG's commands.
struct SVGPathTests {
    func bounds(_ data: String) throws -> CGRect { try SVGPath.parse(data).boundingRect }

    @Test("lines, absolute and relative, horizontal and vertical")
    func lines() throws {
        #expect(try bounds("M1 2L5 6") == CGRect(x: 1, y: 2, width: 4, height: 4))
        #expect(try bounds("M1 2l4 4") == CGRect(x: 1, y: 2, width: 4, height: 4))
        #expect(try bounds("M1 2H9V12") == CGRect(x: 1, y: 2, width: 8, height: 10))
        #expect(try bounds("m1 2h8v10z") == CGRect(x: 1, y: 2, width: 8, height: 10))
        // Pairs after a moveto are linetos; numbers may run together.
        #expect(try bounds("M0,0 10,0 10-10") == CGRect(x: 0, y: -10, width: 10, height: 10))
        #expect(try bounds("M.5.5L1e1 2") == CGRect(x: 0.5, y: 0.5, width: 9.5, height: 1.5))
    }

    @Test("an arc is the ellipse's, whichever way it sweeps")
    func arcs() throws {
        // Half a circle of radius 5 below the line from (0, 0) to (10, 0), and above it.
        let below = try bounds("M0 0A5 5 0 0 0 10 0")
        #expect(abs(below.minY) < 1e-9 && abs(below.maxY - 5) < 1e-6)
        let above = try bounds("M0 0A5 5 0 0 1 10 0")
        #expect(abs(above.minY + 5) < 1e-6 && abs(above.maxY) < 1e-9)
        // Too small a radius is scaled up to reach; the large-arc flag takes the long way.
        let scaled = try bounds("M0 0A1 1 0 0 0 10 0")
        #expect(abs(scaled.maxY - 5) < 1e-6)
        let large = try bounds("M0 0A10 10 0 1 0 10 0")
        #expect(large.height > 10)
        // The avatars' shoulders.
        #expect(try bounds("M6.6 27.6C7.6 23.2 11.2 20.6 16 20.6C20.8 20.6 24.4 23.2 25.4 27.6A15 15 0 0 1 6.6 27.6Z").maxY < 31.1)
    }

    @Test("curves, smooth curves and quadratics")
    func curves() throws {
        #expect(try bounds("M0 0C0 10 10 10 10 0").maxY == 7.5)
        #expect(try bounds("M0 0Q5 10 10 0T20 0").minY == -5)
        #expect(try bounds("M0 0C0 10 10 10 10 0S20 -10 20 0").minY == -7.5)
    }

    @Test("data that is not a path is refused", arguments: ["L1 2", "M1", "M1 2X3", "M0 0Z 5", "M0 0A1 1 0 2 0 1 1"])
    func refused(_ data: String) {
        #expect(throws: SVGPath.ParseError.self) { try SVGPath.parse(data) }
    }

    @Test("every path in the art reads")
    func artReads() throws {
        for (name, art) in ArtLibrary.pieces {
            for shape in art.shapes {
                if case let .path(data) = shape.geometry {
                    #expect(throws: Never.self, "\(name)") { try SVGPath.parse(data) }
                }
            }
        }
    }

    @Test("a card is the face its name says, and a card this build does not know shows face down")
    @MainActor
    func cards() {
        #expect(CardView(Card(rank: 14, suit: .spades)).label == "Ace of spades")
        #expect(CardView(Card(rank: 10, suit: .hearts)).label == "10 of hearts")
        #expect(CardView(.back(.navy)).label == "Face-down card")
        #expect(CardView(.slot).label == "Empty card slot")
        let unknown = CardView(Card(rank: 14, suit: Suit(rawValue: "stars")))
        #expect(unknown.art.shapes.count == CardBack.burgundy.art.shapes.count)
    }
}
