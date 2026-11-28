// Where seats and their bets sit around the table, and how much of a turn's time
// is left: a port of web/src/lib/nl/layout.ts, held to it by `pnpm ios:fixtures`
// (DisplayParityTests.swift). The viewer's seat is always at the bottom centre
// and the others follow clockwise in seat order. A change to either side lands
// in both in the same commit.

import Foundation

public enum TableLayout {
    /// The two maps: the tall one for phones and tablets held upright, the wide oval otherwise.
    public enum Shape: String, Sendable, Hashable, Decodable {
        case wide, tall
    }

    /// A place in percent of the table's width and height.
    public struct Spot: Sendable, Hashable, Decodable {
        public var left: Double
        public var top: Double

        public init(left: Double, top: Double) {
            self.left = left
            self.top = top
        }
    }

    /// Which way a place faces the middle.
    public enum Side: String, Sendable, Hashable, Decodable {
        case bottom, top, left, right
        case lowLeft = "low-left"
        case lowRight = "low-right"
    }

    /// A length the page writes as a CSS variable, which the screen gives a size of its own.
    public enum Length: Sendable, Hashable {
        /// Under a pod in the top row (`--pod-drop`).
        case podDrop
        /// Above a pod on a bottom corner (`--pod-lift`).
        case podLift
        /// Under a wide seat on the top rail (`--seat-drop`).
        case seatDrop
        /// Level with a wide seat's tags (`--tag-level`).
        case tagLevel
        /// Beside a wide seat's tags (`--tag-side`).
        case tagSide
        /// Under the board's row (`--board-below`).
        case boardBelow
        /// Over the board's row (`--board-above`, negative).
        case boardAbove
        /// A number of points.
        case points(Int)

        /// What the page writes: `var(--pod-drop)`, `calc(-1 * var(--board-above))`, `12px`.
        public var css: String {
            switch self {
            case .podDrop: "var(--pod-drop)"
            case .podLift: "var(--pod-lift)"
            case .seatDrop: "var(--seat-drop)"
            case .tagLevel: "var(--tag-level)"
            case .tagSide: "var(--tag-side)"
            case .boardBelow: "var(--board-below)"
            case .boardAbove: "calc(-1 * var(--board-above))"
            case let .points(value): "\(value)px"
            }
        }
    }

    /// Where a place's bet sits: a spot, moved down by `shift` and across by `aside`, and
    /// kept `beside` its seat on the wide table.
    public struct BetSpot: Sendable, Hashable {
        public var left: Double
        public var top: Double
        public var shift: Length?
        public var aside: Length?
        public var beside: Side?
    }

    /// The place of `seat` around a table of `count`, 0 being the bottom centre.
    public static func placeOf(_ seat: Int, anchor: Int?, count: Int) -> Int {
        let from = anchor ?? 0
        return ((seat - from) % count + count) % count
    }

    static let wide: [Int: [(Double, Double)]] = [
        2: [(50, 100), (50, 0)],
        3: [(50, 100), (8, 22), (92, 22)],
        4: [(50, 100), (2, 50), (50, 0), (98, 50)],
        5: [(50, 100), (4, 66), (24, 2), (76, 2), (96, 66)],
        6: [(50, 100), (6, 78), (6, 22), (50, 0), (94, 22), (94, 78)],
        7: [(50, 100), (10, 88), (1, 38), (30, 0), (70, 0), (99, 38), (90, 88)],
        8: [(50, 100), (16, 96), (1, 50), (18, 4), (50, 0), (82, 4), (99, 50), (84, 96)],
        9: [(50, 100), (20, 98), (1, 56), (8, 12), (36, 0), (64, 0), (92, 12), (99, 56), (80, 98)],
    ]

    static let tall: [Int: [(Double, Double)]] = [
        2: [(50, 100), (50, 10)],
        3: [(50, 100), (12.5, 13), (87.5, 13)],
        4: [(50, 100), (12.5, 13), (50, 10), (87.5, 13)],
        5: [(50, 100), (12.5, 77), (12.5, 13), (87.5, 13), (87.5, 77)],
        6: [(50, 100), (12.5, 77), (12.5, 13), (50, 10), (87.5, 13), (87.5, 77)],
        7: [(50, 100), (12.5, 77), (12.5, 13), (37.5, 10), (62.5, 10), (87.5, 13), (87.5, 77)],
        8: [(50, 100), (12.5, 100), (12.5, 77), (12.5, 13), (50, 10), (87.5, 13), (87.5, 77), (87.5, 100)],
        9: [
            (50, 100), (12.5, 100), (12.5, 77), (12.5, 13), (37.5, 10), (62.5, 10), (87.5, 13), (87.5, 77),
            (87.5, 100),
        ],
    ]

    /// Each place clockwise from the bottom centre, for 2 to 9 seats; an empty list for any other count.
    public static func places(_ count: Int, _ shape: Shape = .wide) -> [Spot] {
        ((shape == .wide ? wide : tall)[count] ?? []).map { Spot(left: $0.0, top: $0.1) }
    }

    public static func sideOf(_ spot: Spot, place: Int) -> Side {
        if place == 0 { return .bottom }
        if spot.top < 40 { return .top }
        let left = spot.left < 50
        if spot.top > 90 { return left ? .lowLeft : .lowRight }
        return left ? .left : .right
    }

    static let boardLine = 48.0
    static let boardBand = (35.0, 70.0)
    static let topRail = 12.0

    /// JavaScript's `Math.round(v * 10) / 10`, which rounds a half up.
    static func round1(_ value: Double) -> Double { (value * 10 + 0.5).rounded(.down) / 10 }

    public static func betSpot(_ spot: Spot, place: Int, shape: Shape) -> BetSpot {
        if shape == .tall {
            let side = sideOf(spot, place: place)
            switch side {
            case .bottom: return BetSpot(left: 50, top: 77)
            case .top: return BetSpot(left: spot.left, top: spot.top, shift: .podDrop)
            case .left, .right:
                return BetSpot(left: round1(spot.left + (side == .left ? 21.5 : -21.5)), top: spot.top - 5)
            case .lowLeft, .lowRight:
                let inward = side == .lowLeft ? 5.0 : -5.0
                return BetSpot(left: spot.left + inward, top: spot.top, shift: .podLift)
            }
        }
        let toward = place == 0 ? 0.52 : 0.36
        let left = round1(spot.left + (50 - spot.left) * toward)
        if place != 0 && spot.top <= topRail {
            if spot.left == 50 {
                return BetSpot(left: spot.left, top: spot.top, shift: .tagLevel, aside: .tagSide)
            }
            let out = abs(spot.left - 50) <= 20 ? 12 : -10
            return BetSpot(left: spot.left, top: spot.top, shift: .seatDrop, aside: .points(spot.left < 50 ? -out : out))
        }
        let top = round1(spot.top + (boardLine - spot.top) * toward)
        if place == 0 { return BetSpot(left: left, top: top) }
        let beside: Side = spot.left < 50 ? .right : .left
        if spot.top >= boardBand.0 && spot.top <= boardBand.1 {
            return BetSpot(
                left: left, top: boardLine, shift: spot.top >= boardLine ? .boardBelow : .boardAbove, beside: beside)
        }
        return BetSpot(left: left, top: top, beside: beside)
    }

    /// How much of the turn's time is left, from 1 (all) to 0 (none), whether the bank is
    /// running, and the whole seconds left, rounded up.
    public struct ClockLeft: Sendable, Hashable, Decodable {
        public var fraction: Double
        public var bank: Bool
        public var seconds: Int
    }

    public static func clockLeft(_ turn: Turn, now: Double) -> ClockLeft {
        clockLeft(started: turn.started, deadline: turn.deadline, final: turn.final, now: now)
    }

    public static func clockLeft(started: Double, deadline: Double, final: Double, now: Double) -> ClockLeft {
        if now < deadline {
            let span = deadline - started
            return ClockLeft(
                fraction: span > 0 ? max(0, (deadline - now) / span) : 0, bank: false,
                seconds: Int((deadline - now).rounded(.up)))
        }
        let span = final - deadline
        let left = max(0, final - now)
        return ClockLeft(fraction: span > 0 ? left / span : 0, bank: span > 0, seconds: Int(left.rounded(.up)))
    }
}
