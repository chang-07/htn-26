import SwiftUI

// The shared look, modeled on Linq's experience-card mocks: airy white card,
// small app-avatar header, one hero element per card, pill CTAs, brand green.

enum Whim {
    /// Brand green (the Whim tile).
    static let green = Color(red: 0x17 / 255, green: 0x9B / 255, blue: 0x6B / 255)
    static let greenDeep = Color(red: 0x0E / 255, green: 0x6F / 255, blue: 0x4C / 255)

    static var tileGradient: LinearGradient {
        LinearGradient(colors: [green, greenDeep], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// The BodyBuddy-style header: app tile + name on the left, one chip on the right.
struct WhimHeader: View {
    let context: String
    var chipText: String? = nil
    var chipTint: Color = Whim.green
    /// Apple's bubble chrome already shows the app icon and name, so the tile
    /// stays off in cards and on only where there is no chrome (Home, gallery).
    var showTile = false

    var body: some View {
        HStack(spacing: 8) {
            if showTile {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Whim.tileGradient)
                    .frame(width: 24, height: 24)
                    .overlay(
                        Text("W").font(.system(size: 13, weight: .heavy, design: .rounded))
                            .foregroundStyle(.white)
                    )
            }
            Text(context)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            if let chipText {
                Text(chipText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(chipTint)
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(chipTint.opacity(0.12), in: Capsule())
            }
        }
    }
}

/// One giant number with a small caps label under it — the "350 CAL" move.
struct HeroStat: View {
    let value: String
    let label: String
    var tint: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 40, weight: .heavy, design: .rounded))
                .foregroundStyle(tint)
                .monospacedDigit()
                .contentTransition(.numericText())
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(label.uppercased())
                .font(.caption2.weight(.semibold))
                .kerning(0.8)
                .foregroundStyle(.secondary)
        }
    }
}

/// Round-progress dots, filled up to `current`.
struct ProgressDots: View {
    let total: Int
    let current: Int

    var body: some View {
        HStack(spacing: 5) {

            ForEach(0..<max(total, 1), id: \.self) { i in
                Circle()
                    .fill(i < current ? Whim.green : Color(uiColor: .systemFill))
                    .frame(width: 6, height: 6)
                    .scaleEffect(i == current - 1 ? 1.35 : 1)
            }
        }
    }
}

/// The full-width pill CTA from the ticket mock.
struct PillButtonStyle: ButtonStyle {
    var prominent = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(
                prominent ? AnyShapeStyle(Whim.tileGradient) : AnyShapeStyle(Color(uiColor: .secondarySystemBackground)),
                in: Capsule()
            )
            .foregroundStyle(prominent ? Color.white : Color.primary)
            .opacity(configuration.isPressed ? 0.75 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

extension View {
    /// Card page chrome: padding rhythm + brand tint for interactive elements.
    func whimPage() -> some View {
        self.tint(Whim.green)
    }
}
