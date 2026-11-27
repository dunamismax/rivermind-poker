import Foundation
import Testing
@testable import RiverMindKit

/// The repository's root, from this file's place in it.
let repository = URL(filePath: #filePath)
    .deletingLastPathComponent()  // RiverMindKitTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // RiverMindKit
    .deletingLastPathComponent()  // ios
    .deletingLastPathComponent()

/// The answers the retired `serve-nl` gave to a fixed script, which the TypeScript API
/// must still give byte for byte (AGENTS.md).
struct Contract: Decodable {
    struct Exchange: Decodable {
        struct Response: Decodable {
            let status: Int
            let body: String
        }
        let name: String
        let method: String
        let path: String
        let response: Response
    }
    let cases: [Exchange]

    static func load() throws -> Contract {
        let url = repository.appending(path: "web/src/lib/server/api/contract.json")
        return try JSONDecoder().decode(Contract.self, from: Data(contentsOf: url))
    }

    func body(_ name: String) throws -> Data {
        let exchange = try #require(cases.first { $0.name == name })
        return Data(exchange.response.body.utf8)
    }
}

/// JSON parsed into Foundation values, so two documents compare by value and never as text.
func parsed(_ data: Data) throws -> NSObject {
    try #require(JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? NSObject)
}

@Suite struct ConfigTests {
    @Test func decodesTheRecordedConfig() throws {
        let body = try Contract.load().body("config")
        let config = try JSONDecoder().decode(ConfigResponse.self, from: body)
        #expect(config.protocolVersion == 2)
        #expect(config.bots.map(\.kind) == ["random", "calling_station", "heuristic"])
        #expect(config.bots.map(\.label) == ["Random bot", "Calling bot", "RiverMind Easy"])
        #expect(config.seatCounts == Array(2...9))
        #expect(config.stakes.first == Stakes(smallBlind: 25, bigBlind: 50))
        #expect(config.reactions.map(\.kind) == Reaction.known)
        #expect(config.practiceStack == 10_000)
    }

    @Test func encodesBackToTheSameJSON() throws {
        let body = try Contract.load().body("config")
        let config = try JSONDecoder().decode(ConfigResponse.self, from: body)
        let again = try JSONEncoder().encode(config)
        #expect(try parsed(again) == parsed(body))
    }

    @Test func decodesATrainedBotWithItsEvaluations() throws {
        let body = Data(
            """
            {"protocol":2,"bots":[{"kind":"blueprint","label":"RiverMind Hard","champion":{
             "name":"hu-m1-s0-1024m","promoted":"2026-11-22","iterations":1024000000,"stack_bb":100,
             "results":[{"opponent":"heuristic","label":"RiverMind Easy","hands":200000,
             "bb_per_100":51.3,"ci95":[47.1,55.5]}]},
             "champions":[{"name":"6max-s1-s0-3600m","promoted":"2026-11-24","iterations":3600000000,
             "stack_bb":100,"results":[],"seats":[3,4,5,6]}]}],
             "seat_counts":[2,3],"stakes":[],"reactions":[]}
            """.utf8)
        let config = try JSONDecoder().decode(ConfigResponse.self, from: body)
        let hard = try #require(config.bots.first)
        #expect(hard.champion?.results.first?.bbPer100 == 51.3)
        #expect(hard.champion?.results.first?.ci95 == [47.1, 55.5])
        #expect(hard.champions?.first?.seats == [3, 4, 5, 6])
        #expect(hard.champions?.first?.iterations == 3_600_000_000)
        #expect(hard.plays(seats: 9))
        #expect(config.practiceStack == nil)
    }

    @Test func readsANewerServer() throws {
        // A field this build does not know is ignored, and a reaction it does not know keeps its name.
        let body = Data(
            """
            {"protocol":3,"oldest_app":"1.0","bots":[{"kind":"new_bot","label":"New","seats":[2],"future":true}],
             "seat_counts":[2],"stakes":[{"small_blind":1,"big_blind":2,"ante":1}],
             "reactions":[{"kind":"clap","text":"👏"}]}
            """.utf8)
        let config = try JSONDecoder().decode(ConfigResponse.self, from: body)
        #expect(config.protocolVersion == 3)
        #expect(config.bots.first?.plays(seats: 2) == true)
        #expect(config.bots.first?.plays(seats: 3) == false)
        #expect(config.reactions.first?.kind == Reaction(rawValue: "clap"))
        #expect(!Reaction.known.contains(Reaction(rawValue: "clap")))
    }

    @Test(arguments: [
        (0, "0"), (999, "999"), (1_000, "1,000"), (20_000, "20,000"), (1_234_567, "1,234,567"),
        (-1_500, "-1,500"),
    ])
    func writesChipsAsTheSiteDoes(amount: Int, text: String) {
        #expect(ConfigResponse.chips(amount) == text)
    }

    @Test func writesBlindsAsTheLobbyDoes() {
        #expect(ConfigResponse.blinds(Stakes(smallBlind: 500, bigBlind: 1000)) == "500/1000")
    }
}
