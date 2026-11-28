import XCTest

/// The lobby's ways to a table (P5D.6), in the Simulator against the local server
/// `ios/test.sh` starts: one-click practice, a new table with bots, and the waitlist of a
/// full table.
@MainActor
final class LobbyPlayUITests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func server() throws -> String {
        guard let server = ProcessInfo.processInfo.environment["RIVERMIND_SERVER"], !server.isEmpty else {
            throw XCTSkip("RIVERMIND_SERVER names no server; run ios/test.sh")
        }
        return server
    }

    private func launch() throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["RIVERMIND_SERVER"] = try server()
        app.launch()
        // The app rejoins the table it followed when it last ran, as a page's reload does:
        // an earlier test may have left it at one.
        let lobby = element(app, "lobby.ready")
        let table = app.buttons["table.leave"]
        for _ in 0..<40 where !lobby.exists && !table.exists { usleep(500_000) }
        if table.exists { table.tap() }
        XCTAssertTrue(lobby.waitForExistence(timeout: 20))
        return app
    }

    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    /// Swipes the lobby up until `element` can be tapped.
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 12) {
        for _ in 0..<swipes where !(element.exists && element.isHittable) { app.swipeUp() }
        XCTAssertTrue(element.exists && element.isHittable, "\(element) is not on screen")
    }

    /// Waits for an element's label to satisfy `predicate`, written against `label`.
    private func expect(_ element: XCUIElement, _ format: String, _ value: String, timeout: TimeInterval = 20) {
        let found = XCTNSPredicateExpectation(predicate: NSPredicate(format: format, value), object: element)
        XCTAssertEqual(
            XCTWaiter().wait(for: [found], timeout: timeout), .completed,
            "\(element.exists ? element.label : "missing") is not \(format) \(value)")
    }

    private func leaveTheTable(_ app: XCUIApplication) {
        app.buttons["table.leave"].tap()
        XCTAssertTrue(element(app, "lobby.ready").waitForExistence(timeout: 20))
    }

    func testPracticeIsOneTapAway() throws {
        let app = try launch()
        let practice = app.buttons["lobby.practice"]
        XCTAssertTrue(practice.waitForExistence(timeout: 10))
        // The note says what practice is, with the server's practice stack.
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "10,000 practice chips")).firstMatch.exists)
        practice.tap()

        XCTAssertTrue(element(app, "table.screen").waitForExistence(timeout: 20))
        // The guest has a seat at the bottom of the table.
        let mine = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Your seat: "))
            .firstMatch
        XCTAssertTrue(mine.waitForExistence(timeout: 20))
        expect(element(app, "table.stakes"), "label ENDSWITH %@", "practice chips")
        // Heads-up against a labelled bot (D-7).
        let seats = [element(app, "table.seat.0"), element(app, "table.seat.1")]
        expect(seats[0], "label CONTAINS %@", ":")
        XCTAssertEqual(seats.filter { $0.label.contains("(bot)") }.count, 1, seats.map(\.label).description)
        XCTAssertTrue(seats.contains { $0.label.contains("RiverMind Easy") }, seats.map(\.label).description)
        leaveTheTable(app)
    }

    func testSitsAtANewTableWithBots() throws {
        let app = try launch()
        let start = app.buttons["lobby.newTable"]
        reveal(start, in: app)
        start.tap()

        app.buttons["newTable.seats.3"].tap()
        app.buttons["newTable.bot.random"].tap()
        XCTAssertTrue(app.buttons["newTable.bot.random"].isSelected)
        let sit = app.buttons["newTable.start"]
        reveal(sit, in: app)
        sit.tap()

        XCTAssertTrue(element(app, "table.screen").waitForExistence(timeout: 20))
        expect(element(app, "table.stakes"), "label ENDSWITH %@", "3 seats")
        let seats = (0..<3).map { element(app, "table.seat.\($0)") }
        expect(seats[2], "label CONTAINS %@", "(bot)")
        expect(seats[0], "label BEGINSWITH %@", "Your seat: ")
        for seat in seats.dropFirst() {
            XCTAssertTrue(seat.label.contains("Random") && seat.label.contains("(bot)"), seat.label)
        }
        leaveTheTable(app)
    }

    func testJoinsTheWaitlistOfAFullTable() async throws {
        let table = try await FullTable.make(server: try server())
        let app = try launch()

        let join = app.buttons["lobby.table.\(table).waitlist"]
        reveal(join, in: app, swipes: 20)
        XCTAssertEqual(element(app, "lobby.table.\(table).seats").label, "2 people")
        join.tap()
        let state = app.staticTexts["lobby.table.\(table).state"]
        expect(state, "label == %@", "Number 1 in line")

        app.buttons["lobby.table.\(table).leaveLine"].tap()
        XCTAssertTrue(app.buttons["lobby.table.\(table).waitlist"].waitForExistence(timeout: 20))
        XCTAssertFalse(state.exists)
    }
}

/// A full two-seat table with no bots: two guests of the test's own, made over HTTP.
enum FullTable {
    static func make(server: String) async throws -> String {
        let first = Guest(server: server)
        try await first.start()
        let made = try await first.send("POST", "/api/tables", ["seats": 2, "bots": NSNull(), "big_blind": 200])
        let id = try XCTUnwrap(made["table_id"] as? String)
        let second = Guest(server: server)
        try await second.start()
        let seat = try await second.send("POST", "/api/tables/\(id)/seat", [:])
        XCTAssertEqual(seat["seated"] as? Bool, true)
        return id
    }

    /// A guest of the test's own, which keeps its `rm_session` cookie itself, as the app's
    /// client does.
    final class Guest {
        let server: String
        private var cookie: String?

        init(server: String) { self.server = server }

        func start() async throws {
            _ = try await send("POST", "/api/session")
            XCTAssertNotNil(cookie)
        }

        func send(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
            var request = URLRequest(url: try XCTUnwrap(URL(string: server + path)))
            request.httpMethod = method
            request.httpShouldHandleCookies = false
            if let cookie { request.setValue("rm_session=\(cookie)", forHTTPHeaderField: "Cookie") }
            if let body {
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            let http = response as? HTTPURLResponse
            if let header = http?.value(forHTTPHeaderField: "Set-Cookie"),
               let range = header.range(of: "rm_session=")
            {
                cookie = String(header[range.upperBound...].prefix { $0 != ";" })
            }
            let status = http?.statusCode ?? 0
            XCTAssertTrue(
                (200..<300).contains(status), "\(method) \(path): \(status) \(String(decoding: data, as: UTF8.self))")
            return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        }
    }
}
