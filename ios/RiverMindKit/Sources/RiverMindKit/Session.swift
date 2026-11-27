import Foundation
import Security
import Synchronization

/// Where the app keeps the guest's `rm_session` cookie (docs/ios.md): the Keychain in the
/// app, memory in tests. The value is the cookie's alone, without its name or attributes.
public protocol SessionStore: Sendable {
    func load() -> String?
    func save(_ value: String?)
}

/// The session in memory, for tests and for a client that should forget it.
public final class MemorySessionStore: SessionStore {
    private let value: Mutex<String?>

    public init(_ value: String? = nil) {
        self.value = Mutex(value)
    }

    public func load() -> String? { value.withLock { $0 } }
    public func save(_ value: String?) { self.value.withLock { $0 = value } }
}

/// The session in the Keychain: a generic password for the service
/// `com.rivermindpoker.app`, with the server's origin as its account, so a debug build's
/// local guests never mix with the live one. Readable after the first unlock, so a table
/// and voice in the background can reconnect with the screen locked (Q-16), and never
/// synchronized, so it stays on this phone.
public struct KeychainSessionStore: SessionStore {
    public static let service = "com.rivermindpoker.app"
    public let account: String

    public init(server: Server) {
        account = server.origin.absoluteString
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    public func load() -> String? {
        var asked = query
        asked[kSecReturnData as String] = true
        asked[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(asked as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func save(_ value: String?) {
        guard let value else {
            SecItemDelete(query as CFDictionary)
            return
        }
        let data = Data(value.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            kSecAttrSynchronizable as String: false,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
    }
}

/// The session cookie's name, and how the client reads it from a `Set-Cookie`.
public enum SessionCookie {
    public static let name = "rm_session"

    /// The value of `rm_session` in a `Set-Cookie` header, or `nil` when it sets another
    /// cookie. An expired one (`Max-Age=0`) reads as an empty string: the session ended.
    public static func value(fromSetCookie header: String) -> String? {
        // A response may fold several cookies into one header with commas, and a cookie's
        // Expires date has a comma of its own; the session cookie has none.
        for cookie in header.split(separator: ",") {
            let parts = cookie.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
            guard let first = parts.first, first.hasPrefix(name + "=") else { continue }
            let value = String(first.dropFirst(name.count + 1))
            let expired = parts.dropFirst().contains { $0.lowercased() == "max-age=0" }
            return expired ? "" : value
        }
        return nil
    }
}
