import Foundation
import Observation

/// The lobby's state: P5D.1's placeholder, which reads what the server offers.
/// P5D.6 grows it into the lobby the site has.
@MainActor
@Observable
public final class LobbyModel {
    public enum State: Equatable, Sendable {
        case loading
        case ready(ConfigResponse)
        case failed(String)
    }

    public private(set) var state: State = .loading
    public let server: Server
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
        self.server = client.server
    }

    /// Reads `GET /api/config` again.
    public func load() async {
        state = .loading
        do {
            state = .ready(try await client.config())
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
