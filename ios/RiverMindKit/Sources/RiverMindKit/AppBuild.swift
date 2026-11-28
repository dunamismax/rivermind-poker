import Foundation

/// This build of the app, as the server sees it (P5D.11).
///
/// `number` is the app's `CFBundleVersion` (`CURRENT_PROJECT_VERSION` in the Xcode
/// project; `ios/test.sh` checks the two agree). The app names it in a
/// `RiverMind-Client: ios/<number>` header on every request and on the `/ws` handshake,
/// so the server's aggregate counts can tell the app from the site; every copy of a build
/// sends the same value, so it identifies nobody (Q-6).
///
/// The server names the oldest build it still serves in `GET /api/config`
/// (`oldest_app_build`). An older build asks to be updated instead of playing. Each build
/// that changes what it sends gets a new number and a new recording in
/// `web/src/lib/server/api/app-sessions/`, which the server's tests replay
/// (`AppSessionRecordingTests.swift`, AGENTS.md).
public enum AppBuild {
    public static let number = 1

    /// The header the server reads the kind of client from.
    public static let clientHeaderName = "RiverMind-Client"
    public static var clientHeader: String { "ios/\(number)" }

    /// Whether the server still serves `build`: true unless it names a newer oldest build.
    public static func isSupported(by config: ConfigResponse, build: Int = number) -> Bool {
        guard let oldest = config.oldestAppBuild else { return true }
        return build >= oldest
    }
}
