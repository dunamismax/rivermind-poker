import Foundation

/// How the client sends a request: `URLSession` in the app, a stand-in in tests.
public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

/// A refused or unreadable answer from the HTTP API.
public enum APIError: Error, Sendable, Equatable {
    /// The server answered with a status other than 2xx, and its `detail` when it gave one.
    case status(Int, detail: String?)
    /// Too many requests (429): the server's or Caddy's limit, and how many seconds to wait.
    /// The client never retries by itself.
    case limited(detail: String?, retryAfter: Int?)
    /// The answer was not the JSON the route promises.
    case unreadable(String)
    /// No answer reached the app.
    case unreachable(String)
}

extension APIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .status(code, detail): detail ?? "The server answered \(code)."
        case let .limited(detail, _): detail ?? "Too many requests; wait a moment."
        case .unreadable: "The server's answer could not be read."
        case let .unreachable(reason): "The server could not be reached: \(reason)"
        }
    }
}

/// The HTTP API (`/api/*`), as a page uses it (docs/ios.md lists the routes).
///
/// It sends no `Origin`: the server accepts requests without one from a client that is
/// not a browser (`originAllowed`). The guest's `rm_session` cookie is kept in a
/// `SessionStore`, the Keychain in the app: the client sends it with every request and
/// keeps whatever `Set-Cookie: rm_session=…` it is given, which is how the server makes
/// and renews a guest. The URL session stores no cookies of its own.
///
/// It makes one request for each thing asked of it, as a page does, so it stays within
/// the API's and Caddy's limits as a page does. A 429 is reported, never retried; a 401
/// on any route but `POST /api/session` means the session ended, and the client makes
/// the guest again with `POST /api/session` and asks once more, as a page's reload does.
public struct APIClient: Sendable {
    public let server: Server
    public let session: any SessionStore
    private let transport: Transport

    public init(server: Server, session: any SessionStore = MemorySessionStore(), transport: @escaping Transport) {
        self.server = server
        self.session = session
        self.transport = transport
    }

    /// A client over an ephemeral `URLSession` that keeps no cookies or cache.
    public init(server: Server, session: any SessionStore = MemorySessionStore()) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        let urlSession = URLSession(configuration: configuration)
        self.init(server: server, session: session) { request in try await urlSession.data(for: request) }
    }

    /// The app's own client: the session kept in the Keychain for this server.
    public static func app(server: Server) -> APIClient {
        APIClient(server: server, session: KeychainSessionStore(server: server))
    }

    // MARK: - The routes

    /// `GET /api/config`: what the server offers.
    public func config() async throws -> ConfigResponse {
        try await send("GET", "/api/config")
    }

    /// `POST /api/session`: the guest this app is, made on the first call and renewed
    /// when its cookie is a day old.
    public func startSession() async throws -> SessionResponse {
        try await send("POST", "/api/session", body: Optional<SessionRequest>.none, renew: false)
    }

    /// `GET /api/wallet`: the play-chip balance and the newest entries.
    public func wallet() async throws -> WalletResponse {
        try await send("GET", "/api/wallet")
    }

    /// `GET /api/tables`: the open tables, with the lobby's filters.
    public func tables(seats: Int? = nil, bigBlind: Int? = nil, open: Bool? = nil) async throws -> TableListResponse {
        var query: [URLQueryItem] = []
        if let seats { query.append(URLQueryItem(name: "seats", value: String(seats))) }
        if let bigBlind { query.append(URLQueryItem(name: "big_blind", value: String(bigBlind))) }
        if let open { query.append(URLQueryItem(name: "open", value: open ? "true" : "false")) }
        return try await send("GET", "/api/tables", query: query)
    }

    /// `POST /api/tables`: a new table, with this guest in seat 0.
    public func newTable(_ request: NewTableRequest) async throws -> NewTableResponse {
        try await send("POST", "/api/tables", body: request)
    }

    /// `GET /api/invites/{code}`: the private table an invite is for.
    public func invite(_ code: String) async throws -> TableSummary {
        try await send("GET", "/api/invites/\(Self.segment(code))")
    }

    /// `POST /api/tables/{id}/seat`: hold a seat and, unless `holdOnly`, buy in and sit.
    public func takeSeat(table: String, _ request: SeatRequest = SeatRequest()) async throws -> SeatResponse {
        try await send("POST", "/api/tables/\(Self.segment(table))/seat", body: request)
    }

    /// `DELETE /api/tables/{id}/seat`: give up a held seat.
    public func giveUpSeat(table: String) async throws {
        let _: Empty? = try await send("DELETE", "/api/tables/\(Self.segment(table))/seat")
    }

    /// `POST /api/tables/{id}/waitlist`: wait for a seat at a full table.
    public func joinWaitlist(table: String, _ request: WaitlistRequest = WaitlistRequest()) async throws
        -> WaitlistResponse
    {
        try await send("POST", "/api/tables/\(Self.segment(table))/waitlist", body: request)
    }

    /// `DELETE /api/tables/{id}/waitlist`: stop waiting.
    public func leaveWaitlist(table: String) async throws {
        let _: Empty? = try await send("DELETE", "/api/tables/\(Self.segment(table))/waitlist")
    }

    /// `POST /api/quick-seat`: a seat at the busiest matching table, or a new one with bots.
    public func quickSeat(_ request: QuickSeatRequest = QuickSeatRequest()) async throws -> SeatResponse {
        try await send("POST", "/api/quick-seat", body: request)
    }

    /// `POST /api/practice`: the guest's practice table, heads-up against a labelled bot.
    public func practice(_ request: PracticeRequest = PracticeRequest()) async throws -> PracticeResponse {
        try await send("POST", "/api/practice", body: request)
    }

    /// `GET /api/hands`: the hands this guest played, newest first.
    public func hands(limit: Int? = nil, before: String? = nil) async throws -> HandListResponse {
        var query: [URLQueryItem] = []
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try await send("GET", "/api/hands", query: query)
    }

    /// `GET /api/hands/{id}`: a hand this guest played, with every card they may see.
    public func hand(_ id: String) async throws -> HandDetail {
        try await send("GET", "/api/hands/\(Self.segment(id))")
    }

    /// `GET /api/relations`: everyone this guest muted or blocked.
    public func relations() async throws -> RelationsResponse {
        try await send("GET", "/api/relations")
    }

    /// `PUT /api/relations`: mute or block the person in a seat.
    public func setRelation(_ request: RelationRequest) async throws -> RelationsResponse {
        try await send("PUT", "/api/relations", body: request)
    }

    /// `DELETE /api/relations/{ref}`: unmute or unblock someone.
    public func removeRelation(ref: String) async throws -> RelationsResponse {
        try await send("DELETE", "/api/relations/\(Self.segment(ref))")
    }

    /// `POST /api/reports`: report the person in a seat, for review.
    public func report(_ request: ReportRequest) async throws -> ReportResponse {
        try await send("POST", "/api/reports", body: request)
    }

    /// `GET /api/voice`: whether table voice is offered here.
    public func voiceOffer() async throws -> VoiceOffer {
        try await send("GET", "/api/voice")
    }

    /// `POST /api/tables/{id}/voice`: a voice token for this guest's seat, good for one
    /// socket within a minute.
    public func voiceToken(table: String) async throws -> VoiceTokenResponse {
        try await send("POST", "/api/tables/\(Self.segment(table))/voice", body: Optional<Empty>.none)
    }

    /// The handshake of a WebSocket on this server, such as `/ws` or `/voice`, with the
    /// session cookie and no `Origin`, as the API's own requests go.
    public func webSocketRequest(_ path: String) -> URLRequest {
        var components = URLComponents(url: server.url(path), resolvingAgainstBaseURL: false)!
        components.scheme = server.origin.scheme == "https" ? "wss" : "ws"
        var request = URLRequest(url: components.url!)
        if let cookie = session.load(), !cookie.isEmpty {
            request.setValue("\(SessionCookie.name)=\(cookie)", forHTTPHeaderField: "Cookie")
        }
        return request
    }

    // MARK: - Sending

    /// A path segment with everything but unreserved characters escaped.
    static func segment(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~")))
            ?? text
    }

    func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data?) -> URLRequest {
        var components = URLComponents(url: server.url(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let cookie = session.load(), !cookie.isEmpty {
            request.setValue("\(SessionCookie.name)=\(cookie)", forHTTPHeaderField: "Cookie")
        }
        return request
    }

    func send<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await send(method, path, query: query, body: Optional<Empty>.none)
    }

    func send<T: Decodable, B: Encodable>(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: B?, renew: Bool = true
    ) async throws -> T {
        let data = try body.map { try JSONEncoder().encode($0) }
        do {
            return try await exchange(request(method, path, query: query, body: data))
        } catch APIError.status(401, _) where renew {
            // The session ended (expired, or a secret the server no longer has): a new
            // guest, as a page's reload makes, then the request once more.
            _ = try await startSession()
            return try await exchange(request(method, path, query: query, body: data))
        }
    }

    func exchange<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport(request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError.unreachable(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.unreadable("not an HTTP response")
        }
        if let header = http.value(forHTTPHeaderField: "Set-Cookie"),
           let value = SessionCookie.value(fromSetCookie: header)
        {
            session.save(value.isEmpty ? nil : value)
        }
        if http.statusCode == 429 {
            let wait = http.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0) }
            throw APIError.limited(detail: Self.detail(of: data), retryAfter: wait)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.status(http.statusCode, detail: Self.detail(of: data))
        }
        if http.statusCode == 204 || data.isEmpty, let none = Optional<Empty>.none as? T {
            return none
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.unreadable(String(describing: error))
        }
    }

    /// The `detail` of an error body, `{"detail": "..."}`, when it is a string.
    static func detail(of data: Data) -> String? {
        (try? JSONDecoder().decode(HttpError.self, from: data))?.detail
    }
}
