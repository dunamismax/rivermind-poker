import XCTest

/// Cross-play (P5D.7): the app at a table with two people in Playwright's browsers, run by
/// `ios/crossplay.sh`, which seats them first and names the table. The app checks or calls
/// at each turn, records the result each hand ended with for the script to compare with
/// the browsers', and must see the people in the browsers act.
@MainActor
final class CrossPlayUITests: XCTestCase {
    func testPlaysWithPeopleInBrowsers() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["RIVERMIND_CROSSPLAY"] == "1", let id = environment["RIVERMIND_JOIN_TABLE"],
              let server = environment["RIVERMIND_SERVER"]
        else { throw XCTSkip("run by ios/crossplay.sh") }
        let names = (environment["RIVERMIND_CROSSPLAY_NAMES"] ?? "").split(separator: "|").map(String.init)
        let hands = Int(environment["RIVERMIND_CROSSPLAY_HANDS"] ?? "") ?? 3
        continueAfterFailure = false

        let app = XCUIApplication()
        app.launchEnvironment["RIVERMIND_SERVER"] = server
        app.launchEnvironment["RIVERMIND_JOIN_TABLE"] = id
        app.launch()
        let any = app.descendants(matching: .any)
        XCTAssertTrue(any["table.screen"].waitForExistence(timeout: 30))
        // The two people from the browsers are at the table.
        for name in names {
            let seat = any.matching(NSPredicate(format: "label CONTAINS %@", ": \(name),")).firstMatch
            XCTAssertTrue(seat.waitForExistence(timeout: 30), "\(name) is not at the table")
        }

        let call = app.buttons["table.call"]
        let hand = any["table.hand"]
        let result = any["table.result"]
        var results: [Int: String] = [:]
        var first: Int?
        let deadline = Date().addingTimeInterval(300)
        func handNumber() -> Int? {
            guard let match = hand.label.firstMatch(of: /Hand #(\d+)/) else { return nil }
            return Int(match.1)
        }
        while Date() < deadline {
            if let number = handNumber() {
                if first == nil { first = number }
                if !result.label.isEmpty { results[number] = result.label }
                if let first, number >= first + hands + 1 { break }
            }
            if call.exists && call.isEnabled && call.isHittable {
                call.tap()
                usleep(300_000)
            } else {
                usleep(150_000)
            }
        }
        XCTAssertGreaterThanOrEqual(results.count, hands, "the app saw \(results.count) hands end")
        let lines = results.keys.sorted().map { "{\"hand\":\($0),\"result\":\(Self.json(results[$0]!))}" }
        print("CROSSPLAY-RESULTS [" + lines.joined(separator: ",") + "]")

        // The app saw each person in a browser act.
        app.buttons["table.logButton"].tap()
        for name in names {
            let line = app.staticTexts.matching(
                NSPredicate(format: "label MATCHES %@", "^\(NSRegularExpression.escapedPattern(for: name)) (checks|calls|folds|bets|raises).*")
            ).firstMatch
            XCTAssertTrue(line.waitForExistence(timeout: 10), "no action by \(name) in the hand log")
        }
        app.buttons["Close"].firstMatch.tap()
        app.buttons["table.leave"].tap()
    }

    private static func json(_ text: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [text])
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }
}
