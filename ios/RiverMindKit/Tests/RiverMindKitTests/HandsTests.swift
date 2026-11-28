import Foundation
import Testing

@testable import RiverMindKit

private func summary(_ id: String, table: String, handNo: Int, net: Int = 0, practice: Bool? = nil) -> HandSummary {
    HandSummary(
        handID: id, tableID: table, tableName: "Room", handNo: handNo, at: 1_795_877_100, seat: 0, seatCount: 2,
        smallBlind: 50, bigBlind: 100, cards: [], board: [], pot: 1_200, net: net, showdown: false,
        practice: practice)
}

@Suite struct HandWordsTests {
    @Test func signsAndTonesAResult() {
        #expect(HandWords.signed(1_200) == "+1,200")
        #expect(HandWords.signed(-300) == "-300")
        #expect(HandWords.signed(0) == "0")
        #expect(HandWords.tone(5) == .won && HandWords.tone(-5) == .lost && HandWords.tone(0) == .even)
    }

    @Test func writesWhenAsThePageDoes() throws {
        let utc = try #require(TimeZone(identifier: "UTC"))
        // 2026-11-28 14:45 UTC
        #expect(HandWords.when(1_795_877_100, timeZone: utc) == "Nov 28, 2:45 PM")
        let hand = summary("h", table: "t", handNo: 3, practice: true)
        #expect(HandWords.title(hand) == "Room · hand #3")
        #expect(
            HandWords.meta(hand, timeZone: utc) == "Practice chips · Nov 28, 2:45 PM · Blinds 50/100 · Pot 1,200")
    }

    /// `findHand` on the page: newest first, a hand past the one asked for ends the search.
    @Test func findsATablesHandAsThePageDoes() {
        let page = [
            summary("a9", table: "a", handNo: 9), summary("b4", table: "b", handNo: 4),
            summary("a7", table: "a", handNo: 7), summary("a6", table: "a", handNo: 6),
        ]
        #expect(HandFinder.search(page, table: "a", handNo: nil) == .found("a9"))
        #expect(HandFinder.search(page, table: "a", handNo: 7) == .found("a7"))
        #expect(HandFinder.search(page, table: "a", handNo: 8) == .absent)
        #expect(HandFinder.search(page, table: "a", handNo: 2) == .further)
        #expect(HandFinder.search(page, table: "c", handNo: nil) == .further)
    }
}

/// “Your hands” and the review at the table, against the local server `ios/test.sh` starts.
@Suite(.enabled(if: Server.from(environment: ProcessInfo.processInfo.environment) != nil))
@MainActor
struct HandsLocalServerTests {
    let server = Server.from(environment: ProcessInfo.processInfo.environment)!

    @Test func listsReplaysAndReviewsAHandThatWasPlayed() async throws {
        let client = APIClient(server: server)
        _ = try await client.startSession()
        let hands = HandsModel(client: client)
        await hands.load()
        #expect(hands.loaded && hands.hands.isEmpty && hands.error == nil)

        // A practice hand, checked or called through to its end.
        let started = try await client.practice()
        let connection = TableConnection(client: client)
        connection.follow(started.tableID)
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            if let view = connection.view, let hand = view.hand, hand.result != nil || hand.handNo > 1,
               TableWords.dealtIn(view) || hand.handNo > 1
            {
                break
            }
            if let legal = connection.view?.you.legal, !connection.pending {
                _ = connection.act(legal.canCheck ? .check : .call)
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        let view = try #require(connection.view)
        #expect(TableWords.reviewable(view))

        // The review at the table finds the guest's newest hand there.
        let review = HandReview(client: client)
        await review.open(table: started.tableID, handNo: nil, on: connection)
        let reviewed = try #require(review.detail)
        #expect(reviewed.hand.tableID == started.tableID)
        #expect(reviewed.hand.practice == true)
        let steps = Replay.steps(reviewed)
        #expect(steps.first?.kind == .posts)
        #expect(steps.last?.kind == .result)
        // A hand the guest was not dealt into is said so, at the table.
        await review.open(table: "no-such-table", handNo: 1, on: connection)
        #expect(connection.notice?.text == TableWords.noHandText(1))
        review.close()
        #expect(review.detail == nil)

        // “Your hands” lists it, and opens it.
        await hands.load()
        let listed = try #require(hands.hands.first { $0.handID == reviewed.hand.handID })
        #expect(listed.practice == true)
        await hands.show(listed.handID)
        #expect(hands.open == reviewed)
        hands.close()
        #expect(hands.open == nil)
        connection.leave()
    }
}
