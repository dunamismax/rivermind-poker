import Foundation

/// How the client sends a request: `URLSession` in the app, a stand-in in tests.
public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

/// A refused or unreadable answer from the HTTP API.
public enum APIError: Error, Sendable, Equatable {
    /// The server answered with a status other than 2xx, and its `detail` when it gave one.
    case status(Int, detail: String?)
    /// The answer was not the JSON the route promises.
    case unreadable(String)
    /// No answer reached the app.
    case unreachable(String)
}

extension APIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .status(code, detail): detail ?? "The server answered \(code)."
        case .unreadable: "The server's answer could not be read."
        case let .unreachable(reason): "The server could not be reached: \(reason)"
        }
    }
}

/// The HTTP API (`/api/*`), as a page uses it.
///
/// It sends no `Origin`: the server accepts requests without one from a client that is
/// not a browser (`originAllowed`). The session cookie is not handled yet; P5D.2 keeps
/// it in the Keychain (docs/ios.md), so the URL session stores no cookies of its own.
public struct APIClient: Sendable {
    public let server: Server
    private let transport: Transport

    public init(server: Server, transport: @escaping Transport) {
        self.server = server
        self.transport = transport
    }

    /// A client over an ephemeral `URLSession` that keeps no cookies or cache.
    public init(server: Server) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: configuration)
        self.init(server: server) { request in try await session.data(for: request) }
    }

    /// `GET /api/config`: what the server offers.
    public func config() async throws -> ConfigResponse {
        try await get("/api/config")
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: server.url(path))
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await send(request)
    }

    func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport(request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError.unreachable(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.unreadable("not an HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.status(http.statusCode, detail: Self.detail(of: data))
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.unreadable(String(describing: error))
        }
    }

    /// The `detail` of an error body, `{"detail": "..."}`, when it is a string.
    static func detail(of data: Data) -> String? {
        struct Body: Decodable { let detail: String }
        return try? JSONDecoder().decode(Body.self, from: data).detail
    }
}
