import Foundation
import Observation

/// “Your hands” (P5D.8), as the site's `/hands` page has them: the finished hands the guest
/// was dealt into, newest first, a page at a time, and one of them opened to replay.
/// Folded and mucked hands never reach the app: the server sends only what the guest may see.
@MainActor
@Observable
public final class HandsModel {
    public let client: APIClient

    public private(set) var hands: [HandSummary] = []
    /// Whether older hands follow the last one listed.
    public private(set) var more = false
    public private(set) var loading = false
    public private(set) var error: String?
    /// The hand opened, to replay.
    public var open: HandDetail?
    /// The hand being fetched, while it is.
    public private(set) var opening: String?
    /// Whether the first page has been asked for.
    public private(set) var loaded = false

    public init(client: APIClient) {
        self.client = client
    }

    /// The newest hands, or with `older` the page after the last one listed.
    public func load(older: Bool = false) async {
        guard !loading else { return }
        loading = true
        error = nil
        defer {
            loading = false
            loaded = true
        }
        do {
            let page = try await client.hands(before: older ? hands.last?.handID : nil)
            hands = older ? hands + page.hands.filter { new in !hands.contains { $0.handID == new.handID } } : page.hands
            more = page.more
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Opens one of the guest's hands.
    public func show(_ handID: String) async {
        guard opening == nil else { return }
        opening = handID
        defer { opening = nil }
        do {
            open = try await client.hand(handID)
        } catch {
            self.error = error.localizedDescription
        }
    }

    public func close() {
        open = nil
    }
}

/// The hand review at the table (P6.1 on the site, P5D.8 in the app): a finished hand of
/// this table, opened without leaving the seat, so the next hand can be played with it open.
@MainActor
@Observable
public final class HandReview {
    public let client: APIClient
    public private(set) var detail: HandDetail?
    public private(set) var loading = false

    public init(client: APIClient) {
        self.client = client
    }

    /// Opens hand `handNo` of the table, or the guest's newest hand there. A miss is said
    /// at the table, as the page says it (`noHandText`).
    public func open(table tableID: String, handNo: Int?, on connection: TableConnection) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            guard let handID = try await HandFinder.find(table: tableID, handNo: handNo, client: client) else {
                connection.notify(TableWords.noHandText(handNo))
                return
            }
            detail = try await client.hand(handID)
        } catch {
            connection.notify("Could not open the hand: \(error.localizedDescription)")
        }
    }

    public func close() {
        detail = nil
    }
}

/// `findHand` in the page's `api.ts`: the id of hand `handNo` of a table among the guest's
/// hands, or their newest hand there, looking through at most three pages.
public enum HandFinder {
    public static func find(table tableID: String, handNo: Int?, client: APIClient) async throws -> String? {
        var before: String?
        for _ in 0..<3 {
            let page = try await client.hands(before: before)
            switch search(page.hands, table: tableID, handNo: handNo) {
            case let .found(id): return id
            case .absent: return nil
            case .further:
                if !page.more || page.hands.isEmpty { return nil }
                before = page.hands.last?.handID
            }
        }
        return nil
    }

    enum Search: Equatable {
        case found(String)
        /// Past its number: newest first, the hand is not on a later page.
        case absent
        /// Not on this page; perhaps on the next.
        case further
    }

    static func search(_ hands: [HandSummary], table tableID: String, handNo: Int?) -> Search {
        for hand in hands where hand.tableID == tableID {
            if handNo == nil || hand.handNo == handNo { return .found(hand.handID) }
            if let handNo, hand.handNo < handNo { return .absent }
        }
        return .further
    }
}

/// The words of “Your hands” and the replayer that are not the replay's own steps.
public enum HandWords {
    /// `signed` on the page: “+1,200”, “-300”, “0”.
    public static func signed(_ amount: Int) -> String {
        amount > 0 ? "+\(ConfigResponse.chips(amount))" : ConfigResponse.chips(amount)
    }

    /// When the hand ended, as the page writes it in English (“Nov 28, 9:45 AM”), in the
    /// phone's own time zone.
    public static func when(_ at: Double, timeZone: TimeZone = .current) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = timeZone
        format.dateFormat = "MMM d, h:mm a"
        return format.string(from: Date(timeIntervalSince1970: at))
    }

    /// “Hand Room · hand #12”.
    public static func title(_ hand: HandSummary) -> String {
        "\(hand.tableName) · hand #\(hand.handNo)"
    }

    /// The detail's line under its title: “Practice chips · Nov 28, 9:45 AM · Blinds 50/100 · Pot 1,200”.
    public static func meta(_ hand: HandSummary, timeZone: TimeZone = .current) -> String {
        (hand.practice == true ? "Practice chips · " : "")
            + "\(when(hand.at, timeZone: timeZone)) · Blinds \(hand.smallBlind)/\(hand.bigBlind) · Pot \(ConfigResponse.chips(hand.pot))"
    }

    /// A result's tone: won, lost or even.
    public enum Tone: Sendable { case won, lost, even }

    public static func tone(_ net: Int) -> Tone {
        net > 0 ? .won : net < 0 ? .lost : .even
    }
}
