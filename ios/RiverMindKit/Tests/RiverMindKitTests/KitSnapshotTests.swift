import Foundation
import SwiftUI
import Testing
@testable import RiverMindKit

extension LookRendering {
    /// Every item of the kit's gallery (P5D.5), drawn at 2 pixels a point and compared with
    /// its recorded snapshot in `Fixtures/snapshots/`. `RIVERMIND_RECORD_SNAPSHOTS=1 swift test` records
    /// them again after a deliberate change; review the new images before committing them.
    ///
    /// SwiftUI draws text and shadows a little differently from one macOS release to the next,
    /// so the snapshots are compared on the macOS they were recorded on (`recorded-on.txt`).
    /// Elsewhere, as in CI on an older Xcode's runner, each item is still drawn and must be
    /// its size and not blank.
    @MainActor
    struct KitSnapshotTests {
        static let directory = repository.appending(path: "ios/RiverMindKit/Fixtures/snapshots")
        static let recording = ProcessInfo.processInfo.environment["RIVERMIND_RECORD_SNAPSHOTS"] == "1"
        static let system = "macOS \(ProcessInfo.processInfo.operatingSystemVersion.majorVersion)"

        static var recordedOn: String? {
            try? String(contentsOf: directory.appending(path: "recorded-on.txt"), encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }

        @Test("the gallery names each item once, in a section it lists")
        func itemsAreNamed() {
            let items = KitGallery.items
            #expect(Set(items.map(\.id)).count == items.count)
            for item in items { #expect(KitGallery.sections.contains(item.section), "\(item.id)") }
            for section in KitGallery.sections { #expect(items.contains { $0.section == section }, "\(section)") }
        }

        @Test("every snapshot has its item, and every item its snapshot")
        func snapshotsMatchItems() throws {
            guard !Self.recording else { return }
            let files = try FileManager.default.contentsOfDirectory(atPath: Self.directory.path())
                .filter { $0.hasSuffix(".png") }
            #expect(Set(files) == Set(KitGallery.items.map { "\($0.id).png" }))
        }

        @Test("each item looks as it was recorded", arguments: KitGallery.items.map(\.id))
        func snapshot(_ id: String) async throws {
            await Task.yield()
            let item = try #require(KitGallery.items.first { $0.id == id })
            let drawn = try #require(render(item.view, width: item.width, height: item.height, scale: 2))
            #expect(drawn.width == Int(item.width * 2) && drawn.height == Int(item.height * 2))
            #expect(!drawn.isBlank)
            let file = Self.directory.appending(path: "\(id).png")
            if Self.recording {
                try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
                try drawn.write(file)
                try (Self.system + "\n").write(
                    to: Self.directory.appending(path: "recorded-on.txt"), atomically: true, encoding: .utf8)
                return
            }
            guard Self.recordedOn == Self.system else { return }
            let recorded = try #require(Bitmap.read(file).map { Bitmap($0) }, "no snapshot \(id).png: record it")
            try #require(recorded.width == drawn.width && recorded.height == drawn.height, "\(id) changed size")
            let difference = drawn.difference(from: recorded)
            #expect(difference.mean <= 0.5 && difference.farShare <= 0.002, "\(id): \(difference)")
            if difference.mean > 0.5 || difference.farShare > 0.002 {
                let out = URL(filePath: NSTemporaryDirectory()).appending(path: "rivermind-snapshots")
                try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                try drawn.write(out.appending(path: "\(id).png"))
                print("\(id) as drawn now: \(out.appending(path: "\(id).png").path())")
            }
        }
    }
}
