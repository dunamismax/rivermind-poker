import SwiftUI

// The site's kit (kit.css, docs/design.md) in SwiftUI (P5D.5): buttons, frames, fields
// and the table's felt, coloured by the tokens `pnpm art` writes (Tokens.swift). They
// live in the package, not the app, so the snapshot tests reach them.

extension Color {
    /// A palette colour as SwiftUI's.
    public static func kit(_ rgb: RGB) -> Color { rgb.color }
}

// MARK: - Buttons

/// The kit's button kinds (kit.css `.ui-btn` and `.red`, `.blue`, `.amber`, `.green`, `.gold`).
public enum ButtonKind: String, CaseIterable, Sendable {
    case slate, red, blue, amber, green, gold

    public var colours: ButtonColours {
        switch self {
        case .slate: ButtonPalette.slate
        case .red: ButtonPalette.red
        case .blue: ButtonPalette.blue
        case .amber: ButtonPalette.amber
        case .green: ButtonPalette.green
        case .gold: ButtonPalette.gold
        }
    }
}

/// A button's face, in any of its states, as kit.css draws it: the label centred, a
/// one-point edge, a soft shadow, and a darker face with a shadow inside when pressed.
/// Pressing never moves the label.
public struct KitButtonFace<Label: View>: View {
    public enum State: Sendable { case normal, pressed, disabled }

    let colours: ButtonColours
    let small: Bool
    let wide: Bool
    let state: State
    let label: Label

    /// `wide` fills the width the button is offered, as the turn's actions share a row.
    public init(
        kind: ButtonKind = .slate, chosen: Bool = false, small: Bool = false, wide: Bool = false,
        state: State = .normal, @ViewBuilder label: () -> Label
    ) {
        self.colours =
            state == .disabled ? ButtonPalette.disabled : chosen ? ButtonPalette.chosen : kind.colours
        self.small = small
        self.wide = wide
        self.state = state
        self.label = label()
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: Metrics.radiusS, style: .continuous)
        let pressed = state == .pressed
        label
            .font(.system(size: small ? Metrics.textS : Metrics.textM, weight: .semibold))
            .lineLimit(1)
            // A label never wraps; a long one in a narrow row shrinks a little first.
            .minimumScaleFactor(0.75)
            .frame(maxWidth: wide ? .infinity : nil)
            .foregroundStyle(colours.label.color)
            // kit.css: a border of three steps at the sides and four above and below.
            .padding(.horizontal, 6 * Metrics.step)
            .padding(.vertical, 4 * Metrics.step)
            .frame(minHeight: small ? ButtonPalette.smallHeight : ButtonPalette.height)
            .background {
                shape.fill(
                    pressed
                        ? AnyShapeStyle(colours.down.color.shadow(.inner(color: .black.opacity(0.4), radius: 2, y: 2)))
                        : AnyShapeStyle(colours.face.color))
            }
            .overlay { shape.inset(by: -0.5).stroke(colours.edge.color, lineWidth: 1) }
            .compositingGroup()
            .shadow(
                color: state == .normal ? Shadows.elevation1.paint.color : .clear,
                radius: Shadows.elevation1.radius, y: Shadows.elevation1.y)
            .contentShape(shape)
    }
}

/// The kit's button as a SwiftUI button style.
public struct KitButtonStyle: ButtonStyle {
    let kind: ButtonKind
    let chosen: Bool
    let small: Bool
    let wide: Bool
    @Environment(\.isEnabled) private var isEnabled

    public init(_ kind: ButtonKind = .slate, chosen: Bool = false, small: Bool = false, wide: Bool = false) {
        self.kind = kind
        self.chosen = chosen
        self.small = small
        self.wide = wide
    }

    public func makeBody(configuration: Configuration) -> some View {
        KitButtonFace(
            kind: kind, chosen: chosen, small: small, wide: wide,
            state: !isEnabled ? .disabled : configuration.isPressed ? .pressed : .normal
        ) { configuration.label }
        .animation(.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.12), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == KitButtonStyle {
    public static func kit(_ kind: ButtonKind = .slate, chosen: Bool = false, small: Bool = false, wide: Bool = false)
        -> KitButtonStyle
    {
        KitButtonStyle(kind, chosen: chosen, small: small, wide: wide)
    }
}

// MARK: - Frames

/// The kit's frames (kit.css `.ui-panel` and its kin).
public enum FrameKind: String, CaseIterable, Sendable {
    /// A panel on the page.
    case panel
    /// A panel on a panel.
    case raised
    /// A well sunk into a panel.
    case inset
    /// Paper: dark text on light.
    case paper
    /// The viewer's seat.
    case gold
    /// The seat to act.
    case glow
    /// Something gone wrong.
    case danger

    public var colours: FrameColours {
        switch self {
        case .panel: FramePalette.panel
        case .raised: FramePalette.raised
        case .inset: FramePalette.inset
        case .paper: FramePalette.paper
        case .gold: FramePalette.gold
        case .glow: FramePalette.glow
        case .danger: FramePalette.danger
        }
    }
}

struct KitFrame: ViewModifier {
    let kind: FrameKind

    func body(content: Content) -> some View {
        let colours = kind.colours
        let radius = Metrics.radiusM
        content
            .foregroundStyle(kind == .paper ? Palette.ink.color : Palette.paper.color)
            // kit.css: a transparent border of three steps holds the content in from the edge.
            .padding(3 * Metrics.step)
            .background {
                let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
                ZStack {
                    // The rings, outermost first, each a larger rounded rectangle behind the surface.
                    ForEach(Array(colours.rings.enumerated().reversed()), id: \.offset) { _, ring in
                        RoundedRectangle(cornerRadius: radius + ring.width, style: .continuous)
                            .fill(ring.paint.color)
                            .padding(-ring.width)
                    }
                    if let inner = colours.inner {
                        shape.fill(
                            colours.surface.color.shadow(
                                .inner(color: inner.paint.color, radius: inner.radius, y: inner.y)))
                    } else {
                        shape.fill(colours.surface.color)
                    }
                }
                .compositingGroup()
                .shadow(
                    color: colours.shadow?.paint.color ?? .clear, radius: colours.shadow?.radius ?? 0,
                    y: colours.shadow?.y ?? 0)
            }
    }
}

extension View {
    /// The content in one of the kit's frames.
    public func kitFrame(_ kind: FrameKind = .panel) -> some View {
        modifier(KitFrame(kind: kind))
    }

    /// Text on art: a soft shadow under it (theme.css `--text-shadow-ink`).
    public func inkShadow() -> some View {
        shadow(color: Shadows.textInk.paint.color, radius: Shadows.textInk.radius, y: Shadows.textInk.y)
    }
}

// MARK: - Fields

/// The kit's field (kit.css `.ui-field`): paper on ink with a dusk edge, round what it holds.
public struct KitFieldChrome: ViewModifier {
    nonisolated public init() {}

    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Metrics.radiusS, style: .continuous)
        content
            .foregroundStyle(Palette.paper.color)
            .padding(.horizontal, 5 * Metrics.step)
            .frame(minHeight: 44)
            .background(shape.fill(Palette.ink.color))
            .overlay(shape.inset(by: -0.5).stroke(Palette.dusk.color, lineWidth: 1))
    }
}

/// The kit's text field as a SwiftUI text field style.
public struct KitFieldStyle: TextFieldStyle {
    public init() {}

    public func _body(configuration: TextField<Self._Label>) -> some View {
        configuration.modifier(KitFieldChrome())
    }
}

// MARK: - The table

/// The felt and its rail (kit.css `.ui-table`), lit from above. `unit` is the site's
/// `--table-unit`: the rail is eight of them and the corners forty-eight.
public struct TableFelt: View {
    let unit: Double

    public init(unit: Double = 3) { self.unit = unit }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: 48 * unit, style: .continuous)
        let felt = RoundedRectangle(cornerRadius: 40 * unit, style: .continuous)
        ZStack {
            shape.fill(Palette.woodDark.color)
            felt
                .fill(
                    EllipticalGradient(
                        stops: [
                            .init(color: Palette.feltLight.color, location: 0),
                            .init(color: Palette.felt.color, location: 0.55),
                            .init(color: Palette.feltDark.color, location: 1),
                        ],
                        center: UnitPoint(x: 0.5, y: 0.4), endRadiusFraction: 0.75
                    )
                    // kit.css: `inset 0 10px 48px rgb(0 0 0 / 0.4)`, the light from above.
                    .shadow(.inner(color: .black.opacity(0.4), radius: 24, y: 10))
                )
                .overlay(felt.inset(by: 0.5).stroke(Palette.white.color.opacity(0.06), lineWidth: 1))
                .padding(8 * unit)
        }
        .overlay(shape.inset(by: -0.5).stroke(Palette.white.color.opacity(0.06), lineWidth: 1))
        .compositingGroup()
        .shadow(color: Shadows.elevation3.paint.color, radius: Shadows.elevation3.radius, y: Shadows.elevation3.y)
        .accessibilityHidden(true)
    }
}

// MARK: - The page

extension View {
    /// The app's page: the site's night behind everything, dark whatever the phone's
    /// appearance (Q-12), and the gold accent on the system's own controls.
    public func kitPage() -> some View {
        self
            .tint(Palette.gold.color)
            .background(Palette.night.color.ignoresSafeArea())
            .preferredColorScheme(.dark)
    }
}
