import Foundation
import SwiftUI

/// SVG path data as a SwiftUI path (P5D.5): the commands the site's art uses and the rest
/// of SVG 1.1's, absolute and relative, with elliptical arcs turned into cubic curves as
/// the SVG specification's appendix F.6 says.
public enum SVGPath {
    public struct ParseError: Error, CustomStringConvertible {
        public let description: String
    }

    public static func parse(_ data: String) throws -> Path {
        var reader = Reader(Array(data.utf8))
        var path = Path()
        var current = CGPoint.zero
        var start = CGPoint.zero
        var command: UInt8 = 0
        // The last control point, for S and T.
        var lastCubic: CGPoint?
        var lastQuad: CGPoint?

        while true {
            reader.skipSeparators()
            guard let next = reader.peek() else { break }
            if Reader.isCommand(next) {
                // SVG: a path starts with a moveto.
                if path.isEmpty && next != UInt8(ascii: "M") && next != UInt8(ascii: "m") {
                    throw ParseError(description: "path data must start with a moveto")
                }
                command = next
                reader.advance()
            } else if command == 0 {
                throw ParseError(description: "path data must start with a command")
            }
            // After a moveto, further pairs are linetos.
            let relative = command >= UInt8(ascii: "a")
            let upper = relative ? command - 32 : command
            func point(_ x: Double, _ y: Double) -> CGPoint {
                relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
            }
            switch upper {
            case UInt8(ascii: "M"):
                let p = point(try reader.number(), try reader.number())
                path.move(to: p)
                current = p
                start = p
                command = relative ? UInt8(ascii: "l") : UInt8(ascii: "L")
                lastCubic = nil
                lastQuad = nil
            case UInt8(ascii: "L"):
                let p = point(try reader.number(), try reader.number())
                path.addLine(to: p)
                current = p
                lastCubic = nil
                lastQuad = nil
            case UInt8(ascii: "H"):
                let x = try reader.number()
                let p = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: p)
                current = p
                lastCubic = nil
                lastQuad = nil
            case UInt8(ascii: "V"):
                let y = try reader.number()
                let p = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: p)
                current = p
                lastCubic = nil
                lastQuad = nil
            case UInt8(ascii: "C"):
                let c1 = point(try reader.number(), try reader.number())
                let c2 = point(try reader.number(), try reader.number())
                let p = point(try reader.number(), try reader.number())
                path.addCurve(to: p, control1: c1, control2: c2)
                current = p
                lastCubic = c2
                lastQuad = nil
            case UInt8(ascii: "S"):
                let c1 = lastCubic.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let c2 = point(try reader.number(), try reader.number())
                let p = point(try reader.number(), try reader.number())
                path.addCurve(to: p, control1: c1, control2: c2)
                current = p
                lastCubic = c2
                lastQuad = nil
            case UInt8(ascii: "Q"):
                let c = point(try reader.number(), try reader.number())
                let p = point(try reader.number(), try reader.number())
                path.addQuadCurve(to: p, control: c)
                current = p
                lastQuad = c
                lastCubic = nil
            case UInt8(ascii: "T"):
                let c = lastQuad.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let p = point(try reader.number(), try reader.number())
                path.addQuadCurve(to: p, control: c)
                current = p
                lastQuad = c
                lastCubic = nil
            case UInt8(ascii: "A"):
                let rx = try reader.number()
                let ry = try reader.number()
                let rotation = try reader.number()
                let large = try reader.flag()
                let sweep = try reader.flag()
                let p = point(try reader.number(), try reader.number())
                arc(&path, from: current, to: p, rx: rx, ry: ry, rotation: rotation, large: large, sweep: sweep)
                current = p
                lastCubic = nil
                lastQuad = nil
            case UInt8(ascii: "Z"):
                path.closeSubpath()
                current = start
                lastCubic = nil
                lastQuad = nil
                // Z takes no numbers: a number after it is an error, not a repeat.
                command = 0
                reader.skipSeparators()
                if let next = reader.peek(), !Reader.isCommand(next) {
                    throw ParseError(description: "a number after Z")
                }
            default:
                throw ParseError(description: "unknown command \(Character(UnicodeScalar(command)))")
            }
        }
        return path
    }

    /// An elliptical arc as cubic curves, at most a quarter turn each (F.6.5 and F.6.6).
    static func arc(
        _ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx: Double, ry: Double, rotation: Double, large: Bool,
        sweep: Bool
    ) {
        if p0 == p1 { return }
        var rx = abs(rx)
        var ry = abs(ry)
        if rx == 0 || ry == 0 {
            path.addLine(to: p1)
            return
        }
        let phi = rotation * .pi / 180
        let (cosPhi, sinPhi) = (cos(phi), sin(phi))
        let dx = (p0.x - p1.x) / 2
        let dy = (p0.y - p1.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy
        let y1 = -sinPhi * dx + cosPhi * dy
        // Radii too small to reach are scaled up.
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            rx *= lambda.squareRoot()
            ry *= lambda.squareRoot()
        }
        let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var factor = (max(0, numerator) / denominator).squareRoot()
        if large == sweep { factor = -factor }
        let cx1 = factor * rx * y1 / ry
        let cy1 = -factor * ry * x1 / rx
        let cx = cosPhi * cx1 - sinPhi * cy1 + (p0.x + p1.x) / 2
        let cy = sinPhi * cx1 + cosPhi * cy1 + (p0.y + p1.y) / 2
        func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
            let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
            return a
        }
        let theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int((abs(delta) / (.pi / 2)).rounded(.up)))
        let step = delta / Double(segments)
        let k = 4.0 / 3.0 * tan(step / 4)
        func on(_ t: Double) -> (CGPoint, CGPoint) {
            // The point at angle t, and the derivative there.
            let (c, s) = (cos(t), sin(t))
            let p = CGPoint(x: cx + rx * c * cosPhi - ry * s * sinPhi, y: cy + rx * c * sinPhi + ry * s * cosPhi)
            let d = CGPoint(x: -rx * s * cosPhi - ry * c * sinPhi, y: -rx * s * sinPhi + ry * c * cosPhi)
            return (p, d)
        }
        var t = theta1
        for index in 0..<segments {
            let (a, da) = on(t)
            let (b, db) = on(t + step)
            let end = index == segments - 1 ? p1 : b
            path.addCurve(
                to: end,
                control1: CGPoint(x: a.x + k * da.x, y: a.y + k * da.y),
                control2: CGPoint(x: b.x - k * db.x, y: b.y - k * db.y))
            t += step
        }
    }

    struct Reader {
        let bytes: [UInt8]
        var at = 0

        init(_ bytes: [UInt8]) { self.bytes = bytes }

        func peek() -> UInt8? { at < bytes.count ? bytes[at] : nil }
        mutating func advance() { at += 1 }

        static func isCommand(_ byte: UInt8) -> Bool {
            "MmLlHhVvCcSsQqTtAaZz".utf8.contains(byte)
        }

        mutating func skipSeparators() {
            while let b = peek(), b == 0x20 || b == 0x2c || b == 0x09 || b == 0x0a || b == 0x0d { advance() }
        }

        /// A flag of an arc: a single 0 or 1, which may run into the next number.
        mutating func flag() throws -> Bool {
            skipSeparators()
            switch peek() {
            case UInt8(ascii: "0"):
                advance()
                return false
            case UInt8(ascii: "1"):
                advance()
                return true
            default: throw ParseError(description: "an arc flag must be 0 or 1")
            }
        }

        mutating func number() throws -> Double {
            skipSeparators()
            let begin = at
            if let b = peek(), b == UInt8(ascii: "-") || b == UInt8(ascii: "+") { advance() }
            var digits = false
            while let b = peek(), b >= 0x30 && b <= 0x39 {
                advance()
                digits = true
            }
            if peek() == UInt8(ascii: ".") {
                advance()
                while let b = peek(), b >= 0x30 && b <= 0x39 {
                    advance()
                    digits = true
                }
            }
            if digits, let b = peek(), b == UInt8(ascii: "e") || b == UInt8(ascii: "E") {
                advance()
                if let s = peek(), s == UInt8(ascii: "-") || s == UInt8(ascii: "+") { advance() }
                while let b = peek(), b >= 0x30 && b <= 0x39 { advance() }
            }
            guard digits, let text = String(bytes: bytes[begin..<at], encoding: .ascii), let value = Double(text)
            else { throw ParseError(description: "expected a number at \(begin)") }
            return value
        }
    }
}
