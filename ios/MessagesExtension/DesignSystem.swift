import SwiftUI

// Native counterpart to src/theme.ts. Cards are tickets: warm paper, dark ink,
// one heavy Archivo title, mono detail, perforations, and square actions.
enum Whim {
    static let ticketPaper = Color(red: 0xEF / 255, green: 0xE7 / 255, blue: 0xD6 / 255)
    static let ticketInk = Color(red: 0x24 / 255, green: 0x1F / 255, blue: 0x17 / 255)
    static let ticketGreen = Color(red: 0x1F / 255, green: 0x5F / 255, blue: 0x4F / 255)
    static let ticketGreenInk = Color(red: 0xF0 / 255, green: 0xEC / 255, blue: 0xE2 / 255)
    static let softInk = ticketInk.opacity(0.62)
    static let rule = ticketInk.opacity(0.34)

    static func display(_ size: CGFloat) -> Font { .custom("Archivo", size: size).weight(.heavy) }
    static func mono(_ size: CGFloat) -> Font { .custom("IBM Plex Mono", size: size) }
}

struct WhimHeader: View {
    let context: String
    var chipText: String? = nil
    var chipTint: Color = Whim.ticketInk
    var showTile = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if showTile {
                Text("W")
                    .font(Whim.display(13))
                    .foregroundStyle(Whim.ticketPaper)
                    .frame(width: 24, height: 24)
                    .background(Whim.ticketInk)
            }
            Text(context.uppercased())
                .font(Whim.mono(11))
                .tracking(1.3)
                .foregroundStyle(Whim.softInk)
                .lineLimit(1)
            Spacer()
            if let chipText {
                Text(chipText.uppercased())
                    .font(Whim.mono(10))
                    .tracking(0.9)
                    .foregroundStyle(chipTint)
                    .lineLimit(1)
            }
        }
    }
}

struct TicketRule: View {
    var body: some View {
        Rectangle()
            .fill(Whim.rule)
            .frame(height: 1)
            .overlay(alignment: .center) {
                Rectangle()
                    .stroke(style: StrokeStyle(lineWidth: 1.5, dash: [2, 3]))
                    .foregroundStyle(Whim.rule)
            }
    }
}

struct HeroStat: View {
    let value: String
    let label: String
    var tint: Color = Whim.ticketInk

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(Whim.display(36))
                .foregroundStyle(tint)
                .monospacedDigit()
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            Text(label.uppercased())
                .font(Whim.mono(10))
                .tracking(1)
                .foregroundStyle(Whim.softInk)
        }
    }
}

struct ProgressDots: View {
    let total: Int
    let current: Int

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<max(total, 1), id: \.self) { i in
                Rectangle()
                    .fill(i < current ? Whim.ticketInk : Whim.ticketInk.opacity(0.16))
                    .frame(width: i == current - 1 ? 14 : 6, height: 6)
            }
        }
    }
}

struct PillButtonStyle: ButtonStyle {
    var prominent = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Whim.mono(12))
            .tracking(1.2)
            .textCase(.uppercase)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(prominent ? Whim.ticketInk : Whim.ticketPaper)
            .foregroundStyle(prominent ? Whim.ticketPaper : Whim.ticketInk)
            .overlay(Rectangle().stroke(Whim.ticketInk, lineWidth: prominent ? 0 : 1.5))
            .opacity(configuration.isPressed ? 0.68 : 1)
    }
}

extension View {
    /// Shared top clearance keeps all transcript cards below Messages' app chrome.
    func whimPage() -> some View {
        self
            .font(Whim.mono(14))
            .tint(Whim.ticketInk)
            .foregroundStyle(Whim.ticketInk)
            .padding(.top, 24)
            .background(Whim.ticketPaper)
    }
}
