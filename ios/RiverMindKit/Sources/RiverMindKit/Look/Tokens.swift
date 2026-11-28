// Written by `pnpm art` (web/scripts/art/swift.js) from the site’s own sources.
// Never edit it by hand: change the source, run `pnpm art`, and commit both.

// The tokens: web/src/styles/theme.css and kit.css.

import Foundation

/// The palette (theme.css), by the site’s names.
public enum Palette {
    public static let ink = RGB(0x0a0c11)
    public static let night = RGB(0x11141b)
    public static let deepSlate = RGB(0x181c25)
    public static let slate = RGB(0x232935)
    public static let dusk = RGB(0x687186)
    public static let haze = RGB(0xa1a9ba)
    public static let mist = RGB(0xb3bbca)
    public static let feltDeep = RGB(0x0d2721)
    public static let feltDark = RGB(0x12352d)
    public static let felt = RGB(0x174237)
    public static let feltLight = RGB(0x1f5646)
    public static let feltGlow = RGB(0x2b6e59)
    public static let woodDeep = RGB(0x0e0f13)
    public static let woodDark = RGB(0x1a1c22)
    public static let wood = RGB(0x262931)
    public static let woodLight = RGB(0x353943)
    public static let brass = RGB(0xa88d5c)
    public static let paperDeep = RGB(0x9aa2b1)
    public static let paperShade = RGB(0xcdd3de)
    public static let paper = RGB(0xeceff4)
    public static let white = RGB(0xffffff)
    public static let redDeep = RGB(0x35161a)
    public static let redDark = RGB(0xbd3a44)
    public static let red = RGB(0xd9474f)
    public static let redLight = RGB(0xff8f86)
    public static let blueDeep = RGB(0x12213f)
    public static let blueDark = RGB(0x2d67cc)
    public static let blue = RGB(0x3b7be0)
    public static let blueLight = RGB(0x8fbcff)
    public static let greenDeep = RGB(0x0f2d1f)
    public static let greenDark = RGB(0x1f7a4c)
    public static let green = RGB(0x2fa065)
    public static let greenLight = RGB(0x7fd9a2)
    public static let amberDeep = RGB(0x3e2710)
    public static let amberDark = RGB(0xa8601f)
    public static let amber = RGB(0xe8923a)
    public static let gold = RGB(0xf0bd4f)
    public static let goldLight = RGB(0xffdc8a)
    public static let violetDeep = RGB(0x211b3d)
    public static let violet = RGB(0x4b3c96)
    public static let violetLight = RGB(0xb0a1f5)
    public static let skinDeep = RGB(0x6b3d2f)
    public static let skin = RGB(0xb47657)
    public static let skinLight = RGB(0xe8b896)
    public static let warn = RGB(0xe8923a)
    public static let card = RGB(0xfffdf7)
    public static let cardEdge = RGB(0xbdb7a6)
    public static let cardBackBurgundy = RGB(0x7a2f3a)
    public static let cardBackNavy = RGB(0x243a63)
    public static let cardBackGreen = RGB(0x1f5240)
    public static let cardBackMark = RGB(0xe8c9a0)
    public static let suitClubs = RGB(0x19703a)
    public static let suitDiamonds = RGB(0x1a58ad)
    public static let suitHearts = RGB(0xb4231b)
    public static let suitSpades = RGB(0x1a1d22)

    /// Every colour, by the site’s name, in theme.css’s order.
    public static let all: [(name: String, rgb: RGB)] = [
        ("ink", ink),
        ("night", night),
        ("deep-slate", deepSlate),
        ("slate", slate),
        ("dusk", dusk),
        ("haze", haze),
        ("mist", mist),
        ("felt-deep", feltDeep),
        ("felt-dark", feltDark),
        ("felt", felt),
        ("felt-light", feltLight),
        ("felt-glow", feltGlow),
        ("wood-deep", woodDeep),
        ("wood-dark", woodDark),
        ("wood", wood),
        ("wood-light", woodLight),
        ("brass", brass),
        ("paper-deep", paperDeep),
        ("paper-shade", paperShade),
        ("paper", paper),
        ("white", white),
        ("red-deep", redDeep),
        ("red-dark", redDark),
        ("red", red),
        ("red-light", redLight),
        ("blue-deep", blueDeep),
        ("blue-dark", blueDark),
        ("blue", blue),
        ("blue-light", blueLight),
        ("green-deep", greenDeep),
        ("green-dark", greenDark),
        ("green", green),
        ("green-light", greenLight),
        ("amber-deep", amberDeep),
        ("amber-dark", amberDark),
        ("amber", amber),
        ("gold", gold),
        ("gold-light", goldLight),
        ("violet-deep", violetDeep),
        ("violet", violet),
        ("violet-light", violetLight),
        ("skin-deep", skinDeep),
        ("skin", skin),
        ("skin-light", skinLight),
        ("warn", warn),
        ("card", card),
        ("card-edge", cardEdge),
        ("card-back-burgundy", cardBackBurgundy),
        ("card-back-navy", cardBackNavy),
        ("card-back-green", cardBackGreen),
        ("card-back-mark", cardBackMark),
        ("suit-clubs", suitClubs),
        ("suit-diamonds", suitDiamonds),
        ("suit-hearts", suitHearts),
        ("suit-spades", suitSpades),
    ]
}

/// The pairs theme.spec.ts measures (src/styles/contrast.js): text on the surfaces the
/// pages use and on colours of its own (4.5:1), and controls on what they sit on (3:1).
public enum ContrastPairs {
    public static let surfaces = ["night", "ink", "deep-slate", "slate", "felt-dark", "felt"]
    public static let text = ["paper", "paper-shade", "mist", "haze", "gold", "gold-light", "green-light", "red-light", "violet-light", "blue-light", "amber", "warn"]
    public static let labels: [(String, String)] = [
        ("paper", "slate"),
        ("white", "red-dark"),
        ("white", "blue-dark"),
        ("white", "green-dark"),
        ("ink", "amber"),
        ("ink", "gold"),
        ("ink", "paper"),
        ("amber-deep", "gold"),
        ("violet-light", "ink"),
        ("suit-clubs", "card"),
        ("suit-diamonds", "card"),
        ("suit-hearts", "card"),
        ("suit-spades", "card"),
    ]
    public static let controls: [(String, String)] = [
        ("dusk", "night"),
        ("dusk", "deep-slate"),
        ("dusk", "ink"),
        ("red-dark", "night"),
        ("blue-dark", "night"),
        ("green-dark", "night"),
        ("amber", "night"),
        ("gold", "night"),
        ("gold", "ink"),
        ("gold", "deep-slate"),
        ("gold", "slate"),
        ("gold", "felt"),
        ("gold-light", "deep-slate"),
        ("red", "red-deep"),
    ]
}

/// Sizes in points, which are the site’s CSS pixels.
public enum Metrics {
    /// The spacing step: the kit’s sizes count in it.
    public static let step: Double = 2
    public static let textXS: Double = 11
    public static let textS: Double = 13
    public static let textM: Double = 16
    public static let textL: Double = 22
    public static let textXL: Double = 28
    public static let radiusS: Double = 6
    public static let radiusM: Double = 10
    public static let radiusL: Double = 16
}

/// The soft shadows: under panels and buttons, and under text on art.
public enum Shadows {
    public static let elevation1 = Shadow(y: 1, blur: 2, paint: Paint(RGB(0x000000), opacity: 0.35))
    public static let elevation2 = Shadow(y: 4, blur: 14, paint: Paint(RGB(0x000000), opacity: 0.35))
    public static let elevation3 = Shadow(y: 14, blur: 36, paint: Paint(RGB(0x000000), opacity: 0.45))
    public static let textInk = Shadow(y: 1, blur: 2, paint: Paint(RGB(0x000000), opacity: 0.45))
    public static let textTitle = Shadow(y: 1, blur: 3, paint: Paint(RGB(0x000000), opacity: 0.5))
    /// A faint edge round a frame.
    public static let edge = Paint(Palette.white, opacity: 0.07)
}

/// Motion: each of the site’s animations, its length and its curve.
public enum Motion {
    public static let easeOut = Curve(0.2, 0.7, 0.2, 1)
    public static let easeInOut = Curve(0.45, 0, 0.55, 1)
    /// `--animate-blink` (keyframes `blink`).
    public static let blink = KitAnimation(duration: 1.2, curve: easeInOut, repeats: true)
    /// `--animate-wait` (keyframes `wait`).
    public static let wait = KitAnimation(duration: 1.4, curve: easeInOut, repeats: true)
    /// `--animate-drop` (keyframes `drop`).
    public static let drop = KitAnimation(duration: 0.24, curve: easeOut, repeats: false)
    /// `--animate-slide` (keyframes `slide`).
    public static let slide = KitAnimation(duration: 0.18, curve: easeOut, repeats: false)
    /// `--animate-pop` (keyframes `pop`).
    public static let pop = KitAnimation(duration: 0.2, curve: easeOut, repeats: false)
    /// `--animate-fade` (keyframes `fade`).
    public static let fade = KitAnimation(duration: 0.24, curve: easeOut, repeats: false)
    /// `--animate-rise` (keyframes `rise`).
    public static let rise = KitAnimation(duration: 0.6, curve: easeOut, repeats: false)
    /// `--animate-nudge` (keyframes `turn`).
    public static let nudge = KitAnimation(duration: 1.6, curve: easeInOut, repeats: true)
    /// `--animate-speak` (keyframes `speak`).
    public static let speak = KitAnimation(duration: 1, curve: easeInOut, repeats: true)
}

/// The kit’s buttons (kit.css `.ui-btn`): face, face when pressed, label and edge.
public enum ButtonPalette {
    public static let slate = ButtonColours(face: Paint(Palette.slate), down: Paint(RGB(0x1b2029)), label: Paint(Palette.paper), edge: Paint(Palette.dusk))
    public static let red = ButtonColours(face: Paint(Palette.redDark), down: Paint(RGB(0x9c2f38)), label: Paint(Palette.white), edge: Paint(Palette.white, opacity: 0.14))
    public static let blue = ButtonColours(face: Paint(Palette.blueDark), down: Paint(RGB(0x2556ab)), label: Paint(Palette.white), edge: Paint(Palette.white, opacity: 0.14))
    public static let amber = ButtonColours(face: Paint(Palette.amber), down: Paint(RGB(0xc9772a)), label: Paint(Palette.ink), edge: Paint(Palette.white, opacity: 0.18))
    public static let green = ButtonColours(face: Paint(Palette.greenDark), down: Paint(RGB(0x18633d)), label: Paint(Palette.white), edge: Paint(Palette.white, opacity: 0.14))
    public static let gold = ButtonColours(face: Paint(Palette.gold), down: Paint(RGB(0xd6a53f)), label: Paint(Palette.ink), edge: Paint(Palette.white, opacity: 0.2))
    public static let disabled = ButtonColours(face: Paint(Palette.deepSlate), down: Paint(Palette.deepSlate), label: Paint(Palette.haze), edge: Paint(Palette.white, opacity: 0.08))
    /// A choice that is the one chosen.
    public static let chosen = ButtonColours(face: Paint(Palette.gold), down: Paint(Palette.gold), label: Paint(Palette.ink), edge: Paint(Palette.white, opacity: 0.2))
    public static let height: Double = 48
    public static let smallHeight: Double = 40
}

/// The kit’s frames (kit.css `.ui-panel` and its kin): surface, rings and shadow.
public enum FramePalette {
    public static let panel = FrameColours(surface: Paint(Palette.deepSlate), rings: [Ring(width: 1, paint: Paint(Palette.white, opacity: 0.07))], shadow: Shadows.elevation2, inner: nil)
    public static let raised = FrameColours(surface: Paint(Palette.slate), rings: [Ring(width: 1, paint: Paint(Palette.white, opacity: 0.09))], shadow: Shadows.elevation1, inner: nil)
    public static let inset = FrameColours(surface: Paint(Palette.ink), rings: [Ring(width: 1, paint: Paint(Palette.white, opacity: 0.07))], shadow: nil, inner: Shadow(y: 1, blur: 3, paint: Paint(RGB(0x000000), opacity: 0.5)))
    public static let paper = FrameColours(surface: Paint(Palette.paper), rings: [], shadow: Shadows.elevation2, inner: nil)
    public static let gold = FrameColours(surface: Paint(Palette.deepSlate), rings: [Ring(width: 2, paint: Paint(Palette.gold))], shadow: Shadows.elevation2, inner: nil)
    public static let glow = FrameColours(surface: Paint(Palette.deepSlate), rings: [Ring(width: 2, paint: Paint(Palette.goldLight)), Ring(width: 6, paint: Paint(Palette.gold, opacity: 0.22))], shadow: Shadows.elevation2, inner: nil)
    public static let danger = FrameColours(surface: Paint(Palette.redDeep), rings: [Ring(width: 2, paint: Paint(Palette.red))], shadow: Shadows.elevation2, inner: nil)
}
