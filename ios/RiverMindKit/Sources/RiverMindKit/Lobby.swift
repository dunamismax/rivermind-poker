import Foundation
import Observation

/// The lobby's state: P5D.1's placeholder, which makes or renews the guest and reads
/// what the server offers. P5D.6 grows it into the lobby the site has.
@MainActor
@Observable
public final class LobbyModel {
    public enum State: Equatable, Sendable {
        case loading
        case ready(ConfigResponse, guest: SessionResponse)
        /// The server no longer serves this build (P5D.11): it names the oldest it does.
        case updateNeeded(oldest: Int)
        /// The guest was deleted (P5D.11); `erased` is false while a hand under way still
        /// held their seat, whose chips and data go when it ends.
        case deleted(erased: Bool)
        case failed(String)
    }

    public private(set) var state: State = .loading
    public let server: Server
    private let client: APIClient
    /// The build checked against the server's oldest: this one, or in a debug build's
    /// UI test an older one it pretends to be.
    private let build: Int

    public init(client: APIClient, build: Int = AppBuild.number) {
        self.client = client
        self.server = client.server
        self.build = build
    }

    /// One-click practice (P6.0b): the guest's practice table, followed by `table`. P5D.6
    /// gives it the lobby's button; a debug build's `-practice` launch uses it until then.
    public func practice(on table: TableConnection) async throws {
        let started = try await client.practice()
        table.follow(started.tableID)
    }

    /// `GET /api/config`, then `POST /api/session`, as a page does on load. The config
    /// comes first so that a build the server no longer serves asks to be updated before
    /// it makes a guest.
    public func load() async {
        state = .loading
        do {
            let config = try await client.config()
            guard AppBuild.isSupported(by: config, build: build) else {
                state = .updateNeeded(oldest: config.oldestAppBuild ?? AppBuild.number)
                return
            }
            let guest = try await client.startSession()
            state = .ready(config, guest: guest)
        } catch is CancellationError {
            return
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Deletes this guest and their data (P5D.11), after the screen has asked twice. The
    /// table connection lets go of the table first, so it does not try to rejoin.
    public func deleteGuest(leaving table: TableConnection? = nil) async {
        table?.disconnect()
        do {
            let answer = try await client.deleteGuest()
            table?.forgetTable()
            state = .deleted(erased: answer.erased)
        } catch is CancellationError {
            return
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}

extension ConfigResponse {
    /// Blinds as the lobby's form writes them, such as `500/1000`, ungrouped (`NlLobby.svelte`).
    public static func blinds(_ stakes: Stakes) -> String {
        "\(stakes.smallBlind)/\(stakes.bigBlind)"
    }

    /// A chip count grouped by commas, as the site's `toLocaleString('en-US')` writes it.
    public static func chips(_ amount: Int) -> String {
        let digits = String(amount.magnitude)
        var grouped = ""
        for (index, digit) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { grouped.append(",") }
            grouped.append(digit)
        }
        return amount < 0 ? "-" + grouped : grouped
    }
}
