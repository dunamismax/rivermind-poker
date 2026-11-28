import Foundation
import SwiftUI

// The pieces the generated tokens (Tokens.swift) and art (ArtLibrary.swift) are made of
// (P5D.5). `pnpm art` writes those two files from the site's theme.css, kit.css and art
// generators; this file says what their values mean and how SwiftUI draws them.

/// An sRGB colour, as the site's palette writes it (`#rrggbb`).
public struct RGB: Sendable, Hashable, CustomStringConvertible {
    public let red: UInt8
    public let green: UInt8
    public let blue: UInt8

    public init(_ hex: UInt32) {
        red = UInt8((hex >> 16) & 0xff)
        green = UInt8((hex >> 8) & 0xff)
        blue = UInt8(hex & 0xff)
    }

    public var description: String { String(format: "#%02x%02x%02x", red, green, blue) }

    public var color: Color {
        Color(.sRGB, red: Double(red) / 255, green: Double(green) / 255, blue: Double(blue) / 255)
    }

    /// WCAG 2.2's relative luminance, as theme.spec.ts computes it.
    public var luminance: Double {
        func channel(_ value: UInt8) -> Double {
            let c = Double(value) / 255
            return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    }

    /// The contrast ratio of two colours, 1 to 21.
    public func contrast(with other: RGB) -> Double {
        let (a, b) = (luminance, other.luminance)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }
}

/// A colour with its opacity: what CSS writes as `rgb(255 255 255 / 0.07)`.
public struct Paint: Sendable, Hashable {
    public let rgb: RGB
    public let opacity: Double

    public init(_ rgb: RGB, opacity: Double = 1) {
        self.rgb = rgb
        self.opacity = opacity
    }

    public var color: Color { opacity == 1 ? rgb.color : rgb.color.opacity(opacity) }
}

/// A CSS box shadow with no spread, `0 <y>px <blur>px <colour>`.
public struct Shadow: Sendable, Hashable {
    public let y: Double
    public let blur: Double
    public let paint: Paint

    /// SwiftUI's radius is a Gaussian's standard deviation; a CSS blur is twice that.
    public var radius: Double { blur / 2 }
}

/// A CSS `cubic-bezier`.
public struct Curve: Sendable, Hashable {
    public let x1, y1, x2, y2: Double

    public init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
        (self.x1, self.y1, self.x2, self.y2) = (x1, y1, x2, y2)
    }
}

/// One of the site's animations: its length in seconds, its curve and whether it loops.
public struct KitAnimation: Sendable, Hashable {
    public let duration: Double
    public let curve: Curve
    public let repeats: Bool

    /// As SwiftUI animates it. A looping one goes there and back, as the site's
    /// keyframes do (they peak at 50%), so each leg takes half the time.
    public var animation: Animation {
        let leg = Animation.timingCurve(
            curve.x1, curve.y1, curve.x2, curve.y2, duration: repeats ? duration / 2 : duration)
        return repeats ? leg.repeatForever(autoreverses: true) : leg
    }
}

/// A button's colours (kit.css `--btn-bg`, `--btn-down`, `--btn-fg`, `--btn-edge`).
public struct ButtonColours: Sendable, Hashable {
    public let face: Paint
    public let down: Paint
    public let label: Paint
    public let edge: Paint
}

/// A ring just outside a frame: CSS's `0 0 0 <width>px <colour>`.
public struct Ring: Sendable, Hashable {
    public let width: Double
    public let paint: Paint
}

/// A frame's colours: its surface, its rings (innermost first), its drop shadow, and
/// the shadow inside an inset well.
public struct FrameColours: Sendable, Hashable {
    public let surface: Paint
    public let rings: [Ring]
    public let shadow: Shadow?
    public let inner: Shadow?
}

// MARK: - Art

/// A drawing on its own box, in the site's CSS pixels: a card, a chip, the mark.
public struct Art: Sendable {
    public let width: Double
    public let height: Double
    public let shapes: [ArtShape]
}

/// One shape of a drawing, painted as SVG paints it.
public struct ArtShape: Sendable {
    public enum Geometry: Sendable {
        /// SVG path data.
        case path(String)
        /// x, y, width, height and corner radius.
        case rect(Double, Double, Double, Double, Double)
        case circle(Double, Double, Double)
        case ellipse(Double, Double, Double, Double)
    }

    public let geometry: Geometry
    /// The affine map `[a, b, c, d, e, f]` from the shape's space to the drawing's.
    public let transform: [Double]
    public let fill: Paint?
    public let stroke: Pen?

    public init(_ geometry: Geometry, transform: [Double] = [1, 0, 0, 1, 0, 0], fill: Paint?, stroke: Pen? = nil) {
        self.geometry = geometry
        self.transform = transform
        self.fill = fill
        self.stroke = stroke
    }

    public var affine: CGAffineTransform {
        CGAffineTransform(
            a: transform[0], b: transform[1], c: transform[2], d: transform[3], tx: transform[4], ty: transform[5])
    }

    /// The shape's outline in its own space, starting where SVG starts it and going the
    /// way SVG goes (SVG 2's equivalent paths), so a dashed stroke falls where the site's does.
    public var path: Path {
        switch geometry {
        case let .path(data):
            return (try? SVGPath.parse(data)) ?? Path()
        case let .rect(x, y, width, height, r):
            if r <= 0 {
                return (try? SVGPath.parse("M\(x) \(y)H\(x + width)V\(y + height)H\(x)Z")) ?? Path()
            }
            let r = min(r, width / 2, height / 2)
            return (try? SVGPath.parse(
                "M\(x + r) \(y)H\(x + width - r)A\(r) \(r) 0 0 1 \(x + width) \(y + r)"
                    + "V\(y + height - r)A\(r) \(r) 0 0 1 \(x + width - r) \(y + height)"
                    + "H\(x + r)A\(r) \(r) 0 0 1 \(x) \(y + height - r)"
                    + "V\(y + r)A\(r) \(r) 0 0 1 \(x + r) \(y)Z")) ?? Path()
        case let .circle(cx, cy, r):
            return Self.ellipse(cx, cy, r, r)
        case let .ellipse(cx, cy, rx, ry):
            return Self.ellipse(cx, cy, rx, ry)
        }
    }

    /// From the rightmost point, the way of increasing angle (clockwise on the screen).
    static func ellipse(_ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double) -> Path {
        (try? SVGPath.parse(
            "M\(cx + rx) \(cy)A\(rx) \(ry) 0 0 1 \(cx) \(cy + ry)A\(rx) \(ry) 0 0 1 \(cx - rx) \(cy)"
                + "A\(rx) \(ry) 0 0 1 \(cx) \(cy - ry)A\(rx) \(ry) 0 0 1 \(cx + rx) \(cy)Z")) ?? Path()
    }
}

/// How a shape's outline is stroked.
public struct Pen: Sendable {
    public enum Cap: Sendable { case butt, round, square }
    public enum Join: Sendable { case miter, round, bevel }

    public let paint: Paint
    public let width: Double
    public let cap: Cap
    public let join: Join
    public let dash: [Double]

    public init(_ paint: Paint, width: Double, cap: Cap, join: Join, dash: [Double] = []) {
        self.paint = paint
        self.width = width
        self.cap = cap
        self.join = join
        self.dash = dash
    }

    public var style: StrokeStyle {
        let lineCap: CGLineCap =
            switch cap {
            case .butt: .butt
            case .round: .round
            case .square: .square
            }
        let lineJoin: CGLineJoin =
            switch join {
            case .miter: .miter
            case .round: .round
            case .bevel: .bevel
            }
        // An odd dash list is repeated, as SVG does; SVG's default miter limit is 4.
        let lengths = (dash.count % 2 == 1 ? dash + dash : dash).map { CGFloat($0) }
        return StrokeStyle(lineWidth: width, lineCap: lineCap, lineJoin: lineJoin, miterLimit: 4, dash: lengths)
    }
}
