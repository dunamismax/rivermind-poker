import Foundation

/// The RiverMind server the app talks to: the live site, or a local one in a debug build.
public struct Server: Sendable, Equatable {
    /// The origin every route hangs from, such as `https://rivermindpoker.com`.
    public let origin: URL

    /// The live site.
    public static let live = Server(validated: URL(string: "https://rivermindpoker.com")!)

    /// The environment variable a debug build reads, as `http://127.0.0.1:4380`.
    public static let environmentKey = "RIVERMIND_SERVER"

    private init(validated origin: URL) {
        self.origin = origin
    }

    /// A server at an origin: `http` or `https`, a host, and no path, query or fragment.
    public init?(origin text: String) {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespaces)),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              components.path.isEmpty || components.path == "/",
              components.query == nil, components.fragment == nil,
              components.user == nil, components.password == nil
        else { return nil }
        var clean = URLComponents()
        clean.scheme = scheme
        clean.host = host
        clean.port = components.port
        guard let url = clean.url else { return nil }
        self.init(validated: url)
    }

    /// The server named by `RIVERMIND_SERVER`, or `nil` when it is missing or not an origin.
    public static func from(environment: [String: String]) -> Server? {
        environment[environmentKey].flatMap(Server.init(origin:))
    }

    /// The URL of an API path such as `/api/config`.
    public func url(_ path: String) -> URL {
        precondition(path.hasPrefix("/"), "an API path starts with a slash")
        return URL(string: origin.absoluteString + path)!
    }
}
