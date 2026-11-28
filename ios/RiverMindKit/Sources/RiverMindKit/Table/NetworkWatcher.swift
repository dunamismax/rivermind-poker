import Foundation
import Network

/// Tells the table connection when the network moves (Wi-Fi to cellular, or back), so it
/// rejoins at once on the new path instead of waiting for the old socket to time out
/// (P5D.3). It reports a change only once a usable path is back and differs from the last
/// one in its interfaces; losing the network altogether is left to the socket, which
/// drops and retries with backoff.
public final class NetworkWatcher: @unchecked Sendable {
    /// What about a path decides whether a socket on the old one is still good.
    public struct Path: Sendable, Hashable {
        public var usable: Bool
        public var interfaces: [String]

        public init(usable: Bool, interfaces: [String]) {
            self.usable = usable
            self.interfaces = interfaces
        }

        init(_ path: NWPath) {
            usable = path.status == .satisfied
            interfaces = path.availableInterfaces.map { "\($0.type) \($0.name)" }
        }
    }

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.rivermindpoker.network")
    private let lock = NSLock()
    private var last: Path?

    public init() {}

    /// Starts watching; `changed` runs on the main actor after each move to a new usable path.
    public func start(_ changed: @escaping @MainActor @Sendable () -> Void) {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self, self.moved(to: Path(path)) else { return }
            Task { @MainActor in changed() }
        }
        monitor.start(queue: queue)
    }

    public func stop() {
        monitor.cancel()
    }

    /// Whether `path` is a move that a socket on the previous path does not survive.
    func moved(to path: Path) -> Bool {
        lock.withLock {
            defer { if path.usable { last = path } }
            guard path.usable, let last else { return false }
            return last.interfaces != path.interfaces
        }
    }
}
