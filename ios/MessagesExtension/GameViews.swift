import SwiftUI
import UIKit

// The generated-game widget: lobby -> rounds -> reveal -> scoreboard, all
// driven by the server's redacted view (correct answers never arrive early).

struct GameView_: Codable, Equatable {
    struct Player: Codable, Equatable {
        let name: String
        let score: Int
        var answered: Bool? = nil
        var chosen: Bool? = nil
        var hasAnswered: Bool { answered ?? chosen ?? false }
    }
    struct Question: Codable, Equatable { let q: String; let options: [String]; let myAnswer: Int? }
    struct Reveal: Codable, Equatable { let q: String; let options: [String]; let correct: Int; let myAnswer: Int?; let gotIt: [String] }
    struct Choice: Codable, Equatable { let id: String; let text: String }
    struct ChoiceRound: Codable, Equatable {
        let prompt: String
        let choices: [Choice]
        let myChoice: String?
        let correctId: String?
    }
    struct TapDodge: Codable, Equatable {
        struct Result: Codable, Equatable { let score: Int; let terminalReason: String }
        let seed: Int
        let durationMs: Int
        let obstacleIntervalMs: Int
        let obstacleSpeed: Int
        let gapSize: Int
        let result: Result?
    }
    struct Visual: Codable, Equatable { let mood: String; let accent: String; let icon: String }
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
    var gameType: String? = nil
    var surface: String? = nil
    var kind: String? = nil
    var bj: Bj? = nil
    let id: String
    let title: String
    let topic: String
    let phase: String
    let round: Int
    let totalRounds: Int
    var visual: Visual? = nil
    let players: [Player]
    var question: Question? = nil
    var reveal: Reveal? = nil
    var choiceRound: ChoiceRound? = nil
    var tapDodge: TapDodge? = nil
    var joined: Bool? = nil

    var isProcedural: Bool { gameType == "procedural" }
    var isJoined: Bool { joined ?? false }
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

    /// The server-rendered ticket PNG for this game. The `v` param tracks
    /// phase/round/player count so AsyncImage refetches when the card changes.
    var previewURL: URL? {
        guard let g = game else { return nil }
        var comps = URLComponents(url: base.appendingPathComponent("card/\(chat)"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            URLQueryItem(name: "kind", value: "game"),
            URLQueryItem(name: "id", value: gameId),
            URLQueryItem(name: "v", value: "\(g.phase)-\(g.round)-\(g.players.count)"),
        ]
        return comps.url
    }

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

/// AsyncImage gives up after one failed fetch, and the card endpoint can 500
/// once on a cold isolate — so this loader retries with a short backoff.
struct CardImage<Placeholder: View>: View {
    let url: URL?
    @ViewBuilder let placeholder: () -> Placeholder
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                placeholder()
            }
        }
        .task(id: url) {
            guard let url else { return }
            for attempt in 1...3 {
                if Task.isCancelled { return }
                var req = URLRequest(url: url)
                req.cachePolicy = .reloadIgnoringLocalCacheData
                if let (data, resp) = try? await URLSession.shared.data(for: req),
                   (resp as? HTTPURLResponse)?.statusCode == 200,
                   let ui = UIImage(data: data) {
                    image = ui
                    return
                }
                try? await Task.sleep(nanoseconds: UInt64(attempt) * 700_000_000)
            }
        }
    }
}

struct TriviaGameView: View {
    @ObservedObject var store: GameStore
    @ObservedObject var presentation: PresentationInfo
    @State private var name = ""
    @State private var tapStartedAt: Date?
    @State private var tapTrace: [Int] = []
    @State private var tapElapsedMs = 0
    @State private var tapTimer: Timer?
    @State private var tapY = 500
    @State private var tapVelocity = 0
    @State private var tapScore = 0
    @State private var tapHandledCount = 0
    @State private var tapSubmitted = false

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
        .background(Whim.paper)
        .whimPage()
        .animation(.snappy(duration: 0.35), value: store.game)
        .onAppear { store.start() }
        .onDisappear { stopTapRun(); store.stop() }
    }

    private func chip(_ text: String, tint: Color = .accentColor) -> some View {
        Text(text)
            .font(.caption.weight(.semibold)).foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
    }

    private func gameTint(_ g: GameView_) -> Color {
        switch g.visual?.accent {
        case "coral": return Whim.coral
        case "violet": return .purple
        case "mint": return Whim.mint
        default: return .accentColor
        }
    }

    // MARK: inline bubble

    /// The bubble leads with the server-rendered ticket art; the text layout
    /// stands in while it loads (or if it never arrives), so it's never blank.
    private func compact(_ g: GameView_) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            CardImage(url: store.previewURL) {
                compactText(g)
            }
            if g.phase == "done", let top = g.players.max(by: { $0.score < $1.score }) {
                Label("\(top.name) wins — \(top.score)", systemImage: "crown.fill")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
            } else {
                Label("Tap to play", systemImage: "hand.tap")
                    .font(.footnote.weight(.semibold)).foregroundStyle(Color.accentColor)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func compactText(_ g: GameView_) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            switch g.phase {
            case "lobby": WhimHeader(context: "Game", chipText: "\(g.players.count) in — tap to join")
            case "done": WhimHeader(context: "Game", chipText: "Final", chipTint: .orange)
            default: WhimHeader(context: "Game", chipText: nil)
            }
            Text(g.title).font(.system(.title3, design: .rounded).weight(.bold)).lineLimit(2)
            if g.phase == "round" || g.phase == "reveal" { ProgressDots(total: g.totalRounds, current: g.round) }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    // MARK: expanded sheet

    @ViewBuilder
    private func expanded(_ g: GameView_) -> some View {
        // Header pins to the top; the phase content centers in whatever height
        // is left, so a sparse lobby doesn't leave a page of empty paper.
        GeometryReader { geo in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    WhimHeader(context: g.topic, chipText: g.phase == "lobby" ? "Lobby" : nil, chipTint: g.isProcedural ? gameTint(g) : Whim.mintInk)

                    Spacer(minLength: 0)
                    Text(g.title).font(.system(.title3, design: .rounded).weight(.bold))
                    if g.phase != "lobby" && g.phase != "done" { ProgressDots(total: g.totalRounds, current: g.round) }
                    Group {
                        switch g.phase {
                        case "lobby":
                            if g.isProcedural { proceduralLobby(g) } else { lobby(g) }
                        case "round":
                            if g.isProcedural { proceduralRound(g) }
                            else if g.kind == "blackjack" { bjRound(g) } else { round(g) }
                        case "reveal":
                            if g.isProcedural { proceduralReveal(g) }
                            else if g.kind == "blackjack" { bjReveal(g) } else { reveal(g) }
                        default:
                            winnerHero(g)
                            if g.isProcedural { proceduralDone(g) } else { scoreboard(g, final: true) }
                        }
                    }
                    .id(g.phase + String(g.round))
                    .transition(.asymmetric(
                        insertion: .move(edge: .trailing).combined(with: .opacity),
                        removal: .opacity
                    ))
                    Spacer(minLength: 0)
                }
                .padding(16)
                .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: .topLeading)
            }
        }
    }

    @ViewBuilder
    private func lobby(_ g: GameView_) -> some View {
        Text(g.kind == "blackjack"
             ? "\(g.totalRounds) hands. Hit or stand against the dealer — most chips at the end wins."
             : "\(g.totalRounds) questions. Everyone answers on their own phone — most right answers wins.")
            .font(.subheadline).foregroundStyle(.secondary)
        if !g.players.isEmpty {
            ForEach(g.players, id: \.name) { p in
                Label(p.name, systemImage: "person.fill").font(.subheadline)
            }
        }
        if !g.isJoined {
            HStack(spacing: 8) {
                TextField("Your name", text: $name)
                    .textFieldStyle(.roundedBorder)
                Button("Join") { store.act("join", body: ["name": name]) }
                    .buttonStyle(.borderedProminent)
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
                    guard g.isJoined, q.myAnswer == nil else { return }
                    store.act("answer", body: ["choice": i])
                } label: {
                    HStack {
                        Text(opt).font(.subheadline.weight(.medium)).multilineTextAlignment(.leading)
                        Spacer()
                        if q.myAnswer == i { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor) }
                    }
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(q.myAnswer == i ? Color.accentColor.opacity(0.12) : Color(uiColor: .secondarySystemBackground))
                    )
                }
                .buttonStyle(.plain)
                .disabled(!g.isJoined || q.myAnswer != nil)
            }
            let waiting = g.players.filter { !$0.hasAnswered }.map(\.name)
            Text(g.isJoined
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

    // MARK: generated runtime surfaces

    @ViewBuilder
    private func proceduralLobby(_ g: GameView_) -> some View {
        if g.surface == "tap_dodge" {
            Text("A short, original one-thumb run. Tap to stay in the gap — best score takes the crown.")
                .font(.subheadline).foregroundStyle(.secondary)
            Button("Start the run") { store.act("advance", body: [:]) }
                .buttonStyle(PillButtonStyle())
        } else {
            Text("\(g.totalRounds) quick rounds. Everyone picks on their own phone — right pick scores, most points wins.")
                .font(.subheadline).foregroundStyle(.secondary)
            if !g.players.isEmpty {
                ForEach(g.players, id: \.name) { p in
                    Label(p.name, systemImage: "person.fill").font(.subheadline)
                }
            }
            if !g.isJoined {
                HStack(spacing: 8) {
                    TextField("Your name", text: $name)
                        .textFieldStyle(.roundedBorder)
                    Button("Join") { store.act("join", body: ["name": name]) }
                        .buttonStyle(.borderedProminent)
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } else {
                Button("Start the game") { store.act("advance", body: [:]) }
                    .buttonStyle(PillButtonStyle())
            }
        }
    }

    @ViewBuilder
    private func proceduralRound(_ g: GameView_) -> some View {
        if g.surface == "tap_dodge", let config = g.tapDodge {
            tapDodgeRun(config)
        } else if let round = g.choiceRound {
            Text(round.prompt).font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            ForEach(round.choices, id: \.id) { choice in
                Button {
                    guard g.isJoined, round.myChoice == nil else { return }
                    store.act("choose", body: ["choiceId": choice.id])
                } label: {
                    HStack {
                        Text(choice.text).font(.subheadline.weight(.medium)).multilineTextAlignment(.leading)
                        Spacer()
                        if round.myChoice == choice.id { Image(systemName: "checkmark.circle.fill").foregroundStyle(gameTint(g)) }
                    }
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(round.myChoice == choice.id ? gameTint(g).opacity(0.12) : Color(uiColor: .secondarySystemBackground))
                    )
                }
                .buttonStyle(.plain)
                .disabled(!g.isJoined || round.myChoice != nil)
            }
            let waiting = g.players.filter { !$0.hasAnswered }.map(\.name)
            Text(g.isJoined
                 ? (round.myChoice == nil ? "Pick one — the round flips when everyone is in." : waiting.isEmpty ? "Scoring…" : "Waiting on \(waiting.joined(separator: ", "))")
                 : "Join in the lobby to play — watching for now.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func proceduralReveal(_ g: GameView_) -> some View {
        if let round = g.choiceRound {
            Text(round.prompt).font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            ForEach(round.choices, id: \.id) { choice in
                HStack {
                    Image(systemName: round.correctId == nil ? "person.2.fill" : choice.id == round.correctId ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(round.correctId == nil ? Color.secondary : choice.id == round.correctId ? .green : Color(uiColor: .tertiaryLabel))
                    Text(choice.text).font(.subheadline.weight(round.correctId != nil && choice.id == round.correctId ? .semibold : .regular))
                    Spacer()
                    if round.myChoice == choice.id { Text("You").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
                }
                .padding(.vertical, 4)
            }
            scoreboard(g, final: false)
            Button(g.round >= g.totalRounds ? "Final scores" : "Next round") { store.act("advance", body: [:]) }
                .buttonStyle(PillButtonStyle())
        }
    }

    @ViewBuilder
    private func tapDodgeRun(_ config: GameView_.TapDodge) -> some View {
        if let result = config.result {
            tapResult(result)
        } else if tapSubmitted {
            VStack(spacing: 10) {
                ProgressView()
                Text("Checking your run…").font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 240)
        } else if tapStartedAt != nil {
            let seconds = max(0, Int(ceil(Double(config.durationMs - tapElapsedMs) / 1_000)))
            VStack(spacing: 12) {
                HStack {
                    Label("\(seconds)s", systemImage: "timer").font(.subheadline.weight(.semibold)).monospacedDigit()
                    Spacer()
                    Text("\(tapScore)").font(.subheadline.weight(.bold)).monospacedDigit()
                }
                tapDodgeScene(config)
                Button(action: recordTap) {
                    Label("Tap to fly", systemImage: "hand.tap.fill").font(.title3.weight(.bold)).frame(maxWidth: .infinity).padding(.vertical, 16)
                }
                .buttonStyle(.borderedProminent)
            }
        } else {
            Text("One thumb. Keep tapping through the gaps.").font(.subheadline).foregroundStyle(.secondary)
            Button("Begin run") { startTapRun(config) }
                .buttonStyle(PillButtonStyle())
        }
    }

    private func tapDodgeScene(_ config: GameView_.TapDodge) -> some View {
        GeometryReader { geo in
            ZStack {
                LinearGradient(colors: [Whim.mintInk, Whim.mint], startPoint: .topLeading, endPoint: .bottomTrailing)
                let count = config.durationMs / config.obstacleIntervalMs + 1
                ForEach(0..<count, id: \.self) { index in
                    let spawn = index * config.obstacleIntervalMs
                    let x = CGFloat(860 - (tapElapsedMs - spawn) * config.obstacleSpeed / 1_000) / 860 * geo.size.width
                    let center = 180 + Int(randomUnit(seed: config.seed, index: index) * 640)
                    let top = center - config.gapSize / 2
                    let bottom = center + config.gapSize / 2
                    if x > -32 && x < geo.size.width + 32 {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(.white.opacity(0.88))
                            .frame(width: 28, height: max(0, CGFloat(top) / 1_000 * geo.size.height))
                            .position(x: x, y: max(0, CGFloat(top) / 2_000 * geo.size.height))
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(.white.opacity(0.88))
                            .frame(width: 28, height: max(0, geo.size.height - CGFloat(bottom) / 1_000 * geo.size.height))
                            .position(x: x, y: CGFloat(bottom) / 1_000 * geo.size.height + max(0, geo.size.height - CGFloat(bottom) / 1_000 * geo.size.height) / 2)
                    }
                }
                Image(systemName: "sparkles")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(.yellow)
                    .position(x: 54, y: min(max(12, CGFloat(tapY) / 1_000 * geo.size.height), geo.size.height - 12))
            }
        }
        .frame(height: 210)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func tapResult(_ result: GameView_.TapDodge.Result) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(result.terminalReason == "time" ? "Run complete" : "Run over", systemImage: result.terminalReason == "time" ? "flag.checkered" : "xmark.octagon.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(result.terminalReason == "time" ? .green : .orange)
            Text("\(result.score)").font(.system(.largeTitle, design: .rounded).weight(.bold)).monospacedDigit()
            Text("points").font(.footnote).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    /// The finish line: crown, champion, score — the sheet's own confetti beat.
    @ViewBuilder
    private func winnerHero(_ g: GameView_) -> some View {
        if let top = g.players.max(by: { $0.score < $1.score }) {
            let champs = g.players.filter { $0.score == top.score }
            let unit = g.kind == "blackjack" ? "chips" : "points"
            VStack(spacing: 6) {
                Text("👑").font(.system(size: 44))
                Text(champs.count == 1 ? "\(top.name) takes it" : champs.map(\.name).joined(separator: " & ") + " tie it")
                    .font(.system(.title2, design: .rounded).weight(.heavy))
                    .multilineTextAlignment(.center)
                Text("\(top.score) \(unit)")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .background(
                ZStack {
                    RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Whim.coral.opacity(0.10))
                    Text("✳︎").font(.system(size: 90, weight: .heavy))
                        .foregroundStyle(Whim.coral.opacity(0.12))
                        .rotationEffect(.degrees(18))
                        .offset(x: 110, y: 18)
                }
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            )
        }
    }

    @ViewBuilder
    private func proceduralDone(_ g: GameView_) -> some View {
        if g.surface == "tap_dodge", let result = g.tapDodge?.result {
            tapResult(result)
        } else {
            scoreboard(g, final: true)
        }
    }

    private func startTapRun(_ config: GameView_.TapDodge) {
        stopTapRun()
        let started = Date()
        tapStartedAt = started
        tapTrace = []
        tapElapsedMs = -50
        tapY = 500
        tapVelocity = 0
        tapScore = 0
        tapHandledCount = 0
        tapSubmitted = false
        advanceTapRun(config)
        tapTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in advanceTapRun(config) }
    }

    private func recordTap() {
        guard let started = tapStartedAt, let duration = store.game?.tapDodge?.durationMs else { return }
        let elapsed = min(duration, max(tapElapsedMs + 50, Int(ceil(Date().timeIntervalSince(started) * 1_000 / 50)) * 50))
        if tapTrace.last != elapsed { tapTrace.append(elapsed) }
    }

    private func advanceTapRun(_ config: GameView_.TapDodge) {
        guard !tapSubmitted else { return }
        let lastTick = config.durationMs / 50 * 50
        let elapsed = min(lastTick, tapElapsedMs + 50)
        tapElapsedMs = elapsed
        while tapHandledCount < tapTrace.count && tapTrace[tapHandledCount] <= elapsed {
            tapVelocity = -100
            tapHandledCount += 1
        }
        tapVelocity += 12
        tapY += tapVelocity
        if tapY < 0 || tapY > 1_000 {
            finishTapRun()
            return
        }
        let count = config.durationMs / config.obstacleIntervalMs + 1
        for index in 0..<count {
            let cross = index * config.obstacleIntervalMs + 860_000 / config.obstacleSpeed
            guard elapsed >= cross && elapsed < cross + 50 else { continue }
            let center = 180 + Int(randomUnit(seed: config.seed, index: index) * 640)
            let top = center - config.gapSize / 2
            let bottom = center + config.gapSize / 2
            if tapY < top || tapY > bottom {
                finishTapRun()
                return
            }
            tapScore += 100
        }
        if elapsed >= lastTick { finishTapRun() }
    }

    private func finishTapRun() {
        guard !tapSubmitted else { return }
        tapSubmitted = true
        let trace = tapTrace
        stopTapRun()
        store.act("tap_replay", body: ["tapMs": trace])
    }

    private func randomUnit(seed: Int, index: Int) -> Double {
        var value = UInt32(truncatingIfNeeded: seed) &+ UInt32(truncatingIfNeeded: index + 1) &* 0x6d2b79f5
        value ^= value >> 16
        value = value &* 0x85ebca6b
        value ^= value >> 13
        return Double(value) / 4_294_967_296
    }

    private func stopTapRun() {
        tapTimer?.invalidate()
        tapTimer = nil
        tapStartedAt = nil
    }

    // MARK: blackjack

    /// The kerenel pixel deck bundled from public/: ♥ 01–13, ♠ 15–27, ♦ 29–41,
    /// ♣ 43–55, red back 28. Nil for anything unmapped, so the text tile stays
    /// the fallback.
    private func deckImage(_ card: String) -> UIImage? {
        let number: Int
        if card == "??" {
            number = 28
        } else {
            let order = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
            let bases: [String: Int] = ["♥": 0, "♠": 14, "♦": 28, "♣": 42]
            guard let base = bases[String(card.suffix(1))],
                  let idx = order.firstIndex(of: String(card.dropLast())) else { return nil }
            number = base + idx + 1
        }
        guard let url = Bundle.main.url(forResource: String(format: "%02d_kerenel_Cards", number),
                                        withExtension: "png",
                                        subdirectory: "kerenel_Cards_seperated") else { return nil }
        return UIImage(contentsOfFile: url.path)
    }

    @ViewBuilder
    private func playingCard(_ card: String, big: Bool = false) -> some View {
        if let deck = deckImage(card) {
            Image(uiImage: deck)
                .resizable()
                .interpolation(.none)
                .scaledToFit()
                .frame(width: big ? 46 : 38, height: big ? 64 : 54)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(.quaternary, lineWidth: 1))
                .shadow(color: .black.opacity(0.08), radius: 1, y: 1)
        } else {
            playingCardTile(card, big: big)
        }
    }

    private func playingCardTile(_ card: String, big: Bool = false) -> some View {
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
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(hidden ? AnyShapeStyle(Whim.tileGradient) : AnyShapeStyle(Color(uiColor: .systemBackground)))
        )
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.quaternary, lineWidth: 1))
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
                } else if g.isJoined {
                    HStack(spacing: 10) {
                        Button("Hit") { store.act("hit", body: [:]) }.buttonStyle(PillButtonStyle())
                        Button("Stand") { store.act("stand", body: [:]) }.buttonStyle(PillButtonStyle(prominent: false))
                    }
                } else {
                    Text("Join in the lobby to be dealt in next round.").font(.footnote).foregroundStyle(.secondary)
                }
                let waiting = g.players.filter { !$0.hasAnswered }.map(\.name)
                if !waiting.isEmpty && g.isJoined && bj.myDone {
                    Text("Still playing: \(waiting.joined(separator: ", "))").font(.footnote).foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Whim.mintInk.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
    @State private var pendingPromptId: String?
    @State private var surfaceChoices: [String] = []
    @State private var copyRisk = false

    private var voter: String { "ios:" + (UIDevice.current.identifierForVendor?.uuidString ?? "unknown") }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Make a game", systemImage: "wand.and.stars")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if let posted {
                HStack {
                    Label("\"\(posted)\" — card posted to the chat", systemImage: "checkmark.seal.fill")
                        .font(.subheadline.weight(.medium)).foregroundStyle(.green)
                    Spacer()
                    Button("Another") { self.posted = nil }
                        .font(.caption.weight(.semibold))
                }
            } else if let pendingPromptId {
                Text(copyRisk ? "That is too close to an existing game. Pick an original format:" : "Pick a format and I’ll make it:")
                    .font(.footnote).foregroundStyle(.secondary)
                ForEach(surfaceChoices, id: \.self) { surface in
                    Button {
                        Task { await choose(surface, promptId: pendingPromptId) }
                    } label: {
                        HStack {
                            Image(systemName: surface == "tap_dodge" ? "hand.tap.fill" : "checklist")
                            Text(surface == "tap_dodge" ? "One-thumb dodge" : "Quick-choice group game")
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                        }
                        .font(.subheadline.weight(.semibold))
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .disabled(working)
                }
                if working { ProgressView().frame(maxWidth: .infinity) }
                Button("Start over") {
                    self.pendingPromptId = nil
                    self.surfaceChoices = []
                    self.copyRisk = false
                }
                .font(.footnote.weight(.semibold))
            } else {
                HStack(spacing: 8) {
                    TextField("A game about…", text: $prompt)
                        .textFieldStyle(.roundedBorder)
                        .disabled(working)
                    Button {
                        Task { await create() }
                    } label: {
                        if working { ProgressView() } else { Text("Go") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(working || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if working {
                    Text("Choosing a safe format, then building it…").font(.footnote).foregroundStyle(.secondary)
                }
                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
            if let error, pendingPromptId != nil {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
    }

    private func create() async {
        await send(["prompt": prompt, "voter": voter, "name": Player.name])
    }

    private func choose(_ surface: String, promptId: String) async {
        await send(["promptId": promptId, "surface": surface, "voter": voter, "name": Player.name])
    }

    private func send(_ payload: [String: Any]) async {
        working = true
        defer { working = false }
        error = nil
        var req = URLRequest(url: base.appendingPathComponent("api/widget/\(chat)/game"))
        req.httpMethod = "POST"
        req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        struct Made: Codable {
            let status: String
            let id: String?
            let title: String?
            let promptId: String?
            let choices: [String]?
            let alternatives: [String]?
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let made = try JSONDecoder().decode(Made.self, from: data)
            switch made.status {
            case "created":
                posted = made.title ?? "Your game"
                pendingPromptId = nil
            case "needs_choice", "copy_risk":
                guard let promptId = made.promptId, !promptId.isEmpty else { throw URLError(.cannotParseResponse) }
                pendingPromptId = promptId
                surfaceChoices = made.choices ?? made.alternatives ?? []
                copyRisk = made.status == "copy_risk"
                if surfaceChoices.isEmpty { throw URLError(.cannotParseResponse) }
            default:
                throw URLError(.cannotParseResponse)
            }
        } catch {
            self.error = "Couldn't make that one — try a different topic."
        }
    }
}
