import Foundation
import Testing
@testable import RiverMindKit

/// The seeded site `ios/test.sh` starts (web/e2e/seeded-server.ts, seed 10), when it does.
let seededServer: Server? = ProcessInfo.processInfo.environment["RIVERMIND_SEEDED_SERVER"].flatMap(Server.init(origin:))

/// The app's table connection plays the session fixture's script on the seeded site, over
/// a real `URLSession` socket, and must see what the TypeScript client saw there
/// (web/src/lib/server/api/ios-session.spec.ts): check or call at every turn, refill once
/// out of chips, play two more hands. The site must be fresh, since each table it opens
/// deals from the next seed.
@MainActor
@Suite(.enabled(if: seededServer != nil, "needs RIVERMIND_SEEDED_SERVER, as ios/test.sh sets it"))
struct TableConnectionSessionTests {
    struct Expected {
        let connectedInFirstView: Bool
        let refillHand: Int
        let events: [NSDictionary]
        let turns: [NSDictionary]

        static func load() throws -> Expected {
            let url = repository.appending(path: "ios/RiverMindKit/Fixtures/session.json")
            let document = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
            return Expected(
                connectedInFirstView: document["connected_in_first_view"] as! Bool,
                refillHand: document["refill_hand"] as! Int,
                events: (document["events"] as! [[String: Any]]).map { $0 as NSDictionary },
                turns: (document["turns"] as! [[String: Any]]).map { $0 as NSDictionary })
        }
    }

    /// A value as the fixture holds it: its JSON, parsed.
    func json<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: .fragmentsAllowed)
    }

    @Test func playsTheRecordedSessionThroughTheAppsConnection() async throws {
        let expected = try Expected.load()
        let client = APIClient(server: seededServer!)
        let guest = try await client.startSession()
        let practice = try await client.practice()
        let connection = TableConnection(client: client)

        var events: [NSDictionary] = []
        var turns: [NSDictionary] = []
        var first: Bool?
        var recording = false
        var hand = 0
        var refill: Int?
        var acted = -1
        var done = false
        var failure: String?

        connection.onTable = { message in
            guard !done else { return }
            do {
                let view = message.view
                let seat = view.you.seat
                if first == nil { first = seat.flatMap { view.seats[$0]?.connected } ?? false }
                for event in message.events {
                    if event.kind == .handStarted { hand = event.handNo ?? hand }
                    if !recording && event.kind == .handStarted && hand >= 2 { recording = true }
                    if recording {
                        var record = event
                        if record.name == guest.name { record.name = "<guest>" }
                        events.append(try json(record) as! NSDictionary)
                    }
                    if event.kind == .handEnded, let refill, hand > refill + 1 {
                        done = true
                        connection.leave()
                        return
                    }
                }
                guard let seat else { return }
                let over = view.hand == nil || view.hand?.result != nil
                if refill == nil, over, view.seats[seat]?.stack == 0 {
                    refill = view.hand?.handNo ?? hand
                    if !connection.rebuy(view.settings.maxBuyIn) { failure = "the refill was not sent" }
                    return
                }
                guard let legal = view.you.legal, let current = view.hand, view.seq != acted else { return }
                acted = view.seq
                let action: ActionKind = legal.canCheck ? .check : .call
                if recording {
                    let turn: [String: Any] = [
                        "hand_no": current.handNo,
                        "street": current.street.rawValue,
                        "board": try json(current.board),
                        "pot": current.pot,
                        "current_bet": current.currentBet,
                        "legal": try json(legal),
                        "cards": try view.seats[seat]?.cards.map { try json($0) } ?? NSNull(),
                        "stacks": view.seats.map { $0.map { $0.stack as Any } ?? NSNull() },
                        "action": action.rawValue,
                    ]
                    turns.append(turn as NSDictionary)
                }
                if !connection.act(action) { failure = "the action at seq \(view.seq) was not sent" }
            } catch {
                failure = "\(error)"
            }
        }
        connection.follow(practice.tableID)
        await eventually(60) { done || failure != nil }

        #expect(failure == nil, "\(failure ?? "")")
        #expect(first == expected.connectedInFirstView)
        #expect(first == true, "the guest's own seat is connected in the first view (Tables.join)")
        #expect(refill == expected.refillHand)
        #expect(events.count == expected.events.count)
        for (index, (mine, theirs)) in zip(events, expected.events).enumerated() {
            #expect(mine == theirs, "event \(index)")
        }
        #expect(turns.count == expected.turns.count)
        for (index, (mine, theirs)) in zip(turns, expected.turns).enumerated() {
            #expect(mine == theirs, "turn \(index)")
        }
        #expect(connection.tableID == nil)
    }
}
