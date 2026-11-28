import XCTest

/// The kit's gallery (P5D.5), the debug build's `/style`: every component is on it, and a
/// screenshot of each screenful is kept with the test's results for review at each iPhone
/// size (`RIVERMIND_DEVICE_TYPE` in ios/test.sh picks the simulator).
@MainActor
final class GalleryUITests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testTheGalleryShowsEveryComponent() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-gallery"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["gallery"].waitForExistence(timeout: 20))

        var seen = Set<String>()
        var count: Int?
        let items = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'gallery.'"))
        for page in 0..<40 {
            for identifier in items.allElementsBoundByIndex.map(\.identifier) where identifier != "gallery.count" {
                seen.insert(identifier)
            }
            let total = app.staticTexts["gallery.count"]
            if total.exists, let n = Int(total.label.split(separator: " ").first ?? "") { count = n }
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = String(format: "gallery-%02d", page)
            shot.lifetime = .keepAlways
            add(shot)
            if count != nil && app.switches["Sounds"].exists { break }
            app.swipeUp()
        }
        let total = try XCTUnwrap(count, "the gallery's count never came into view")
        XCTAssertEqual(seen.count, total, "seen: \(seen.sorted())")
        XCTAssertTrue(seen.contains("gallery.cards-spades") && seen.contains("gallery.table"))
    }

    /// In a debug build the lobby's toolbar opens the gallery.
    func testTheLobbyOpensTheGallery() throws {
        guard let server = ProcessInfo.processInfo.environment["RIVERMIND_SERVER"], !server.isEmpty else {
            throw XCTSkip("RIVERMIND_SERVER names no server; run ios/test.sh")
        }
        let app = XCUIApplication()
        app.launchEnvironment["RIVERMIND_SERVER"] = server
        app.launch()
        // Open it once the lobby has loaded, as a person would (CI's iOS 26.5 dropped a
        // gallery opened while the lobby was still loading, before the app kept it).
        XCTAssertTrue(app.descendants(matching: .any)["lobby.ready"].waitForExistence(timeout: 20))
        let link = app.buttons["lobby.gallery"]
        XCTAssertTrue(link.waitForExistence(timeout: 20))
        link.tap()
        XCTAssertTrue(app.descendants(matching: .any)["gallery"].waitForExistence(timeout: 10))
    }
}
