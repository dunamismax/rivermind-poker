// The lobby's words and what it works out only to show them: a port of
// web/src/lib/nl/lobby.ts, held to it by `pnpm ios:fixtures`
// (DisplayParityTests.swift). A change to either side lands in both in the same
// commit.

import Foundation

public enum LobbyWords {
    /// What each bot is, in a few words, on the new-table form.
    static let botNotes: [String: String] = [
        "heuristic": "Plays its cards with a plan.",
        "medium": "Half Hard, half Easy.",
        "hard": "Trained by self-play.",
        "calling_station": "Calls almost anything.",
        "random": "Does whatever it likes.",
    ]

    /// A bot's note, with the table sizes it plays when it does not play them all.
    public static func botNote(_ bot: BotOption) -> String {
        let note = botNotes[bot.kind] ?? ""
        guard let seats = bot.seats else { return note }
        return "\(note) \(Faces.seatsNote(seats))".trimmingCharacters(in: .whitespaces)
    }

    static let trainedNotes: [String: String] = [
        "medium": "plays half its hands as RiverMind Hard and half as RiverMind Easy.",
        "hard": "is a trained bot.",
    ]

    /// The words after a trained bot's name, before its published result (D-7).
    public static func trainedNote(_ kind: String) -> String {
        trainedNotes[kind] ?? trainedNotes["hard"]!
    }

    /// The trained bots to practise against: those that play two seats, from the easiest up.
    public static func practiceBots(_ bots: [BotOption]) -> [BotOption] {
        bots.filter { $0.champion != nil && $0.plays(seats: 2) }
    }

    /// The bots that play a table of `seats` seats.
    public static func bots(_ bots: [BotOption], for seats: Int) -> [BotOption] {
        bots.filter { $0.plays(seats: seats) }
    }

    /// The note under the practice button.
    public static func practiceNote(stack: Int?) -> String {
        "Heads-up against the RiverMind Easy bot with \(ConfigResponse.chips(stack ?? 10000)) "
            + "practice chips. Your wallet is not touched, and you get a fresh stack whenever you run out."
    }

    /// The wallet's top-up rules (`wallet.ts`).
    public static let walletHint = "New players start with 20,000; below 10,000, a visit tops you up once a day."

    /// Buy-ins run from 40 to 100 big blinds, the server's default range.
    public static let buyIns = [40, 70, 100]

    /// The buy-ins, in big blinds, that a wallet of `balance` covers at `bigBlind` (all while unknown).
    public static func affordableBuyIns(bigBlind: Int, balance: Int?) -> [Int] {
        buyIns.filter { balance == nil || $0 * bigBlind <= balance! }
    }

    /// A buy-in's choice on the form: "4000 (40 big blinds)".
    public static func buyInLabel(_ blinds: Int, bigBlind: Int) -> String {
        "\(blinds * bigBlind) (\(blinds) big blinds)"
    }

    /// Who sits at a listed table: "2 people · 3 bots · 1 empty · 1 waiting".
    public static func seatsText(_ t: TableSummary) -> String {
        var parts = ["\(t.people) \(t.people == 1 ? "person" : "people")"]
        if t.bots != 0 { parts.append("\(t.bots) \(t.bots == 1 ? "bot" : "bots")") }
        if t.freeSeats != 0 { parts.append("\(t.freeSeats) empty") }
        if t.waitlist != 0 { parts.append("\(t.waitlist) waiting") }
        return parts.joined(separator: " · ")
    }

    public enum Pip: String, Sendable, Hashable, Decodable {
        case person, bot, held, empty
    }

    /// One pip per seat: people, bots (a bot finishing its hand for a held seat included),
    /// held empty seats, empty seats.
    public static func pips(_ t: TableSummary) -> [Pip] {
        let held = max(0, t.seatCount - t.people - t.bots - t.freeSeats)
        return Array(repeating: .person, count: max(0, t.people))
            + Array(repeating: .bot, count: max(0, t.bots))
            + Array(repeating: .held, count: held)
            + Array(repeating: .empty, count: max(0, t.freeSeats))
    }

    /// A listed table's stakes: "Blinds 50/100 · buy-in 4,000 to 10,000".
    public static func tableDetail(_ t: TableSummary) -> String {
        "Blinds \(t.smallBlind)/\(t.bigBlind) · buy-in \(ConfigResponse.chips(t.minBuyIn)) to "
            + ConfigResponse.chips(t.maxBuyIn)
    }

    /// Whether a listed table has a seat a person can take: an empty one, or a bot's.
    public static func hasRoom(_ t: TableSummary) -> Bool {
        t.freeSeats + t.botSeats > 0
    }

    /// What the viewer can do at a listed table, and what its row says about them.
    public enum Choice: Sendable, Hashable {
        case seated
        case ready(note: String)
        case held(note: String)
        case waiting(note: String)
        case sit(afford: Bool)
        case waitlist(afford: Bool)
    }

    public static func choice(_ t: TableSummary, balance: Int?) -> Choice {
        if t.seated { return .seated }
        if let hold = t.hold {
            return hold.ready
                ? .ready(note: "Your seat is ready") : .held(note: "Seat held: a bot is finishing its hand")
        }
        if let position = t.waitlistPosition { return .waiting(note: "Number \(position) in line") }
        let afford = balance == nil || balance! >= t.minBuyIn
        return hasRoom(t) ? .sit(afford: afford) : .waitlist(afford: afford)
    }

    /// An invite's table, as the lobby offers it: "Ann's table: blinds 50/100, 1 person seated."
    public static func inviteLine(_ t: TableSummary) -> String {
        "\(t.name): blinds \(t.smallBlind)/\(t.bigBlind), \(t.people) \(t.people == 1 ? "person" : "people") seated."
    }

    /// What `encodeURIComponent` leaves as it is.
    private static let componentSafe = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    /// A private table's invite link on the server at `origin`.
    public static func inviteLink(origin: String, code: String) -> String {
        "\(origin)/?invite=\(code.addingPercentEncoding(withAllowedCharacters: componentSafe) ?? code)"
    }

    /// The invite code in a link or in what a person pasted: the `invite` of a site link
    /// such as `https://rivermindpoker.com/?invite=…`, or the code itself.
    public static func inviteCode(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let components = URLComponents(string: trimmed), components.scheme != nil {
            let code = components.queryItems?.first { $0.name == "invite" }?.value
            return code.flatMap { $0.isEmpty ? nil : $0 }
        }
        if trimmed.contains("invite="),
           let components = URLComponents(string: "https://x/" + trimmed.drop { $0 != "?" }),
           let code = components.queryItems?.first(where: { $0.name == "invite" })?.value, !code.isEmpty
        {
            return code
        }
        return trimmed.contains(where: \.isWhitespace) || trimmed.contains("/") ? nil : trimmed
    }
}
