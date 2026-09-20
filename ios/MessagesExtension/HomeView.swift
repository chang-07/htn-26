import SwiftUI

// Drawer-open home: what you get from the iMessage app strip with no card
// tapped. Native, useful, and never the website's signup flow.

enum HomeRoute {
    case plan, cart, playlist, runner
}

struct HomeView: View {
    let base: URL
    /// Nil until this conversation has rendered one Whim card (that's how the
    /// extension learns which Linq chat this thread is).
    let chat: String?
    @ObservedObject var presentation: PresentationInfo
    let onRoute: (HomeRoute) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                WhimHeader(context: "", chipText: chat != nil ? "Connected" : nil, showTile: true)
                Text("Plan, play, shop —\nright in the chat.")
                    .font(.system(.title3, design: .rounded).weight(.bold))
                    .fixedSize(horizontal: false, vertical: true)

                if let chat {
                    GameComposerView(base: base, chat: chat)

                    HStack(spacing: 8) {
                        quick("Plan", icon: "calendar.badge.checkmark") { onRoute(.plan) }
                        quick("Playlist", icon: "music.note.list") { onRoute(.playlist) }
                        quick("Shopping", icon: "cart.fill") { onRoute(.cart) }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Not linked to this chat yet", systemImage: "link")
                            .font(.subheadline.weight(.semibold))
                        Text("Tap any Whim card in this conversation once and the app links up. No card yet? Text the planner and ask for anything — a plan, a game, a playlist.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }

                quick("Infinite camera runner", icon: "figure.run") { onRoute(.runner) }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(Whim.paper)
        .whimPage()
    }

    private func quick(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: icon).font(.body)
                Text(title).font(.caption.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .foregroundStyle(.primary)
        }
        .buttonStyle(.plain)
    }
}
