import Foundation
import Testing
@testable import RiverMindKit

/// This build's recorded session, which the server's tests replay (P5D.11,
/// `web/src/lib/server/api/app-sessions.spec.ts`): a server change that would break a
/// build still supported fails there, before it is deployed.
let appSessionFile = repository.appending(
    path: "web/src/lib/server/api/app-sessions/build-\(AppBuild.number).json")

/// Plays a fixed script through the app's own client and table connection against a real
/// server, and records every request with its answer and every frame on the table socket.
///
/// With `RIVERMIND_RECORD_APP_SESSION=1` it writes the recording for `AppBuild.number`.
/// Otherwise it checks that the committed recording still holds what this build sends:
/// the same requests in the same order, and socket messages of the same kinds with the
/// same fields. A build that changes what it sends gets a new number and a new recording.
@MainActor
@Suite(.enabled(if: Server.from(environment: ProcessInfo.processInfo.environment) != nil,
                "RIVERMIND_SERVER names no server"))
struct AppSessionRecordingTests {
    let server = Server.from(environment: ProcessInfo.processInfo.environment)!

    @Test func theRecordedSessionIsWhatThisBuildSends() async throws {
        let recorder = Recorder()
        let client = APIClient(server: server, session: MemorySessionStore(), transport: recorder.transport)
        _ = try await client.config()
        let guest = try await client.startSession()
        recorder.name(guest.playerID, as: "<guest>")
        recorder.name(guest.name, as: "<name>")
        _ = try await client.wallet()
        _ = try await client.voiceOffer()
        _ = try await client.tables()
        _ = try await client.relations()
        let practice = try await client.practice()
        recorder.name(practice.tableID, as: "<practice>")

        // At the practice table: check or call until two hands have ended, then a reaction,
        // sitting out and in, and a refill the table refuses while the guest has chips.
        let connection = TableConnection(client: client, makeSocket: recorder.sockets)
        var ended = 0
        var acted = -1
        var finished = false
        var answered = 0
        connection.onTable = { message in
            ended += message.events.filter { $0.kind == .handEnded }.count
            if finished {
                answered += 1
                return
            }
            if ended >= 2 {
                finished = true
                connection.react(.niceHand)
                connection.sitOut()
                connection.sitIn()
                connection.refill()
                return
            }
            let view = message.view
            guard let legal = view.you.legal, view.hand != nil, view.seq != acted else { return }
            acted = view.seq
            connection.act(legal.canCheck ? .check : .call)
        }
        connection.follow(practice.tableID)
        await eventually(60) { finished }
        await eventually(10) { answered >= 2 && recorder.receivedTypes.contains("error") }
        connection.leave()

        let hands = try await client.hands(limit: 5)
        let first = try #require(hands.hands.last)
        recorder.name(first.handID, as: "<hand>")
        _ = try await client.hand(first.handID)
        let made = try await client.newTable(NewTableRequest(seats: 2, bots: "random", isPrivate: true))
        recorder.name(made.tableID, as: "<table>")
        let code = try #require(made.invite)
        recorder.name(code, as: "<invite>")
        _ = try await client.invite(code)
        _ = try await client.deleteGuest()

        let recording = recorder.document()
        if ProcessInfo.processInfo.environment["RIVERMIND_RECORD_APP_SESSION"] == "1" {
            try FileManager.default.createDirectory(
                at: appSessionFile.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Recorder.text(recording).write(to: appSessionFile, atomically: true, encoding: .utf8)
            return
        }
        let committed = try #require(
            try? JSONSerialization.jsonObject(with: Data(contentsOf: appSessionFile)) as? [String: Any],
            "no recording for build \(AppBuild.number): run RIVERMIND_RECORD_APP_SESSION=1 ios/test.sh package")
        #expect(
            Recorder.requests(committed) == Recorder.requests(recording),
            "build \(AppBuild.number) sends other requests than its recording: give the build a new number and record it")
        #expect(
            Recorder.messageForms(committed) == Recorder.messageForms(recording),
            "build \(AppBuild.number) sends other socket messages than its recording: give the build a new number and record it")
    }
}

/// What the app sent and received, with the guest's and the tables' ids put by name.
final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String: String] = [:]
    private var steps: [[String: Any]] = []
    private var sent: [Any] = []
    private var received: [Any] = []
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration)
    }

    /// From now on `value` is written as `placeholder`, wherever a string or a path
    /// segment is exactly it.
    func name(_ value: String, as placeholder: String) {
        lock.withLock { names[value] = placeholder }
    }

    var receivedTypes: Set<String> {
        lock.withLock { Set(received.compactMap { ($0 as? [String: Any])?["type"] as? String }) }
    }

    var transport: Transport {
        { [self] request in
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            var path = request.url!.path()
            if let query = request.url!.query() { path += "?" + query }
            let step: [String: Any] = [
                "request": [
                    "method": request.httpMethod ?? "GET",
                    "path": path,
                    "body": Self.parse(request.httpBody) ?? NSNull(),
                ],
                "status": status,
                "response": Self.parse(data) ?? NSNull(),
            ]
            lock.withLock { steps.append(step) }
            return (data, response)
        }
    }

    var sockets: SocketMaker {
        { [self] request in
            lock.withLock { steps.append(["socket": request.url!.path()]) }
            return RecordingSocket(inner: URLSessionTableSocket(request: request), recorder: self)
        }
    }

    func didSend(_ text: String) {
        guard let message = Self.parse(Data(text.utf8)) else { return }
        lock.withLock { sent.append(message) }
    }

    func didReceive(_ text: String) {
        guard let message = Self.parse(Data(text.utf8)) else { return }
        lock.withLock { received.append(message) }
    }

    static func parse(_ data: Data?) -> Any? {
        guard let data, !data.isEmpty else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
    }

    /// The recording, every id put by name. The one socket's frames go in its step.
    func document() -> [String: Any] {
        lock.withLock {
            let names = self.names
            func named(_ value: Any) -> Any {
                switch value {
                case let text as String: return names[text] ?? text
                case let list as [Any]: return list.map(named)
                case let object as [String: Any]: return object.mapValues(named)
                default: return value
                }
            }
            func namedPath(_ path: String) -> String {
                let (route, query) = path.split(separator: "?", maxSplits: 1).map(String.init).first.map {
                    ($0, path.dropFirst($0.count))
                }!
                return route.split(separator: "/", omittingEmptySubsequences: false)
                    .map { names[String($0)] ?? String($0) }.joined(separator: "/") + query
            }
            let written: [Any] = steps.map { step in
                if step["socket"] != nil {
                    return ["socket": step["socket"]!, "sent": named(sent), "received": named(received)]
                }
                var request = step["request"] as! [String: Any]
                request["path"] = namedPath(request["path"] as! String)
                request["body"] = named(request["body"]!)
                return ["request": request, "status": step["status"]!, "response": named(step["response"]!)]
            }
            return ["build": AppBuild.number, "steps": written]
        }
    }

    /// The recording as the file holds it: one step, and one socket frame, a line.
    static func text(_ document: [String: Any]) throws -> String {
        func line(_ value: Any) throws -> String {
            String(decoding: try JSONSerialization.data(
                withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes]), as: UTF8.self)
        }
        var lines = [
            #"{"note":"The iPhone app's session, recorded by ios/RiverMindKit/Tests/RiverMindKitTests/AppSessionRecordingTests.swift (RIVERMIND_RECORD_APP_SESSION=1 ios/test.sh package). Replayed by app-sessions.spec.ts. Do not edit.","#,
            #""build":\#(document["build"]!),"#,
            #""steps":["#,
        ]
        let steps = document["steps"] as! [[String: Any]]
        for (index, step) in steps.enumerated() {
            let comma = index == steps.count - 1 ? "" : ","
            if let socket = step["socket"] {
                let sent = try (step["sent"] as! [Any]).map(line).joined(separator: ",\n")
                let received = try (step["received"] as! [Any]).map(line).joined(separator: ",\n")
                lines.append(#"{"socket":\#(try line(socket)),"sent":[\#n\#(sent)\#n],"received":[\#n\#(received)\#n]}\#(comma)"#)
            } else {
                lines.append(try line(step) + comma)
            }
        }
        lines.append("]}")
        return lines.joined(separator: "\n") + "\n"
    }

    /// Every request in order, with its body, and where the socket opened.
    static func requests(_ document: [String: Any]) -> [String] {
        (document["steps"] as? [[String: Any]] ?? []).map { step in
            if let socket = step["socket"] as? String { return "socket \(socket)" }
            let request = step["request"] as? [String: Any] ?? [:]
            let body = request["body"].flatMap { $0 is NSNull ? nil : try? line($0) } ?? ""
            return "\(request["method"] ?? "") \(request["path"] ?? "") \(body)"
        }
    }

    /// Each kind of socket message sent, with its fields and their JSON types.
    static func messageForms(_ document: [String: Any]) -> Set<String> {
        var forms = Set<String>()
        for step in document["steps"] as? [[String: Any]] ?? [] {
            for case let message as [String: Any] in step["sent"] as? [Any] ?? [] {
                let fields = message.keys.sorted().map { "\($0):\(kind(message[$0]!))" }
                forms.insert("\(message["type"] ?? "?") \(fields.joined(separator: ","))")
            }
        }
        return forms
    }

    private static func kind(_ value: Any) -> String {
        switch value {
        case is NSNull: "null"
        case let number as NSNumber where CFGetTypeID(number) == CFBooleanGetTypeID(): "boolean"
        case is NSNumber: "number"
        case is String: "string"
        case is [Any]: "array"
        default: "object"
        }
    }

    private static func line(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }
}

/// A table socket that tells the recorder every frame it carries.
final class RecordingSocket: TableSocket, @unchecked Sendable {
    let inner: any TableSocket
    let recorder: Recorder

    init(inner: any TableSocket, recorder: Recorder) {
        self.inner = inner
        self.recorder = recorder
    }

    func open() async throws { try await inner.open() }

    func send(_ text: String) async throws {
        recorder.didSend(text)
        try await inner.send(text)
    }

    func receive() async throws -> String {
        let text = try await inner.receive()
        recorder.didReceive(text)
        return text
    }

    func close() { inner.close() }
}
