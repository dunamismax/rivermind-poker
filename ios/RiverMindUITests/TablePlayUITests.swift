import XCTest

/// The table (P5D.7), in the Simulator against the local servers `ios/test.sh` starts:
/// hands played to a showdown, a rebuy, sitting out and back, a reaction, a bust and a
/// fresh practice stack at the seeded site, and the seat menu's mute, unmute and report.
/// Every turn, Fold, Call and Raise must stand where they stood at the first, and no other
/// control may be where they come up.
@MainActor
final class TablePlayUITests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func environment(_ name: String) throws -> String {
        guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else {
            throw XCTSkip("\(name) names no server; run ios/test.sh")
        }
        return value
    }

    /// Launches the app at `server` with `extra` in its environment, from wherever the last
    /// test left it: a launch rejoins the table the app last followed.
    private func launch(server: String, _ extra: [String: String] = [:], arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["RIVERMIND_SERVER"] = server
        for (key, value) in extra { app.launchEnvironment[key] = value }
        app.launchArguments = arguments
        app.launch()
        return app
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func expect(_ element: XCUIElement, _ format: String, _ value: String, timeout: TimeInterval = 20) {
        let found = XCTNSPredicateExpectation(predicate: NSPredicate(format: format, value), object: element)
        XCTAssertEqual(
            XCTWaiter().wait(for: [found], timeout: timeout), .completed,
            "\(element.exists ? element.label : "missing") is not \(format) \(value)")
    }

    private func leave(_ app: XCUIApplication) {
        app.buttons["table.leave"].tap()
        XCTAssertTrue(element(app, "lobby.ready").waitForExistence(timeout: 20))
    }

    /// Where Fold, Call and Raise stood at the first turn, and the controls seen between turns.
    private struct Frames {
        var main: [String: CGRect] = [:]
        var turns = 0
        var others: [String: CGRect] = [:]
    }

    private static let main = ["table.fold", "table.call", "table.raise"]
    private static let tools = ["table.sitOut", "table.sitIn", "table.react", "table.rebuy", "table.opponent", "table.refill"]

    /// Checks or calls at each turn until `done`, keeping the main buttons' frames.
    private func play(
        _ app: XCUIApplication, frames: inout Frames, timeout: TimeInterval = 90, until done: (Frames) -> Bool
    ) {
        let deadline = Date().addingTimeInterval(timeout)
        let call = app.buttons["table.call"]
        while !done(frames) {
            XCTAssertLessThan(Date(), deadline, "the table did not get there in \(timeout) seconds")
            if call.exists && call.isEnabled && call.isHittable {
                for id in Self.main where app.buttons[id].exists {
                    let frame = app.buttons[id].frame
                    // The panel fades in; a frame read twice is the frame it stands at.
                    XCTAssertEqual(frame, app.buttons[id].frame, "\(id) is moving")
                    if let first = frames.main[id] {
                        XCTAssertEqual(frame, first, "\(id) moved between turns")
                    } else {
                        frames.main[id] = frame
                    }
                }
                frames.turns += 1
                call.tap()
                usleep(300_000)
            } else {
                if !element(app, "table.actions").exists {
                    for id in Self.tools where app.buttons[id].exists && app.buttons[id].isHittable {
                        frames.others[id] = app.buttons[id].frame
                    }
                }
                usleep(150_000)
            }
        }
    }

    /// No control that stands while it is not the guest's turn is where a main button comes up.
    private func checkNothingUnder(_ frames: Frames) {
        XCTAssertFalse(frames.main.isEmpty, "no turn came")
        for (id, frame) in frames.others {
            for (main, place) in frames.main {
                XCTAssertFalse(frame.intersects(place), "\(id) at \(frame) is under \(main) at \(place)")
            }
        }
    }

    /// Opens the hand log, waits for a line matching `format`, and closes it again.
    private func expectInLog(_ app: XCUIApplication, _ format: String, _ value: String) {
        app.buttons["table.logButton"].tap()
        let line = app.staticTexts.matching(NSPredicate(format: format, value)).firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 20), "no log line \(format) \(value)")
        app.buttons["Close"].firstMatch.tap()
    }

    /// Taps a seat tool between turns: the action panel covers the tools on the guest's
    /// turn, and its sizing presets are what stands there then, which set an amount and send
    /// nothing.
    private func tapTool(_ app: XCUIApplication, _ id: String) {
        let tool = app.buttons[id]
        XCTAssertTrue(tool.waitForExistence(timeout: 20), "\(id) is missing")
        for _ in 0..<200 {
            if !element(app, "table.actions").exists && tool.isHittable {
                tool.tap()
                return
            }
            if app.buttons["table.call"].isHittable { app.buttons["table.call"].tap() }
            usleep(150_000)
        }
        XCTFail("\(id) could not be tapped")
    }

    func testPlaysToAShowdownRebuysAndSitsOut() throws {
        let app = launch(
            server: try environment("RIVERMIND_SERVER"),
            ["RIVERMIND_TABLE_SEATS": "3", "RIVERMIND_TABLE_BOTS": "calling_station", "RIVERMIND_TABLE_BUY_IN": "40"])
        XCTAssertTrue(element(app, "table.screen").waitForExistence(timeout: 20))
        expect(element(app, "table.stakes"), "label ENDSWITH %@", "3 seats")
        expect(element(app, "table.seat.0"), "label BEGINSWITH %@", "Your seat: ")

        // Calling bots call everything, so checking and calling goes to a showdown.
        var frames = Frames()
        let shows = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", ", shows ")).firstMatch
        let result = element(app, "table.result")
        play(app, frames: &frames) { _ in
            shows.exists && (result.label.contains(" wins ") || result.label.contains(" split "))
        }
        XCTAssertGreaterThanOrEqual(frames.turns, 2)

        // A reaction shows beside the guest's seat.
        tapTool(app, "table.react")
        let nice = app.buttons["Nice hand"]
        XCTAssertTrue(nice.waitForExistence(timeout: 10))
        // Tapped while the menu is still opening, an item does nothing: wait for it to settle.
        usleep(600_000)
        nice.tap()
        XCTAssertTrue(
            app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Reaction: Nice hand")).firstMatch
                .waitForExistence(timeout: 10))

        // The rebuy: the buy-in was 40 big blinds, so there is room to add.
        tapTool(app, "table.rebuy")
        let confirm = app.buttons["rebuy.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        // During a hand the chips come after it, and the seat tools say so until then.
        if !app.staticTexts["table.pendingRebuy"].waitForExistence(timeout: 3) {
            expectInLog(app, "label CONTAINS %@", " adds ")
        }

        // Sitting out, and back.
        tapTool(app, "table.sitOut")
        XCTAssertTrue(app.buttons["table.sitIn"].waitForExistence(timeout: 20))
        play(app, frames: &frames, timeout: 60) { _ in element(app, "table.dock").label == "You are sitting out." }
        tapTool(app, "table.sitIn")
        XCTAssertTrue(app.buttons["table.sitOut"].waitForExistence(timeout: 20))
        // Another turn after coming back, to compare its frames too.
        let turns = frames.turns
        play(app, frames: &frames) { $0.turns > turns }
        checkNothingUnder(frames)
        leave(app)
    }

    func testBustsAndPlaysAgainAtPractice() throws {
        let app = launch(server: try environment("RIVERMIND_SEEDED_SERVER"), arguments: ["-practice"])
        // A launch that rejoined a table the seeded site no longer has (it starts afresh with
        // each run of ios/test.sh) lands in the lobby once the table is gone: practise from there.
        let lobby = element(app, "lobby.ready")
        for _ in 0..<40 where !element(app, "table.seat.0").exists && !lobby.exists { usleep(500_000) }
        if lobby.exists && !element(app, "table.screen").exists {
            let practice = app.buttons["lobby.practice"]
            XCTAssertTrue(practice.waitForExistence(timeout: 10))
            practice.tap()
        }
        XCTAssertTrue(element(app, "table.screen").waitForExistence(timeout: 20))
        expect(element(app, "table.stakes"), "label ENDSWITH %@", "practice chips")

        // The seeded deck: checking or calling at every turn, the guest is out of chips in
        // the fourth hand.
        var frames = Frames()
        let out = element(app, "table.outOfChips")
        play(app, frames: &frames, timeout: 120) { _ in out.exists }
        let refill = app.buttons["table.refill"]
        XCTAssertEqual(refill.label, "Play again with 300 chips")
        refill.tap()
        expectInLog(app, "label CONTAINS %@", " adds 300")
        XCTAssertFalse(out.exists)
        let turns = frames.turns
        play(app, frames: &frames) { $0.turns > turns }
        checkNothingUnder(frames)
        leave(app)
    }

    func testTheSeatMenuMutesAndReports() async throws {
        let server = try environment("RIVERMIND_SERVER")
        let other = FullTable.Guest(server: server)
        try await other.start()
        let made = try await other.send("POST", "/api/tables", ["seats": 2, "bots": NSNull(), "big_blind": 50])
        let id = try XCTUnwrap(made["table_id"] as? String)

        let app = launch(server: server, ["RIVERMIND_JOIN_TABLE": id])
        XCTAssertTrue(element(app, "table.screen").waitForExistence(timeout: 20))
        let person = element(app, "table.seat.0")
        expect(person, "label BEGINSWITH %@", "Seat 1: ")
        XCTAssertFalse(person.label.contains("(bot)"))
        person.tap()

        let mute = app.buttons["seatMenu.mute"]
        XCTAssertTrue(mute.waitForExistence(timeout: 10))
        mute.tap()
        expect(element(app, "seatMenu.relation"), "label == %@", "Muted")
        expect(app.buttons["seatMenu.mute"], "label == %@", "Unmute")
        app.buttons["seatMenu.mute"].tap()
        expect(app.buttons["seatMenu.mute"], "label == %@", "Mute")
        XCTAssertFalse(element(app, "seatMenu.relation").exists)

        app.buttons["seatMenu.report"].tap()
        expect(element(app, "seatMenu.reported"), "label == %@", "Thanks: the report was sent for review.")
        app.buttons["seatMenu.report"].tap()
        expect(element(app, "seatMenu.reported"), "label == %@", "You already reported this today; it counts once.")
        app.buttons["seatMenu.close"].tap()
        XCTAssertTrue(element(app, "table.seat.0").waitForExistence(timeout: 10))
        leave(app)
    }
}
