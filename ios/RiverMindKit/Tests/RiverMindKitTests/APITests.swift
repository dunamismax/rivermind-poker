import Foundation
import Synchronization
import Testing
@testable import RiverMindKit

/// A transport that records the requests it is given and answers each with one reply.
final class Recorder: Sendable {
    private let sent = Mutex<[URLRequest]>([])
    let status: Int
    let body: Data

    init(status: Int = 200, body: Data) {
        self.status = status
        self.body = body
    }

    var requests: [URLRequest] { sent.withLock { $0 } }

    var transport: Transport {
        { [self] request in
            sent.withLock { $0.append(request) }
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["content-type": "application/json"])!
            return (body, response)
        }
    }
}

let local = Server(origin: "http://127.0.0.1:4380")!

@Suite struct ServerTests {
    @Test func liveIsTheSite() {
        #expect(Server.live.origin.absoluteString == "https://rivermindpoker.com")
        #expect(Server.live.url("/api/config").absoluteString == "https://rivermindpoker.com/api/config")
    }

    @Test(arguments: [
        ("http://127.0.0.1:4380", "http://127.0.0.1:4380"),
        ("https://rivermindpoker.com/", "https://rivermindpoker.com"),
        ("HTTP://localhost:8000", "http://localhost:8000"),
        (" http://[::1]:4380 ", "http://[::1]:4380"),
    ])
    func acceptsAnOrigin(text: String, origin: String) throws {
        #expect(try #require(Server(origin: text)).origin.absoluteString == origin)
    }

    @Test(arguments: [
        "", "127.0.0.1:4380", "ftp://example.com", "https://example.com/api", "https://example.com?x=1",
        "https://user:pass@example.com", "https://", "javascript:alert(1)",
    ])
    func refusesWhatIsNotAnOrigin(text: String) {
        #expect(Server(origin: text) == nil)
    }

    @Test func readsTheEnvironment() {
        #expect(Server.from(environment: ["RIVERMIND_SERVER": "http://127.0.0.1:4380"]) == local)
        #expect(Server.from(environment: ["RIVERMIND_SERVER": "not a url"]) == nil)
        #expect(Server.from(environment: [:]) == nil)
    }
}

@Suite struct APIClientTests {
    @Test func asksForTheConfigAsAPageDoes() async throws {
        let recorder = Recorder(body: try Contract.load().body("config"))
        let config = try await APIClient(server: local, transport: recorder.transport).config()
        #expect(config.bots.count == 3)
        let request = try #require(recorder.requests.first)
        #expect(request.httpMethod == "GET")
        #expect(request.url?.absoluteString == "http://127.0.0.1:4380/api/config")
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        // A client that is not a browser sends no Origin, which the server accepts (`originAllowed`).
        #expect(request.value(forHTTPHeaderField: "Origin") == nil)
    }

    @Test func reportsARefusalWithItsDetail() async throws {
        let recorder = Recorder(status: 429, body: Data(#"{"detail":"Too many requests"}"#.utf8))
        await #expect(throws: APIError.status(429, detail: "Too many requests")) {
            try await APIClient(server: local, transport: recorder.transport).config()
        }
    }

    @Test func reportsAnUnreadableAnswer() async throws {
        let recorder = Recorder(body: Data("<html>".utf8))
        await #expect {
            try await APIClient(server: local, transport: recorder.transport).config()
        } throws: { error in
            if case .unreadable = error as? APIError { true } else { false }
        }
    }

    @Test func reportsNoAnswer() async throws {
        let client = APIClient(server: local) { _ in throw URLError(.cannotConnectToHost) }
        await #expect {
            try await client.config()
        } throws: { error in
            if case .unreachable = error as? APIError { true } else { false }
        }
    }
}

@Suite @MainActor struct LobbyModelTests {
    @Test func loadsTheConfig() async throws {
        let recorder = Recorder(body: try Contract.load().body("config"))
        let model = LobbyModel(client: APIClient(server: local, transport: recorder.transport))
        #expect(model.state == .loading)
        await model.load()
        guard case let .ready(config) = model.state else {
            Issue.record("expected the config, got \(model.state)")
            return
        }
        #expect(config.seatCounts == Array(2...9))
    }

    @Test func saysWhyItFailed() async throws {
        let model = LobbyModel(
            client: APIClient(server: local) { _ in throw URLError(.cannotConnectToHost) })
        await model.load()
        guard case let .failed(message) = model.state else {
            Issue.record("expected a failure, got \(model.state)")
            return
        }
        #expect(message.hasPrefix("The server could not be reached"))
    }
}

/// Against a real server when `RIVERMIND_SERVER` names one: `ios/test.sh` starts the
/// Node server from `web/build` and sets it.
@Suite(.enabled(if: Server.from(environment: ProcessInfo.processInfo.environment) != nil,
                "RIVERMIND_SERVER names no server"))
struct LocalServerTests {
    @Test func readsTheConfigFromARealServer() async throws {
        let server = try #require(Server.from(environment: ProcessInfo.processInfo.environment))
        let config = try await APIClient(server: server).config()
        #expect(config.protocolVersion == 2)
        #expect(config.seatCounts == Array(2...9))
        #expect(config.bots.contains { $0.kind == "heuristic" && $0.label == "RiverMind Easy" })
    }
}
