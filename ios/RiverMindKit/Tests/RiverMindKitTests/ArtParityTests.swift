import Foundation
import SwiftUI
import Testing
@testable import RiverMindKit

extension LookRendering {
    /// The site's art in the app (P5D.5): every card and sprite `ArtView` draws from the
    /// generated `ArtLibrary` must match what Chromium draws from the site's own SVG, at 2
    /// and 3 pixels a point. `pnpm ios:fixtures` draws the reference sheets
    /// (web/src/lib/art/ios-art.spec.ts), and Vitest fails while they are stale.
    ///
    /// The two renderers smooth edges differently (Skia and Core Graphics), so a pixel on an
    /// edge may differ; a wrong colour, a missing shape or a shape out of place moves the
    /// mean and the share of pixels far apart well past the limits below.
    @MainActor
    struct ArtParityTests {
        struct Index: Decodable {
            struct Spot: Decodable {
                let name: String
                let x: Double
                let y: Double
                let width: Double
                let height: Double
            }
            let scales: [Int]
            let pieces: [Spot]
        }

        static let fixtures = repository.appending(path: "ios/RiverMindKit/Fixtures")

        static func index() throws -> Index {
            try JSONDecoder().decode(Index.self, from: Data(contentsOf: fixtures.appending(path: "art.json")))
        }

        /// The limits: a mean channel difference and a share of pixels far apart. A sprite is
        /// small, so its edges, where the renderers differ, are more of it than of a card.
        static func limits(_ art: Art) -> (mean: Double, far: Double) {
            art.width == CardView.width ? (1.5, 0.01) : (3, 0.015)
        }

        static func within(_ difference: Bitmap.Difference, _ art: Art) -> Bool {
            let (mean, far) = limits(art)
            return difference.mean <= mean && difference.farShare <= far
        }

        @Test("every piece of the library is in the reference, and nothing else")
        func namesMatch() throws {
            let names = try Self.index().pieces.map(\.name)
            #expect(Set(names) == Set(ArtLibrary.pieces.keys))
            #expect(names.count == ArtLibrary.pieces.count)
            // 52 faces, three backs and the slot.
            #expect(names.filter { $0.first!.isNumber }.count == 52)
        }

        @Test("ArtView draws each piece as Chromium draws the site's SVG", arguments: [2, 3])
        func matchesTheSite(scale: Int) async throws {
            let index = try Self.index()
            #expect(index.scales.contains(scale))
            let url = Self.fixtures.appending(path: "art@\(scale)x.png")
            let sheet = try #require(Bitmap.read(url), "no reference sheet at \(url.path)")
            var worst: [(String, Bitmap.Difference)] = []
            for spot in index.pieces {
                // Other suites' tests wait on the main actor too: let them in between drawings.
                await Task.yield()
                let art = try #require(ArtLibrary.pieces[spot.name])
                #expect(art.width == spot.width && art.height == spot.height, "\(spot.name)'s size")
                let s = Double(scale)
                let theirs = Bitmap(
                    sheet, crop: CGRect(x: spot.x * s, y: spot.y * s, width: spot.width * s, height: spot.height * s))
                let ours = try #require(render(ArtView(art), width: art.width, height: art.height, scale: s))
                let difference = ours.difference(from: theirs)
                worst.append((spot.name, difference))
                #expect(Self.within(difference, art), "\(spot.name) at @\(scale)x: \(difference)")
                if ProcessInfo.processInfo.environment["RIVERMIND_ART_DIFF"] != nil {
                    let out = URL(filePath: NSTemporaryDirectory()).appending(path: "rivermind-art")
                    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                    try ours.write(out.appending(path: "\(spot.name)@\(scale)x-app.png"))
                    try theirs.write(out.appending(path: "\(spot.name)@\(scale)x-site.png"))
                }
            }
            for cards in [true, false] {
                let top = worst.filter { $0.0.first!.isNumber == cards }.sorted { $0.1.mean > $1.1.mean }.prefix(2)
                print("@\(scale)x, the \(cards ? "faces" : "rest") furthest apart:", top.map { "\($0.0) \($0.1)" }.joined(separator: "; "))
            }
        }

        /// The limits catch a drawing that is wrong: each face against the next rank's, each
        /// card against the same rank in the next suit, each back against the next, each chip
        /// against the next chip and each avatar against the next.
        @Test("the limits fail a wrong rank, suit, colour or figure")
        func limitsCatchMistakes() async throws {
            let index = try Self.index()
            let url = Self.fixtures.appending(path: "art@2x.png")
            let sheet = try #require(Bitmap.read(url))
            let spots = Dictionary(uniqueKeysWithValues: index.pieces.map { ($0.name, $0) })
            var pairs: [(String, String)] = []
            let suits = ["spades", "hearts", "diamonds", "clubs"]
            for (s, suit) in suits.enumerated() {
                for rank in 2...14 {
                    pairs.append(("\(rank)-\(suit)", "\(rank == 14 ? 2 : rank + 1)-\(suit)"))
                    pairs.append(("\(rank)-\(suit)", "\(rank)-\(suits[(s + 1) % 4])"))
                }
            }
            let backs = CardBack.allCases.map { "back-\($0.rawValue)" }
            let chips = ["white", "red", "blue", "green", "black", "violet", "gold"].map { "chip-\($0)" }
            let avatars = (0..<6).map { "avatar-person-\($0)" } + ["heuristic", "random", "calling-station", "medium", "hard", "bot"].map { "avatar-\($0)" }
            for group in [backs, chips, avatars] {
                for (i, name) in group.enumerated() { pairs.append((name, group[(i + 1) % group.count])) }
            }
            for (drawn, reference) in pairs {
                await Task.yield()
                let art = try #require(ArtLibrary.pieces[drawn])
                let spot = try #require(spots[reference])
                let theirs = Bitmap(sheet, crop: CGRect(x: spot.x * 2, y: spot.y * 2, width: spot.width * 2, height: spot.height * 2))
                let ours = try #require(render(ArtView(art), width: art.width, height: art.height, scale: 2))
                let difference = ours.difference(from: theirs)
                #expect(!Self.within(difference, art), "\(drawn) passes for \(reference): \(difference)")
            }
        }
    }
}
