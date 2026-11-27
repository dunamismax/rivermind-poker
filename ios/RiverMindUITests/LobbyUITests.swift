import XCTest

/// The app in the Simulator against a real server. `ios/test.sh` starts the Node server
/// from `web/build` and passes its origin as `TEST_RUNNER_RIVERMIND_SERVER`, which
/// xcodebuild hands this runner as `RIVERMIND_SERVER`.
@MainActor
final class LobbyUITests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func server() throws -> String {
        guard let server = ProcessInfo.processInfo.environment["RIVERMIND_SERVER"], !server.isEmpty else {
            throw XCTSkip("RIVERMIND_SERVER names no server; run ios/test.sh")
        }
        return server
    }

    func testTheLobbyShowsWhatTheServerOffers() throws {
        let app = XCUIApplication()
        app.launchEnvironment["RIVERMIND_SERVER"] = try server()
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["lobby.ready"].waitForExistence(timeout: 20))
        // A row reads as its label and its value together.
        XCTAssertEqual(app.staticTexts["lobby.bot.heuristic"].label, "RiverMind Easy, 2 to 9 seats")
        XCTAssertEqual(app.staticTexts["lobby.bot.random"].label, "Random bot, 2 to 9 seats")
        XCTAssertEqual(app.staticTexts["lobby.seats"].label, "Seats, 2 to 9 seats")
        XCTAssertEqual(app.staticTexts["lobby.server"].label, "127.0.0.1")
    }

    /// The session is kept in the Keychain (P5D.2): the app is the same guest after a relaunch.
    func testTheGuestSurvivesARelaunch() throws {
        let app = XCUIApplication()
        app.launchEnvironment["RIVERMIND_SERVER"] = try server()
        app.launch()
        let guest = app.staticTexts["lobby.guest"]
        XCTAssertTrue(guest.waitForExistence(timeout: 20))
        let first = guest.label
        // The guest's handle and balance, such as "Keen Marten 47, 20,000 chips".
        XCTAssertTrue(first.hasSuffix(" chips") && first.count > ", 0 chips".count, first)

        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["lobby.guest"].waitForExistence(timeout: 20))
        XCTAssertEqual(app.staticTexts["lobby.guest"].label, first)
    }

    func testTheLobbySaysWhenNoServerAnswers() throws {
        _ = try server()
        let app = XCUIApplication()
        app.launchEnvironment["RIVERMIND_SERVER"] = "http://127.0.0.1:9"  // the discard port: nothing listens
        app.launch()

        XCTAssertTrue(app.staticTexts["No connection"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["Try again"].exists)
    }
}
