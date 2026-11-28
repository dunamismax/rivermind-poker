import Foundation

/// The part of a WebSocket the table connection uses: text frames in and out, and a
/// close. `receive` throws once the socket has closed, for whatever reason.
public protocol TableSocket: AnyObject, Sendable {
    /// Waits until the handshake is done; throws when it fails.
    func open() async throws
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close()
}

/// Makes a socket for a handshake request: `URLSessionTableSocket` in the app, a stand-in
/// in tests.
public typealias SocketMaker = @Sendable (URLRequest) -> any TableSocket

/// A table socket over `URLSessionWebSocketTask`, on an ephemeral session that keeps no
/// cookies: the request carries the guest's `rm_session` itself (`APIClient.webSocketRequest`).
public final class URLSessionTableSocket: TableSocket, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let session: URLSession
    private let opened = OpenSignal()

    public init(request: URLRequest) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        // The table socket waits on the server, which may say nothing for a while.
        configuration.timeoutIntervalForRequest = 60 * 60
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let delegate = Delegate(opened: opened)
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
        task = session.webSocketTask(with: request)
        // The server's messages are a table view each, a few kilobytes; a nine-seat view
        // with a long log stays far below this.
        task.maximumMessageSize = 4 << 20
    }

    public static let maker: SocketMaker = { URLSessionTableSocket(request: $0) }

    public func open() async throws {
        task.resume()
        try await opened.wait()
    }

    public func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    public func receive() async throws -> String {
        switch try await task.receive() {
        case let .string(text): return text
        case let .data(data): return String(decoding: data, as: UTF8.self)
        @unknown default: return ""
        }
    }

    public func close() {
        task.cancel(with: .goingAway, reason: nil)
        opened.fail(URLError(.cancelled))
        session.invalidateAndCancel()
    }

    /// The session's delegate, apart from the socket so the session's strong hold on its
    /// delegate makes no cycle.
    private final class Delegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
        let opened: OpenSignal
        init(opened: OpenSignal) { self.opened = opened }

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
            opened.succeed()
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
            opened.fail(error ?? URLError(.networkConnectionLost))
        }
    }
}

/// A one-time signal that the handshake finished or failed.
final class OpenSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Void, any Error>?
    private var waiters: [CheckedContinuation<Void, any Error>] = []

    func wait() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(with: result)
            } else {
                waiters.append(continuation)
                lock.unlock()
            }
        }
    }

    func succeed() { finish(.success(())) }
    func fail(_ error: any Error) { finish(.failure(error)) }

    private func finish(_ outcome: Result<Void, any Error>) {
        lock.lock()
        guard result == nil else {
            lock.unlock()
            return
        }
        result = outcome
        let waiting = waiters
        waiters = []
        lock.unlock()
        for waiter in waiting { waiter.resume(with: outcome) }
    }
}
