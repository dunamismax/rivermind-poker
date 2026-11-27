import Foundation
import Testing
@testable import RiverMindKit

/// Every socket message and HTTP body of the two recorded sessions, written by
/// `pnpm ios:fixtures` (web/src/lib/server/api/ios-fixtures.spec.ts).
struct ProtocolFixture {
    struct Body {
        let type: String
        let route: String
        let data: Data
    }

    let server: [Data]
    let client: [Data]
    let http: [Body]
    let requests: [Body]

    static let shared: ProtocolFixture = {
        let url = repository.appending(path: "ios/RiverMindKit/Fixtures/protocol.json")
        // swiftlint:disable:next force_try
        let document = try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        func items(_ key: String) -> [Any] { document[key] as! [Any] }
        func data(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }
        func bodies(_ key: String) -> [Body] {
            items(key).map { item in
                let entry = item as! [String: Any]
                return Body(
                    type: entry["type"] as! String, route: entry["route"] as! String,
                    data: data(entry["body"]!))
            }
        }
        return ProtocolFixture(
            server: items("server").map(data), client: items("client").map(data),
            http: bodies("http"), requests: bodies("requests"))
    }()
}

/// Decodes as `T`, encodes back, and expects the same JSON, compared parsed and never as
/// text: JavaScript writes `20` where Python wrote `20.0`.
@discardableResult
func roundTrip<T: Codable>(_ type: T.Type, _ data: Data, _ comment: String = "") throws -> T {
    let value = try JSONDecoder().decode(T.self, from: data)
    let again = try JSONEncoder().encode(value)
    let same = try parsed(again) == parsed(data)
    #expect(same, "\(T.self) \(comment) came back as \(String(decoding: again, as: UTF8.self))")
    return value
}

/// The generated type a fixture names, by its TypeScript name.
func roundTrip(named type: String, _ data: Data, _ comment: String) throws {
    switch type {
    case "ConfigResponse": try roundTrip(ConfigResponse.self, data, comment)
    case "SessionResponse": try roundTrip(SessionResponse.self, data, comment)
    case "WalletResponse": try roundTrip(WalletResponse.self, data, comment)
    case "HandListResponse": try roundTrip(HandListResponse.self, data, comment)
    case "HandDetail": try roundTrip(HandDetail.self, data, comment)
    case "RelationsResponse": try roundTrip(RelationsResponse.self, data, comment)
    case "TableListResponse": try roundTrip(TableListResponse.self, data, comment)
    case "NewTableResponse": try roundTrip(NewTableResponse.self, data, comment)
    case "TableSummary": try roundTrip(TableSummary.self, data, comment)
    case "SeatResponse": try roundTrip(SeatResponse.self, data, comment)
    case "WaitlistResponse": try roundTrip(WaitlistResponse.self, data, comment)
    case "PracticeResponse": try roundTrip(PracticeResponse.self, data, comment)
    case "ReportResponse": try roundTrip(ReportResponse.self, data, comment)
    case "HttpError": try roundTrip(HttpError.self, data, comment)
    case "SessionRequest": try roundTrip(SessionRequest.self, data, comment)
    case "NewTableRequest": try roundTrip(NewTableRequest.self, data, comment)
    case "SeatRequest": try roundTrip(SeatRequest.self, data, comment)
    case "WaitlistRequest": try roundTrip(WaitlistRequest.self, data, comment)
    case "QuickSeatRequest": try roundTrip(QuickSeatRequest.self, data, comment)
    case "PracticeRequest": try roundTrip(PracticeRequest.self, data, comment)
    case "ReportRequest": try roundTrip(ReportRequest.self, data, comment)
    case "RelationRequest": try roundTrip(RelationRequest.self, data, comment)
    default: Issue.record("no Swift type for \(type)")
    }
}

@Suite struct ProtocolFixtureTests {
    let fixture = ProtocolFixture.shared

    @Test func everyServerMessageOfTheSessionReadsAndWritesBack() throws {
        #expect(fixture.server.count > 500)
        var kinds = Set<String>()
        for (index, data) in fixture.server.enumerated() {
            let message = try roundTrip(ServerMessage.self, data, "message \(index)")
            if case .unknown = message { Issue.record("message \(index) read as unknown") }
            kinds.insert(message.type)
            if case let .table(table) = message {
                // Every event kind the session sent is one this build knows.
                for event in table.events { #expect(event.kind.isKnown, "\(event.kind)") }
            }
        }
        #expect(kinds == ["welcome", "table", "left_table", "reaction", "error"])
    }

    @Test func everyClientMessageOfTheSessionReadsAndWritesBack() throws {
        var kinds = Set<String>()
        for (index, data) in fixture.client.enumerated() {
            kinds.insert(try roundTrip(ClientMessage.self, data, "message \(index)").type)
        }
        #expect(kinds == [
            "join_table", "leave_table", "sit", "sit_out", "sit_in", "rebuy", "act", "refresh", "react",
        ])
    }

    @Test func everyHTTPBodyOfBothSessionsReadsAndWritesBack() throws {
        #expect(fixture.http.count > 50)
        for body in fixture.http { try roundTrip(named: body.type, body.data, body.route) }
        for body in fixture.requests { try roundTrip(named: body.type, body.data, body.route) }
    }

    @Test func helloIsWhatThePageSends() throws {
        let data = try JSONEncoder().encode(HelloMessage.first)
        #expect(try parsed(data) == parsed(Data(#"{"type":"hello","protocol":2}"#.utf8)))
    }

    @Test func aClosedTableReadsAsTheServerSendsIt() throws {
        // `Tables` sends this when a table closes under a socket (tables.ts); the
        // recorded session has none.
        let data = Data(#"{"type":"table_closed","table_id":"t1","message":"The table has closed."}"#.utf8)
        guard case let .tableClosed(closed) = try roundTrip(ServerMessage.self, data) else {
            Issue.record("not a closed table")
            return
        }
        #expect(closed.tableID == "t1")
    }

    @Test func anActionIsWrittenAsThePageWritesIt() throws {
        let act = ClientMessage.act(ActMessage(tableID: "t1", seq: 12, action: .raise, amount: 400))
        #expect(try parsed(JSONEncoder().encode(act)) == parsed(Data(
            #"{"type":"act","table_id":"t1","seq":12,"action":"raise","amount":400}"#.utf8)))
        // A fold carries no amount, and leaves the field out.
        let fold = ClientMessage.act(ActMessage(tableID: "t1", seq: 12, action: .fold))
        #expect(try parsed(JSONEncoder().encode(fold)) == parsed(Data(
            #"{"type":"act","table_id":"t1","seq":12,"action":"fold"}"#.utf8)))
    }

    @Test func aRequiredNullIsWrittenAsNull() throws {
        let error = ErrorMessage(code: .stale, message: "Old view", tableID: nil)
        let text = String(decoding: try JSONEncoder().encode(error), as: UTF8.self)
        #expect(text.contains(#""table_id":null"#))
    }
}

/// A newer server must never break an older build (docs/ios.md): what this build does not
/// know is ignored, or kept and shown generically.
@Suite struct NewerServerTests {
    @Test func aTableMessageWithNewFieldsAndKindsStillReads() throws {
        let first = try #require(ProtocolFixture.shared.server.first { data in
            (try? JSONDecoder().decode(ServerMessage.self, from: data)).map {
                if case let .table(message) = $0 { !message.events.isEmpty } else { false }
            } ?? false
        })
        var message = try #require(JSONSerialization.jsonObject(with: first) as? [String: Any])
        message["future"] = ["anything": [1, 2, 3]]
        var view = try #require(message["view"] as? [String: Any])
        view["tournament"] = ["level": 3]
        var you = try #require(view["you"] as? [String: Any])
        you["coach"] = true
        view["you"] = you
        message["view"] = view
        var events = try #require(message["events"] as? [[String: Any]])
        events.append(["seq": 999, "kind": "level_up", "level": 4])
        message["events"] = events
        let data = try JSONSerialization.data(withJSONObject: message)

        guard case let .table(table) = try JSONDecoder().decode(ServerMessage.self, from: data) else {
            Issue.record("not a table message")
            return
        }
        let event = try #require(table.events.last)
        #expect(event.kind == EventKind(rawValue: "level_up"))
        #expect(!event.kind.isKnown)
        #expect(event.seq == 999)
    }

    @Test func anUnknownMessageIsKeptWhole() throws {
        let data = Data(#"{"type":"tournament_started","table_id":"t1","level":1}"#.utf8)
        let message = try roundTrip(ServerMessage.self, data)
        guard case let .unknown(type, body) = message else {
            Issue.record("expected unknown, got \(message)")
            return
        }
        #expect(type == "tournament_started")
        #expect(body["table_id"]?.string == "t1")
    }

    @Test func anUnknownErrorCodeReactionAndBotKeepTheirNames() throws {
        let error = try roundTrip(ServerMessage.self, Data(
            #"{"type":"error","code":"table_paused","message":"Paused","table_id":null}"#.utf8))
        guard case let .error(refused) = error else {
            Issue.record("not an error")
            return
        }
        #expect(refused.code == ErrorCode(rawValue: "table_paused"))
        #expect(!refused.code.isKnown && ErrorCode.stale.isKnown)

        let reaction = try roundTrip(ServerMessage.self, Data(
            #"{"type":"reaction","table_id":"t1","seat":2,"name":"Guest 1","ref":"abc","reaction":"clap","text":"👏"}"#
                .utf8))
        guard case let .reaction(said) = reaction else {
            Issue.record("not a reaction")
            return
        }
        #expect(said.reaction.rawValue == "clap" && !said.reaction.isKnown)

        let seat = try roundTrip(SeatInfo.self, Data(
            #"{"seat":1,"name":"RiverMind Expert","kind":"bot","ref":null,"bot":"expert","stack":100,"bet":0,"in_hand":true,"folded":false,"all_in":false,"sitting_out":false,"leaving":false,"connected":true,"has_cards":true,"cards":null}"#
                .utf8))
        #expect(seat.bot == "expert" && seat.kind == .bot)
    }

    @Test func anUnknownStreetSuitOrSeatKindStillReads() throws {
        let card = try roundTrip(Card.self, Data(#"{"rank":14,"suit":"stars"}"#.utf8))
        #expect(card.suit.rawValue == "stars" && !card.suit.isKnown)
        #expect(Suit.known == [.spades, .hearts, .diamonds, .clubs])
        #expect(Street.known.map(\.rawValue) == ["pre-flop", "flop", "turn", "river"])
    }
}

@Suite struct VoiceSignallingTests {
    @Test func aRequestCarriesItsIDAndType() throws {
        let hello = VoiceEnvelope(id: 1, request: VoiceHelloRequest(v: 1, table: "t1", token: "tok"))
        #expect(try parsed(JSONEncoder().encode(hello)) == parsed(Data(
            #"{"id":1,"type":"hello","v":1,"table":"t1","token":"tok"}"#.utf8)))
        let pause = VoiceEnvelope(id: 7, request: VoiceProducerPauseRequest())
        #expect(try parsed(JSONEncoder().encode(pause)) == parsed(Data(#"{"id":7,"type":"producer.pause"}"#.utf8)))
        let status = VoiceEnvelope(id: 8, request: VoicePeerStatus(muted: true, deafened: false))
        #expect(try parsed(JSONEncoder().encode(status)) == parsed(Data(
            #"{"id":8,"type":"status","muted":true,"deafened":false}"#.utf8)))
        #expect(VoiceSignalling.requestTypes.count == 13)
        #expect(VoiceSignalling.Close.full == 4503 && VoiceSignalling.maxMessageBytes == 32 * 1024)
    }

    @Test func anAnswerGivesTheResponseOfItsRequest() throws {
        let data = Data(
            #"{"v":1,"peer":"p2","seat":3,"player":"ref","service":"AA==","group":"AQ==","groupInfo":null,"routerRtpCapabilities":{"codecs":[{"kind":"audio","mimeType":"audio/opus","clockRate":48000,"channels":2}]},"peers":[{"peer":"p1","leaf":0,"producer":"x","muted":true}],"statuses":true,"silenced":null,"restarts":true,"id":1,"ok":true}"#
                .utf8)
        guard case let .answer(answer) = try JSONDecoder().decode(VoiceServerMessage.self, from: data) else {
            Issue.record("not an answer")
            return
        }
        #expect(answer.id == 1 && answer.ok)
        let hello = try answer.response(to: VoiceHelloRequest.self)
        #expect(hello.seat == 3 && hello.groupInfo == nil && hello.statuses == true)
        #expect(hello.peers.first?.muted == true && hello.peers.first?.deafened == nil)
        #expect(hello.routerRtpCapabilities["codecs"] != nil)
        try roundTrip(VoiceHelloResponse.self, data.withoutEnvelope())
    }

    @Test func aRefusalSaysWhyAndWhereToStartAgain() throws {
        let data = Data(#"{"id":4,"ok":false,"error":"epoch-taken","groupInfo":"AQ=="}"#.utf8)
        guard case let .answer(answer) = try JSONDecoder().decode(VoiceServerMessage.self, from: data) else {
            Issue.record("not an answer")
            return
        }
        #expect(throws: VoiceRefusal(error: .epochTaken, groupInfo: .some("AQ=="))) {
            try answer.response(to: VoiceGroupCommitRequest.self)
        }
        let full = try JSONDecoder().decode(VoiceAnswer.self, from: Data(#"{"id":1,"ok":false,"error":"full"}"#.utf8))
        #expect(full.error == .full && full.groupInfo == .none)
    }

    @Test func noticesReadAndAnUnknownOneIsKept() throws {
        let notices = [
            #"{"notice":"mls","message":"AAEC"}"#,
            #"{"notice":"producer","peer":{"peer":"p1","leaf":2,"producer":"x"}}"#,
            #"{"notice":"consumer.closed","consumer":"c1"}"#,
            #"{"notice":"left","peer":"p1"}"#,
            #"{"notice":"peer","peer":{"peer":"p1","leaf":2,"producer":null,"muted":false,"deafened":true}}"#,
            #"{"notice":"media.reset"}"#,
            #"{"notice":"silenced","until":1795000000000}"#,
            #"{"notice":"silenced","until":null}"#,
        ]
        for text in notices {
            let notice = try roundTrip(VoiceNotice.self, Data(text.utf8), text)
            if case .unknown = notice { Issue.record("\(text) read as unknown") }
        }
        let later = try roundTrip(VoiceNotice.self, Data(#"{"notice":"video","peer":"p1"}"#.utf8))
        #expect(later.notice == "video")
        guard case .unknown = later else {
            Issue.record("expected unknown")
            return
        }
        let error = try JSONDecoder().decode(VoiceError.self, from: Data(#""too-loud""#.utf8))
        #expect(!error.isKnown && VoiceError.badToken.isKnown)
    }
}

extension Data {
    /// A voice answer without its `id` and `ok`, as the response alone.
    func withoutEnvelope() throws -> Data {
        var object = try JSONSerialization.jsonObject(with: self) as! [String: Any]
        object["id"] = nil
        object["ok"] = nil
        return try JSONSerialization.data(withJSONObject: object)
    }
}
