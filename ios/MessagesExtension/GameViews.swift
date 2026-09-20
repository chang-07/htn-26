import SwiftUI
import UIKit

// The generated-game widget: lobby -> rounds -> reveal -> scoreboard, all
// driven by the server's redacted view (correct answers never arrive early).

struct GameView_: Codable, Equatable {
    struct Player: Codable, Equatable { let name: String; let score: Int; let answered: Bool }
    struct Question: Codable, Equatable { let q: String; let options: [String]; let myAnswer: Int? }
    struct Reveal: Codable, Equatable { let q: String; let options: [String]; let correct: Int; let myAnswer: Int?; let gotIt: [String] }
    struct BjOutcome: Codable, Equatable { let name: String; let result: String; let delta: Int }
    struct Bj: Codable, Equatable {
        let myHand: [String]
        let myTotal: Int
        let myDone: Bool
        let myBust: Bool
        let dealer: [String]
        let dealerTotal: Int?
        let outcomes: [BjOutcome]?
    }
    let kind: String
    let bj: Bj?
    let id: String
    let title: String
    let topic: String
    let phase: String
    let round: Int
    let totalRounds: Int
    let players: [Player]
    let question: Question?
    let reveal: Reveal?
    let joined: Bool
}

@MainActor
final class GameStore: ObservableObject {
    @Published var game: GameView_?
    @Published var failed = false

    private let base: URL
    private let chat: String
    private let gameId: String
    private var timer: Timer?

    init(base: URL, chat: String, gameId: String) {
        self.base = base
        self.chat = chat
        self.gameId = gameId
    }

    var voter: String { "ios:" + (UIDevice.current.identifierForVendor?.uuidString ?? "unknown") }

    private var gameURL: URL { base.appendingPathComponent("api/widget/\(chat)/game/\(gameId)") }

    func start() {
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func stop() { timer?.invalidate(); timer = nil }

    func refresh() {
        Task {
            var comps = URLComponents(url: gameURL, resolvingAgainstBaseURL: false)!
            comps.queryItems = [URLQueryItem(name: "voter", value: voter)]
            var req = URLRequest(url: comps.url!)
            req.cachePolicy = .reloadIgnoringLocalCacheData
            do {
                let (data, _) = try await URLSession.shared.data(for: req)
                let next = try JSONDecoder().decode(GameView_.self, from: data)
                if next != game { game = next }
                failed = false
            } catch { failed = game == nil }
        }
    }

    func act(_ sub: String, body: [String: Any]) {
        Task {
            var req = URLRequest(url: gameURL.appendingPathComponent(sub))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var payload = body
            payload["voter"] = voter
            req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let next = try? JSONDecoder().decode(GameView_.self, from: data) {
                game = next
            }
        }
    }
}

struct TriviaGameView: View {
    @ObservedObject var store: GameStore
    @ObservedObject var presentation: PresentationInfo
    @State private var name = ""

    var body: some View {
        Group {
            if let g = store.game {
                if presentation.isTranscript { compact(g) } else { expanded(g) }
            } else {
                VStack(spacing: 8) {
                    ProgressView()
                    Text(store.failed ? "Can't load the game" : "Loading…")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(uiColor: .systemBackground))
        .whimPage()
        .animation(.snappy(duration: 0.35), value: store.game)
        .onAppear { store.start() }
        .onDisappear { store.stop() }
    }

    private func chip(_ text: String, tint: Color = .accentColor) -> some View {
        Text(text)
            .font(.caption.weight(.semibold)).foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
        .background(tint.opacity(0.12), in: Rectangle())
    }

    // MARK: inline bubble

    private func compact(_ g: GameView_) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            switch g.phase {
            case "lobby": WhimHeader(context: "Game", chipText: "\(g.players.count) in — tap to join")
            case "done": WhimHeader(context: "Game", chipText: "Final", chipTint: .orange)
            default: WhimHeader(context: "Game", chipText: nil)
            }
            Text(g.title).font(Whim.display(22)).lineLimit(2)
            if g.phase == "round" || g.phase == "reveal" { ProgressDots(total: g.totalRounds, current: g.round) }
            if g.phase == "done", let top = g.players.max(by: { $0.score < $1.score }) {
                Label("\(top.name) wins — \(top.score)", systemImage: "crown.fill")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
            } else {
                Label("Tap to play", systemImage: "hand.tap")
                    .font(.footnote.weight(.semibold)).foregroundStyle(Color.accentColor)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: expanded sheet

    @ViewBuilder
    private func expanded(_ g: GameView_) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                WhimHeader(context: g.topic, chipText: g.phase == "lobby" ? "Lobby" : nil)
                Text(g.title).font(Whim.display(24))
                if g.phase != "lobby" && g.phase != "done" { ProgressDots(total: g.totalRounds, current: g.round) }

                Group {
                    switch g.phase {
                    case "lobby": lobby(g)
                    case "round":
                        if g.kind == "blackjack" { bjRound(g) } else { round(g) }
                    case "reveal":
                        if g.kind == "blackjack" { bjReveal(g) } else { reveal(g) }
                    default: scoreboard(g, final: true)
                    }
                }
                .id(g.phase + String(g.round))
                .transition(.asymmetric(
                    insertion: .move(edge: .trailing).combined(with: .opacity),
                    removal: .opacity
                ))
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private func lobby(_ g: GameView_) -> some View {
        Text("\(g.totalRounds) questions. Everyone answers on their own phone.")
            .font(.subheadline).foregroundStyle(.secondary)
        if !g.players.isEmpty {
            ForEach(g.players, id: \.name) { p in
                Label(p.name, systemImage: "person.fill").font(.subheadline)
            }
        }
        if !g.joined {
            HStack(spacing: 8) {
                TextField("Your name", text: $name)
                    .textFieldStyle(.roundedBorder)
                Button("Join") { store.act("join", body: ["name": name]) }
                    .buttonStyle(PillButtonStyle())
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        } else {
            Button("Start the game") { store.act("advance", body: [:]) }
                .buttonStyle(PillButtonStyle())
        }
    }

    @ViewBuilder
    private func round(_ g: GameView_) -> some View {
        if let q = g.question {
            Text(q.q).font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            ForEach(Array(q.options.enumerated()), id: \.offset) { i, opt in
                Button {
                    guard g.joined, q.myAnswer == nil else { return }
                    store.act("answer", body: ["choice": i])
                } label: {
                    HStack {
                        Text(opt).font(.subheadline.weight(.medium)).multilineTextAlignment(.leading)
                        Spacer()
                        if q.myAnswer == i { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor) }
                    }
                    .padding(12)
                    .background(
                        Rectangle()
                            .fill(q.myAnswer == i ? Whim.ticketInk.opacity(0.10) : Whim.ticketPaper.opacity(0.45))
                    )
                }
                .buttonStyle(.plain)
                .disabled(!g.joined || q.myAnswer != nil)
            }
            let waiting = g.players.filter { !$0.answered }.map(\.name)
            Text(g.joined
                 ? (q.myAnswer == nil ? "Pick one — first answer counts." : waiting.isEmpty ? "Everyone's in…" : "Waiting on \(waiting.joined(separator: ", "))")
                 : "Join in the lobby to play — watching for now.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func reveal(_ g: GameView_) -> some View {
        if let r = g.reveal {
            Text(r.q).font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            ForEach(Array(r.options.enumerated()), id: \.offset) { i, opt in
                HStack {
                    Image(systemName: i == r.correct ? "checkmark.circle.fill" : (r.myAnswer == i ? "xmark.circle.fill" : "circle"))
                        .foregroundStyle(i == r.correct ? .green : (r.myAnswer == i ? .red : Color(uiColor: .tertiaryLabel)))
                    Text(opt).font(.subheadline.weight(i == r.correct ? .semibold : .regular))
                    Spacer()
                }
                .padding(.vertical, 4)
            }
            Text(r.gotIt.isEmpty ? "Nobody got it." : "Got it: \(r.gotIt.joined(separator: ", ")) +100")
                .font(.footnote.weight(.semibold)).foregroundStyle(r.gotIt.isEmpty ? Color.secondary : Color.green)
            scoreboard(g, final: false)
            Button(g.round >= g.totalRounds ? "Final scores" : "Next question") { store.act("advance", body: [:]) }
                .buttonStyle(PillButtonStyle())
        }
    }

    // MARK: blackjack

    private func playingCard(_ card: String, big: Bool = false) -> some View {
        let hidden = card == "??"
        let suit = hidden ? "" : String(card.suffix(1))
        let red = suit == "♥" || suit == "♦"
        return VStack(spacing: 0) {
            if hidden {
                Image(systemName: "questionmark").font(big ? .title3 : .subheadline).foregroundStyle(.white)
            } else {
                Text(card.dropLast()).font(.system(big ? .body : .subheadline, design: .rounded).weight(.bold))
                Text(suit).font(big ? .subheadline : .caption)
            }
        }
        .foregroundStyle(hidden ? Color.white : (red ? Color.red : Color.primary))
        .frame(width: big ? 46 : 38, height: big ? 64 : 54)
        .background(
            Rectangle()
                .fill(hidden ? AnyShapeStyle(Whim.ticketInk) : AnyShapeStyle(Whim.ticketPaper))
        )
        .overlay(Rectangle().strokeBorder(Whim.rule, lineWidth: 1))
        .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
    }

    private func handRow(_ label: String, cards: [String], total: Int?, big: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label.uppercased()).font(.caption2.weight(.semibold)).kerning(0.8).foregroundStyle(.secondary)
                if let total { Text("\(total)").font(.caption.weight(.bold)).monospacedDigit() }
            }
            HStack(spacing: 6) { ForEach(Array(cards.enumerated()), id: \.offset) { _, c in playingCard(c, big: big) } }
        }
    }

    @ViewBuilder
    private func bjRound(_ g: GameView_) -> some View {
        if let bj = g.bj {
            VStack(alignment: .leading, spacing: 14) {
                handRow("Dealer", cards: bj.dealer, total: bj.dealerTotal)
                handRow("Your hand", cards: bj.myHand, total: bj.myTotal, big: true)
                if bj.myBust {
                    Label("Bust", systemImage: "xmark.octagon.fill").font(.subheadline.weight(.semibold)).foregroundStyle(.red)
                } else if bj.myDone {
                    Text("Standing on \(bj.myTotal). Waiting on the table…").font(.footnote).foregroundStyle(.secondary)
                } else if g.joined {
                    HStack(spacing: 10) {
                        Button("Hit") { store.act("hit", body: [:]) }.buttonStyle(PillButtonStyle())
                        Button("Stand") { store.act("stand", body: [:]) }.buttonStyle(PillButtonStyle(prominent: false))
                    }
                } else {
                    Text("Join in the lobby to be dealt in next round.").font(.footnote).foregroundStyle(.secondary)
                }
                let waiting = g.players.filter { !$0.answered }.map(\.name)
                if !waiting.isEmpty && g.joined && bj.myDone {
                    Text("Still playing: \(waiting.joined(separator: ", "))").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Whim.ticketInk.opacity(0.06), in: Rectangle())
        }
    }

    @ViewBuilder
    private func bjReveal(_ g: GameView_) -> some View {
        if let bj = g.bj {
            VStack(alignment: .leading, spacing: 14) {
                handRow("Dealer", cards: bj.dealer, total: bj.dealerTotal)
                handRow("Your hand", cards: bj.myHand, total: bj.myTotal, big: true)
                if let outcomes = bj.outcomes {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(outcomes, id: \.name) { o in
                            HStack {
                                Text(o.name).font(.subheadline.weight(.medium))
                                Spacer()
                                Text(o.result == "blackjack" ? "Blackjack!" : o.result.capitalized)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(o.delta > 0 ? .green : o.delta < 0 ? .red : .secondary)
                                Text(o.delta > 0 ? "+\(o.delta)" : "\(o.delta)")
                                    .font(.subheadline.weight(.bold)).monospacedDigit()
                                    .foregroundStyle(o.delta > 0 ? .green : o.delta < 0 ? .red : .secondary)
                            }
                        }
                    }
                    .padding(12)
                    .background(Whim.ticketPaper.opacity(0.5), in: Rectangle())
                }
                scoreboard(g, final: false)
                Button(g.round >= g.totalRounds ? "Final chips" : "Next hand") { store.act("advance", body: [:]) }
                    .buttonStyle(PillButtonStyle())
            }
        }
    }

    @ViewBuilder
    private func scoreboard(_ g: GameView_, final: Bool) -> some View {
        let ranked = g.players.sorted { $0.score > $1.score }
        VStack(alignment: .leading, spacing: 6) {
            if final { Label("Final scores", systemImage: "crown.fill").font(.subheadline.weight(.semibold)).foregroundStyle(.orange) }
            ForEach(Array(ranked.enumerated()), id: \.offset) { i, p in
                HStack {
                    Text("\(i + 1).").font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                    Text(p.name).font(.subheadline.weight(i == 0 ? .semibold : .regular))
                    Spacer()
                    Text("\(p.score)").font(.subheadline.weight(.semibold)).monospacedDigit()
                }
            }
        }
        .padding(12)
        .background(Whim.ticketPaper.opacity(0.5), in: Rectangle())
    }
}

// MARK: - Composer: type a prompt, the agent spins up a game card in this chat.

struct GameComposerView: View {
    let base: URL
    let chat: String
    @State private var prompt = ""
    @State private var working = false
    @State private var posted: String?
    @State private var error: String?

    private var voter: String { "ios:" + (UIDevice.current.identifierForVendor?.uuidString ?? "unknown") }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Make a game", systemImage: "wand.and.stars")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if let posted {
                Label("\"\(posted)\" — card posted to the chat", systemImage: "checkmark.seal.fill")
                    .font(.subheadline.weight(.medium)).foregroundStyle(.green)
            } else {
                HStack(spacing: 8) {
                    TextField("Trivia about…", text: $prompt)
                        .textFieldStyle(.roundedBorder)
                        .disabled(working)
                    Button {
                        Task { await create() }
                    } label: {
                        if working { ProgressView() } else { Text("Go") }
                    }
                    .buttonStyle(PillButtonStyle())
                    .disabled(working || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if working {
                    Text("Cooking your game — about ten seconds…").font(.footnote).foregroundStyle(.secondary)
                }
                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
        }
    }

    private func create() async {
        working = true
        defer { working = false }
        error = nil
        var req = URLRequest(url: base.appendingPathComponent("api/widget/\(chat)/game"))
        req.httpMethod = "POST"
        req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["prompt": prompt, "voter": voter])
        struct Made: Codable { let id: String; let title: String }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            posted = try JSONDecoder().decode(Made.self, from: data).title
        } catch {
            self.error = "Couldn't make that one — try a different topic."
        }
    }
}
