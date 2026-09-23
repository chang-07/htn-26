import SwiftUI

// Drawer-open home: what you get from the iMessage app strip with no card
// tapped. Native, useful, and never the website's signup flow.

enum HomeRoute {
    case plan, cart, playlist, runner, slots
    case game(String)
    case webGame(String)
}

struct HomeView: View {
    let base: URL
    /// Nil until this conversation has rendered one Whim card (that's how the
    /// extension learns which Linq chat this thread is).
    let chat: String?
    @ObservedObject var presentation: PresentationInfo
    let onRoute: (HomeRoute) -> Void

    var body: some View {
        GeometryReader { geo in
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                WhimHeader(context: "", chipText: chat != nil ? "Connected" : nil, showTile: true)
                Spacer(minLength: 0).frame(maxHeight: 150)
                Text("Plan, play, shop —\nright in the chat.")
                    .font(.system(.title3, design: .rounded).weight(.bold))
                    .fixedSize(horizontal: false, vertical: true)

                if let chat {
                    AskWhimView(base: base, chat: chat)
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

                HStack(spacing: 8) {
                    quick("Camera runner", icon: "figure.run") { onRoute(.runner) }
                    quick("Face slots — who pays?", icon: "dollarsign.circle.fill") { onRoute(.slots) }
                }
                if let chat {
                    RecentGamesView(base: base, chat: chat) { id, web in onRoute(web ? .webGame(id) : .game(id)) }
                }
                Spacer(minLength: 0)
            }
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: .topLeading)
        }
        // Keep the oversized ticket-spark in the full sheet only. In the
        // compact drawer it competes with the home controls and feels like
        // it's floating over the content.
        .overlay(alignment: .bottomTrailing) {
            if presentation.isExpanded {
                Text("✳︎")
                    .font(.system(size: 170, weight: .heavy))
                    .foregroundStyle(Whim.coral.opacity(0.14))
                    .rotationEffect(.degrees(12))
                    .offset(x: 48, y: 56)
                    .allowsHitTesting(false)
            }
        }
        .background(Whim.paper)
        .whimPage()
        }
    }

    private func quick(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: icon).font(.body).foregroundStyle(Whim.coral)
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(Whim.ink)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Whim.ink.opacity(0.08), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// Talk to the agent from the drawer or the plan sheet: the prompt enters the
/// chat pipeline and Whim answers in the thread, same as texting it.
struct AskWhimView: View {
    let base: URL
    let chat: String
    @State private var prompt = ""
    @State private var working = false
    @State private var sent = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Ask Whim", systemImage: "sparkles")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if sent {
                HStack {
                    Label("Whim's on it — watch the chat", systemImage: "checkmark.seal.fill")
                        .font(.subheadline.weight(.medium)).foregroundStyle(Whim.mintInk)
                    Spacer()
                    Button("Ask another") { sent = false }
                        .font(.caption.weight(.semibold))
                }
            } else {
                HStack(spacing: 8) {
                    TextField("Plan something, find tickets…", text: $prompt)
                        .textFieldStyle(.roundedBorder)
                        .disabled(working)
                    Button {
                        Task { await send() }
                    } label: {
                        if working { ProgressView() } else { Text("Send") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(working || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func send() async {
        working = true
        defer { working = false }
        var req = URLRequest(url: base.appendingPathComponent("api/widget/\(chat)/agent"))
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": prompt, "name": Player.name])
        if let (_, resp) = try? await URLSession.shared.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200 {
            prompt = ""
            sent = true
        }
    }
}

/// The chat's game shelf: recent generated games, reopenable from the drawer.
private struct RecentGamesView: View {
    let base: URL
    let chat: String
    let onOpen: (String, Bool) -> Void

    private struct GameSummary: Decodable, Identifiable {
        let id: String
        let title: String
        let surface: String
        let phase: String
        let players: Int
        let ts: Double
    }

    @State private var games: [GameSummary] = []

    var body: some View {
        Group {
            if games.isEmpty {
                // A real (zero-size) view: .task never fires on EmptyView, and
                // the first fetch must run while the shelf is still empty.
                Color.clear.frame(height: 0)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Recent games", systemImage: "gamecontroller.fill")
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(games.prefix(3)) { game in
                        Button { onOpen(game.id, game.surface == "web") } label: {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(game.title)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(Whim.ink)
                                        .lineLimit(1)
                                    Text(status(for: game))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: game.phase == "done" ? "flag.checkered" : "play.circle.fill")
                                    .foregroundStyle(game.phase == "done" ? AnyShapeStyle(.secondary) : AnyShapeStyle(Whim.coral))
                            }
                            .padding(12)
                            .background(.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Whim.ink.opacity(0.08), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .task { await load() }
    }

    private func status(for game: GameSummary) -> String {
        let when = RelativeDateTimeFormatter().localizedString(
            for: Date(timeIntervalSince1970: game.ts / 1000), relativeTo: Date())
        let state = game.phase == "done" ? "finished"
            : game.phase == "lobby" ? "in the lobby"
            : "in play"
        return game.players == 1 ? "1 player · \(state) · \(when)" : "\(game.players) players · \(state) · \(when)"
    }

    private func load() async {
        var req = URLRequest(url: base.appendingPathComponent("api/widget/\(chat)/games"))
        req.timeoutInterval = 10
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let list = try? JSONDecoder().decode([GameSummary].self, from: data) else { return }
        games = list
    }
}
