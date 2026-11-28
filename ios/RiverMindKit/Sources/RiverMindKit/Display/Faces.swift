// Who sits where: each seat's avatar, the label every bot wears (D-7), a seat's
// words, and the lines about a trained bot's evaluation. A port of
// web/src/lib/nl/faces.ts, held to it by `pnpm ios:fixtures`
// (DisplayParityTests.swift).

import Foundation

/// A part of a bot's name, and whether a phone's pod shows it.
public struct NamePart: Sendable, Hashable, Decodable {
    public var text: String
    public var pod: Bool
    /// The site's own name, which no seat has room for.
    public var house: Bool?
}

public enum Faces {
    static let botLabels: [String: String] = [
        "heuristic": "RiverMind Easy",
        "medium": "RiverMind Medium",
        "hard": "RiverMind Hard",
        "random": "Random",
        "calling_station": "Calling",
    ]

    static let botAvatars: [String: String] = [
        "heuristic": "avatar-heuristic",
        "medium": "avatar-medium",
        "hard": "avatar-hard",
        "random": "avatar-random",
        "calling_station": "avatar-calling-station",
    ]

    public static let personAvatars = 6

    /// A win rate in big blinds per 100 hands, signed.
    public static func winRate(_ value: Double) -> String {
        "\(value >= 0 ? "+" : "−")\(toFixed(abs(value), 1))"
    }

    /// One sentence on a trained bot's published evaluation: its result against
    /// RiverMind Easy (D-7).
    public static func championLine(_ champion: BotChampion) -> String {
        guard let easy = champion.results.first(where: { $0.opponent == "heuristic" }) ?? champion.results.first
        else { return "" }
        let low = easy.ci95.first ?? .nan
        let high = easy.ci95.count > 1 ? easy.ci95[1] : .nan
        return "Over \(ConfigResponse.chips(easy.hands)) hands it won \(winRate(easy.bbPer100)) big blinds "
            + "per 100 hands against \(easy.label) (95% interval \(winRate(low)) to \(winRate(high)))."
    }

    /// The table sizes a trained bot plays, as its note says them: "Two seats only." or "2 to 6 seats."
    public static func seatsNote(_ seats: [Int]) -> String {
        if seats.count == 1 { return seats[0] == 2 ? "Two seats only." : "\(seats[0]) seats only." }
        let run = seats.indices.allSatisfy { $0 == 0 || seats[$0] == seats[$0 - 1] + 1 }
        let sizes = run
            ? "\(seats.first.map(String.init) ?? "") to \(seats.last.map(String.init) ?? "")"
            : seats.map(String.init).joined(separator: ", ")
        return "\(sizes) seats."
    }

    public static func botLabel(_ kind: String?) -> String {
        guard let kind, !kind.isEmpty else { return "Bot" }
        return botLabels[kind] ?? kind.replacingOccurrences(of: "_", with: " ")
    }

    /// A bot's name for a phone's pod, which has room for about eight letters: the part
    /// that tells it from the others. "RiverMind Easy 4" is "Easy 4" there and "Calling
    /// bot 2" is "Calling 2", under the "Bot" tag every bot wears (D-7). Each part says
    /// whether a pod shows it; together they are the whole name. The `house` part is the
    /// site's own name, which no seat has room for.
    ///
    /// The page matches `/^(RiverMind )?(.+?)( bot)?( \d+)?$/`; this walks the same
    /// choices in the same order, over code points.
    public static func podName(_ name: String) -> [NamePart] {
        let scalars = Array(name.unicodeScalars)
        let prefix = Array("RiverMind ".unicodeScalars)
        var split: (house: String, core: String, bot: String, number: String)?
        if scalars.starts(with: prefix), let rest = matchRest(Array(scalars.dropFirst(prefix.count))) {
            split = ("RiverMind ", rest.core, rest.bot, rest.number)
        } else if let rest = matchRest(scalars) {
            split = ("", rest.core, rest.bot, rest.number)
        }
        guard let split else { return [NamePart(text: name, pod: true)] }
        return [
            NamePart(text: split.house, pod: false, house: true),
            NamePart(text: split.core, pod: true),
            NamePart(text: split.bot, pod: false),
            NamePart(text: split.number, pod: true),
        ].filter { !$0.text.isEmpty }
    }

    /// `(.+?)( bot)?( \d+)?$`: the shortest core whose rest is a " bot" and a number, either or none.
    private static func matchRest(_ scalars: [Unicode.Scalar]) -> (core: String, bot: String, number: String)? {
        func text(_ part: ArraySlice<Unicode.Scalar>) -> String {
            var string = String.UnicodeScalarView()
            string.append(contentsOf: part)
            return String(string)
        }
        // JavaScript's `.` stops at line ends.
        let lineEnds: Set<Unicode.Scalar> = ["\n", "\r", "\u{2028}", "\u{2029}"]
        guard !scalars.isEmpty else { return nil }
        for k in 1...scalars.count {
            if lineEnds.contains(scalars[k - 1]) { return nil }
            var rest = scalars[k...]
            var bot = ""
            if rest.starts(with: " bot".unicodeScalars) {
                bot = " bot"
                rest = rest.dropFirst(4)
            }
            if rest.isEmpty { return (text(scalars[..<k]), bot, "") }
            if rest.first == " ", rest.count > 1, rest.dropFirst().allSatisfy({ ("0"..."9").contains($0) }) {
                return (text(scalars[..<k]), bot, text(rest))
            }
        }
        return nil
    }

    /// A stable pick from the six people for a name, so a player keeps a face.
    public static func personAvatar(_ name: String) -> Int {
        var hash: UInt32 = 0
        for scalar in name.unicodeScalars { hash = hash &* 31 &+ scalar.value }
        return Int(hash % UInt32(personAvatars))
    }

    /// The avatar's name in the site's sprites: a bot's kind, or one of the six people.
    public static func avatar(kind: SeatKind, bot: String?, name: String) -> String {
        if kind == .bot { return botAvatars[bot ?? ""] ?? "avatar-bot" }
        return "avatar-person-\(personAvatar(name))"
    }

    public static func avatar(_ seat: SeatInfo) -> String {
        avatar(kind: seat.kind, bot: seat.bot, name: seat.name)
    }

    /// A chip colour for a bet, by its size in big blinds.
    public static func chip(_ amount: Int, bigBlind: Int) -> String {
        let blinds = Double(amount) / Double(max(1, bigBlind))
        if blinds < 1 { return "chip-white" }
        if blinds < 3 { return "chip-red" }
        if blinds < 10 { return "chip-blue" }
        if blinds < 25 { return "chip-green" }
        if blinds < 60 { return "chip-black" }
        return "chip-violet"
    }

    /// The word under a seat's name for how it stands in the hand, or "" for none.
    public static func status(_ info: SeatInfo) -> String {
        if info.leaving { return "Leaving" }
        if info.sittingOut { return "Sitting out" }
        if info.folded { return "Folded" }
        if info.allIn { return "All-in" }
        if !info.connected && info.kind == .human { return "Away" }
        return ""
    }

    /// A seat's name for VoiceOver: "Your seat: Ann", "Seat 3: Easy 2 (bot)".
    public static func label(_ info: SeatInfo, me: Bool) -> String {
        "\(me ? "Your seat" : "Seat \(info.seat + 1)"): \(info.name)\(info.kind == .bot ? " (bot)" : "")"
    }

    /// `Number.prototype.toFixed` for a value from 0 up to 1e21: the nearest number of
    /// `digits` decimals to the value's exact binary value, the larger on a tie.
    static func toFixed(_ value: Double, _ digits: Int) -> String {
        guard value.isFinite else { return value.isNaN ? "NaN" : value < 0 ? "-Infinity" : "Infinity" }
        let negative = value < 0
        // Sixty places hold every double in a win rate's range exactly enough that only a
        // true tie ends in a 5 followed by zeros.
        let exact = String(format: "%.60f", abs(value))
        let point = exact.firstIndex(of: ".")!
        var whole = Array(exact[..<point])
        var fraction = Array(exact[exact.index(after: point)...])
        let next = fraction[digits]
        fraction = Array(fraction.prefix(digits))
        if next >= "5" {
            var number = whole + fraction
            var i = number.count - 1
            while i >= 0 {
                if number[i] == "9" {
                    number[i] = "0"
                    i -= 1
                } else {
                    number[i] = Character(String(number[i].wholeNumberValue! + 1))
                    break
                }
            }
            if i < 0 { number.insert("1", at: 0) }
            whole = Array(number.prefix(number.count - digits))
            fraction = Array(number.suffix(digits))
        }
        let text = String(whole) + (digits > 0 ? "." + String(fraction) : "")
        let zero = (whole + fraction).allSatisfy { $0 == "0" }
        return negative && !zero ? "-" + text : text
    }
}
