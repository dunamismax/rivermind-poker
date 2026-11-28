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
        let host = app.staticTexts["lobby.server"]
        for _ in 0..<5 where !host.exists { app.swipeUp() }
        XCTAssertEqual(host.label, "127.0.0.1")
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

    /// P5D.11: the guest deletes themself after saying so twice, and the app starts again
    /// as a new guest.
    func testAGuestDeletesThemselfAndStartsAgain() throws {
        let app = XCUIApplication()
        app.launchEnvironment["RIVERMIND_SERVER"] = try server()
        app.launch()
        let guest = app.staticTexts["lobby.guest"]
        XCTAssertTrue(guest.waitForExistence(timeout: 20))
        let first = guest.label

        // The button is at the end of the lobby, and asks again before it deletes.
        let delete = app.buttons["lobby.delete"]
        for _ in 0..<5 where !delete.isHittable { app.swipeUp() }
        delete.tap()
        // The sheet's button appears twice in its accessibility tree.
        let confirm = app.buttons.matching(identifier: "Delete for good").firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        XCTAssertTrue(app.descendants(matching: .any)["lobby.deleted"].waitForExistence(timeout: 20))
        app.buttons["Play as a new guest"].tap()
        XCTAssertTrue(app.staticTexts["lobby.guest"].waitForExistence(timeout: 20))
        XCTAssertNotEqual(app.staticTexts["lobby.guest"].label, first)
    }

    /// P5D.11: a build older than the server's oldest asks to be updated instead of failing.
    func testAnOldBuildAsksToBeUpdated() throws {
        let app = XCUIApplication()
        app.launchEnvironment["RIVERMIND_SERVER"] = try server()
        app.launchEnvironment["RIVERMIND_PRETEND_BUILD"] = "0"
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["lobby.update"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Update RiverMind Poker"].exists)
    }

    /// P5D.3, Q-16: out of voice, the app lets go of its table socket in the background
    /// and rejoins by itself when it comes back.
    func testTheTableRejoinsWhenTheAppComesBack() throws {
        let app = XCUIApplication()
        app.launchEnvironment["RIVERMIND_SERVER"] = try server()
        app.launchArguments = ["-practice"]
        app.launch()

        let status = app.staticTexts["probe.status"]
        let joins = app.staticTexts["probe.joins"]
        XCTAssertTrue(status.waitForExistence(timeout: 20))
        expect(status, "Connection, open")
        XCTAssertEqual(joins.label, "Joins, 1")
        let hand = app.staticTexts["probe.hand"]
        XCTAssertNotEqual(hand.label, "Hand, none")

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackgroundSuspended, timeout: 10) || app.state == .runningBackground)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        expect(joins, "Joins, 2")
        expect(status, "Connection, open")
    }

    /// Waits for an element's label to read `label`.
    private func expect(_ element: XCUIElement, _ label: String, timeout: TimeInterval = 20) {
        let matches = NSPredicate(format: "label == %@", label)
        let found = XCTNSPredicateExpectation(predicate: matches, object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [found], timeout: timeout), .completed, "\(element.label) is not \(label)")
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
