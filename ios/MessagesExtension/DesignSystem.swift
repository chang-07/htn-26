import SwiftUI

// The shared look, matched to the website (Landing.css): cream paper, near-black
// ink, coral accent with mint support — pages pin light so they read like the
// server-rendered ticket PNGs in any system appearance.

enum Whim {
    /// Website palette (Landing.css).
    static let paper = Color(red: 0xFA / 255, green: 0xF9 / 255, blue: 0xF6 / 255)
    static let ink = Color(red: 0x28 / 255, green: 0x28 / 255, blue: 0x27 / 255)
    static let coral = Color(red: 0xFF / 255, green: 0x46 / 255, blue: 0x7C / 255)
    static let mint = Color(red: 0x84 / 255, green: 0xEF / 255, blue: 0xC4 / 255)
    static let mintInk = Color(red: 0x15 / 255, green: 0x3C / 255, blue: 0x30 / 255)
    static let orange = Color(red: 0xFF / 255, green: 0x75 / 255, blue: 0x3F / 255)
    /// Illustration colour only (cactus art), matching `cactus` in src/theme.ts. Never a UI accent.
    static let cactus = Color(red: 0x1F / 255, green: 0x5F / 255, blue: 0x4F / 255)

    static var tileGradient: LinearGradient {
        LinearGradient(colors: [mintInk, mint], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// The BodyBuddy-style header: app tile + name on the left, one chip on the right.
struct WhimHeader: View {
    let context: String
    var chipText: String? = nil
    var chipTint: Color = Whim.mintInk
    /// Chips only render where opted in — transcript bubbles, which have no
    /// back button. Sheets keep their corners clear for it.
    var chipVisible = false
    /// Apple's bubble chrome already shows the app icon and name, so the tile
    /// stays off in cards and on only where there is no chrome (Home, gallery).
    var showTile = false

    var body: some View {
        HStack(spacing: 8) {
            if showTile {
                // The site wordmark: "whim" in ink with the coral asterisk.
                HStack(spacing: 2) {
                    Text("whim").font(.system(size: 17, weight: .heavy, design: .rounded))
                        .foregroundStyle(Whim.ink)
                    Text("✳︎").font(.system(size: 13, weight: .heavy))
                        .foregroundStyle(Whim.coral)
                        .baselineOffset(5)
                }
            }
            Spacer()
            // No context label: the tiny corner text never sat well against
            // the back button. `context` stays accepted for call-site compat.
            if chipVisible, let chipText {
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
                    .fill(i < current ? Whim.mintInk : Color(uiColor: .systemFill))
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
                prominent ? AnyShapeStyle(Whim.coral) : AnyShapeStyle(Whim.ink.opacity(0.06)),
                in: Capsule()
            )
            .foregroundStyle(prominent ? Color(red: 0x29 / 255, green: 0x19 / 255, blue: 0x22 / 255) : Whim.ink)
            .opacity(configuration.isPressed ? 0.75 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

extension View {
    /// Card page chrome: the website's cream paper and coral accent, pinned to
    /// light appearance so pages match the ticket PNGs in any system theme.
    func whimPage() -> some View {
        self.tint(Whim.coral)
            .background(Whim.paper)
            .environment(\.colorScheme, .light)
    }
}

/// Who this phone is, for lobbies and cards. iOS 16 returns "iPhone" for the
/// device name without a restricted entitlement, so the name is asked once
/// and stored; the id is the vendor identifier, stable per install.
enum Player {
    static let nameKey = "whim.player.name"

    static var hasName: Bool {
        guard let stored = UserDefaults.standard.string(forKey: nameKey) else { return false }
        return !stored.trimmingCharacters(in: .whitespaces).isEmpty
    }

    static var name: String {
        if hasName, let stored = UserDefaults.standard.string(forKey: nameKey) {
            return stored.trimmingCharacters(in: .whitespaces)
        }
        return UIDevice.current.name
    }

    static var id: String {
        let raw = UIDevice.current.identifierForVendor?.uuidString ?? "anon"
        return String(raw.lowercased().filter { $0.isLetter || $0.isNumber }.prefix(8))
    }
}
