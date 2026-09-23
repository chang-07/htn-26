import UIKit
import Messages
import SwiftUI
import WebKit
import OSLog

/// Hybrid shell. Plan, cart and playlist URLs render native SwiftUI; token'd
/// forms (profile, address) and anything else load in a web view. The card's
/// `url` — sent via Linq's imessage_app part — is the whole contract.
class MessagesViewController: MSMessagesAppViewController, WKNavigationDelegate {

    /// Drawer-open with no card tapped.
    private let homeURL = URL(string: "https://whim.schangchang-li.workers.dev/")!

    private var hosting: UIHostingController<AnyView>?
    private var store: PlanStore?
    private var storeChat: String?
    private let presentation = PresentationInfo()

    private lazy var webView: WKWebView = {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.isOpaque = false
        wv.backgroundColor = .systemBackground
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        return wv
    }()

    private let spinner = UIActivityIndicatorView(style: .medium)

    /// Root views are swapped, not pushed — this is the only way back to the
    /// native home from a routed view (ticket, playlist, game, web checkout).
    private lazy var backButton: UIButton = {
        var config = UIButton.Configuration.plain()
        let symbol = UIImage.SymbolConfiguration(pointSize: 30, weight: .semibold)
            .applying(UIImage.SymbolConfiguration(paletteColors: [UIColor(Whim.paper), UIColor(Whim.ink)]))
        config.image = UIImage(systemName: "chevron.backward.circle.fill", withConfiguration: symbol)
        config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
        let button = UIButton(configuration: config)
        button.addTarget(self, action: #selector(goHome), for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.isHidden = true
        return button
    }()

    @objc private func goHome() {
        present(url: nil)
    }

    /// True while the native home is the hosted root.
    private var isHome = false

    /// Hidden on the home itself and in the transcript bubble, where any
    /// control would swallow the tap Messages needs to expand the card.
    /// While visible, its row is carved out of the safe area so hosted
    /// content lays out below it instead of sliding underneath.
    private func updateBackButton() {
        view.bringSubviewToFront(backButton)
        backButton.isHidden = isHome || presentationStyle == .transcript
        additionalSafeAreaInsets.top = backButton.isHidden ? 0 : 60
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        view.addGestureRecognizer(expandTap)
        view.addSubview(backButton)
        NSLayoutConstraint.activate([
            // Raw top, not the safe-area guide: updateBackButton() grows the
            // safe area to push content below the button, never the button.
            // 14+14 puts the circle's center on the sheet's ~40pt top-left
            // corner-radius arc center, so it reads as anchored to the curve.
            backButton.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            backButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 9),
        ])
    }

    /// Live-layout contract: Messages does nothing when the inline bubble is
    /// tapped — the extension must catch it and ask for the expanded sheet.
    private lazy var expandTap: UITapGestureRecognizer = {
        let g = UITapGestureRecognizer(target: self, action: #selector(expandFromTranscript))
        g.cancelsTouchesInView = false
        return g
    }()

    @objc private func expandFromTranscript() {
        guard presentationStyle == .transcript else { return }
        requestPresentationStyle(.expanded)
    }

    /// Runs `then` once a display name exists. Asks the first time, on the
    /// expanded sheet, because an alert cannot present over the compact drawer.
    private func withPlayerName(then: @escaping () -> Void) {
        if Player.hasName || viewIfLoaded?.window == nil { then(); return }
        if presentationStyle != .expanded { requestPresentationStyle(.expanded) }
        let alert = UIAlertController(title: "What should the group call you?", message: nil, preferredStyle: .alert)
        alert.addTextField { $0.placeholder = "Your name"; $0.autocapitalizationType = .words }
        alert.addAction(UIAlertAction(title: "Save", style: .default) { _ in
            let typed = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespaces) ?? ""
            if !typed.isEmpty { UserDefaults.standard.set(typed, forKey: Player.nameKey) }
            then()
        })
        alert.addAction(UIAlertAction(title: "Not now", style: .cancel) { _ in then() })
        present(alert, animated: true)
    }

    // MARK: - Lifecycle

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        convKey = Self.key(for: conversation)
        syncPresentation()
        present(url: conversation.selectedMessage?.url)
        if conversation.selectedMessage != nil, presentationStyle == .compact {
            requestPresentationStyle(.expanded)
        }
    }

    override func didTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
        super.didTransition(to: presentationStyle)
        syncPresentation()
        if presentationStyle == .compact, sheetOnly { present(url: nil) }
    }

    // Without this, Messages hands the transcript bubble its huge default
    // height and the card content floats in dead space. Each widget kind
    // declares its own bubble height; present(url:) keeps this current.
    // Messages sizes a bubble once, at insert — old bubbles never resize.
    private var transcriptHeight: CGFloat = 240

    override func contentSizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: min(size.height, transcriptHeight))
    }

    private func transcriptHeight(for path: String) -> CGFloat {
        if path.hasPrefix("/game/") { return 250 }   // ticket art + tap-to-play row
        if path.hasPrefix("/music/") { return 230 }
        if path.hasPrefix("/runner") { return 250 }
        return 240                                    // plan ticket, cart, everything else
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        convKey = Self.key(for: conversation)
        syncPresentation()
        present(url: message.url)
        if presentationStyle == .compact { requestPresentationStyle(.expanded) }
    }

    /// In the transcript bubble the native view must NOT swallow touches:
    /// the tap has to reach Messages so it can expand the card.
    private func syncPresentation() {
        let transcript = presentationStyle == .transcript
        presentation.isTranscript = transcript
        presentation.isExpanded = presentationStyle == .expanded
        // Touches stay ON: the inline tap is ours to handle (expandTap).
        view.isUserInteractionEnabled = true
        hosting?.view.isUserInteractionEnabled = true
        expandTap.isEnabled = transcript
        updateBackButton()
    }

    // MARK: - Conversation -> chat memory

    /// Stable per-conversation key on this device: the other participants.
    private var convKey: String?
    private static func key(for conversation: MSConversation) -> String {
        conversation.remoteParticipantIdentifiers.map(\.uuidString).sorted().joined(separator: ",")
    }

    private func rememberChat(base: URL, chat: String) {
        guard let convKey else { return }
        UserDefaults.standard.set(["base": base.absoluteString, "chat": chat], forKey: "whim.chat.\(convKey)")
    }

    private func recallChat() -> (base: URL, chat: String)? {
        guard let convKey,
              let dict = UserDefaults.standard.dictionary(forKey: "whim.chat.\(convKey)") as? [String: String],
              let baseStr = dict["base"], let base = URL(string: baseStr), let chat = dict["chat"] else { return nil }
        return (base, chat)
    }

    // MARK: - Routing

    private func present(url: URL?) {
        var url = url
        // Server cards have arrived scheme-less ("host/p/x") after env edits;
        // URL(string:) then puts the host in the path and every route misses.
        if let u = url, u.scheme == nil {
            url = URL(string: "https://" + u.absoluteString) ?? u
        }
        Logger(subsystem: "com.lukalavric.whim", category: "route")
            .info("present url: \(url?.absoluteString ?? "drawer home", privacy: .public)")
        if let path = url?.path { transcriptHeight = transcriptHeight(for: path) }
        isHome = url == nil
        // Drawer-open, no card: the native home — never the website.
        guard let target = url else {
            let known = recallChat()
            let base = known?.base ?? homeURL
            host(AnyView(HomeView(base: base, chat: known?.chat, presentation: presentation, onRoute: { [weak self] route in
                guard let self else { return }
                switch route {
                case .runner:
                    // Full sheet first: the camera permission prompt cannot
                    // present over the compact drawer.
                    self.isHome = false
                    if self.presentationStyle == .compact { self.requestPresentationStyle(.expanded) }
                    self.host(AnyView(InfiniteRunnerView(presentation: self.presentation, onChallenge: { [weak self] score, challenge in
                        self?.sendRunnerChallenge(score, against: challenge)
                    })), sheetOnly: true)
                case .slots:
                    self.isHome = false
                    if self.presentationStyle == .compact { self.requestPresentationStyle(.expanded) }
                    self.host(AnyView(SlotsView(presentation: self.presentation, onShare: { [weak self] face, name in
                        self?.sendSlotsResult(face: face, name: name)
                    })), sheetOnly: true)
                case .plan:
                    guard let known = self.recallChat() else { return }
                    self.present(url: known.base.appendingPathComponent("w/\(known.chat)"))
                case .playlist:
                    guard let known = self.recallChat() else { return }
                    self.present(url: known.base.appendingPathComponent("music/\(known.chat)"))
                case .cart:
                    guard let known = self.recallChat() else { return }
                    var comps = URLComponents(url: known.base.appendingPathComponent("w/\(known.chat)"), resolvingAgainstBaseURL: false)!
                    comps.queryItems = [URLQueryItem(name: "cart", value: "any")]
                    self.present(url: comps.url!)
                case .game(let id):
                    guard let known = self.recallChat() else { return }
                    if self.presentationStyle == .compact { self.requestPresentationStyle(.expanded) }
                    self.present(url: known.base.appendingPathComponent("game/\(known.chat)/\(id)"))
                case .webGame(let id):
                    guard let known = self.recallChat() else { return }
                    if self.presentationStyle == .compact { self.requestPresentationStyle(.expanded) }
                    self.present(url: known.base.appendingPathComponent("game-web/\(known.chat)/\(id)"))
                }
            })))
            return
        }
        let comps = URLComponents(url: target, resolvingAgainstBaseURL: false)
        // A trailing slash on the server's base URL makes paths arrive as
        // "//w/…", which silently demotes every card to the web view.
        var path = target.path
        while path.hasPrefix("//") { path.removeFirst() }

        if path.hasPrefix("/w/"), let chat = chatId(from: path, prefix: "/w/") {
            rememberChat(base: baseURL(of: target), chat: chat)
            let shop = comps?.queryItems?.first(where: { $0.name == "cart" })?.value
            let store = planStore(base: baseURL(of: target), chat: chat)
            if let shop {
                host(AnyView(CartListView(store: store, presentation: presentation, focusShop: shop, onCheckout: { [weak self] url in
                    self?.showWeb(url)
                })))
            } else {
                host(AnyView(TicketView(store: store, presentation: presentation)))
            }
            store.start()
            return
        }
        if path.hasPrefix("/music/"), let chat = chatId(from: path, prefix: "/music/") {
            rememberChat(base: baseURL(of: target), chat: chat)
            let store = planStore(base: baseURL(of: target), chat: chat)
            host(AnyView(PlaylistView(store: store, presentation: presentation)))
            store.start()
            return
        }
        // /game/<chat>/<id>: a generated game, played natively.
        if path.hasPrefix("/game/") {
            let parts = path.dropFirst("/game/".count).split(separator: "/", maxSplits: 1).map(String.init)
            if parts.count == 2 {
                let chat = parts[0].removingPercentEncoding ?? parts[0]
                rememberChat(base: baseURL(of: target), chat: chat)
                let gs = GameStore(base: baseURL(of: target), chat: chat, gameId: parts[1])
                host(AnyView(TriviaGameView(store: gs, presentation: presentation)))
                return
            }
        }
        // /game-web/<chat>/<id>: a generated web game — the sheet is the
        // console. In the transcript the bubble shows a poster instead: a
        // webview there swallows the tap Messages needs to expand the card.
        if path.hasPrefix("/game-web/") {
            if presentationStyle == .transcript {
                host(AnyView(WebGamePosterView()))
                return
            }
            if presentationStyle == .compact { requestPresentationStyle(.expanded) }
            withPlayerName { [weak self] in
                guard let self else { return }
                var playURL = target
                if var comps = URLComponents(url: target, resolvingAgainstBaseURL: false) {
                    var items = (comps.queryItems ?? []).filter { $0.name != "player" && $0.name != "pid" }
                    items.append(URLQueryItem(name: "player", value: Player.name))
                    items.append(URLQueryItem(name: "pid", value: Player.id))
                    comps.queryItems = items
                    playURL = comps.url ?? target
                }
                self.showWeb(playURL)
            }
            return
        }
        // /slots: a generated face-slots result card — reopen the native
        // slot machine when the message bubble is tapped.
        if path == "/slots" || path.hasPrefix("/slots/") {
            if presentationStyle == .compact { requestPresentationStyle(.expanded) }
            host(AnyView(SlotsView(presentation: presentation, onShare: { [weak self] face, name in
                self?.sendSlotsResult(face: face, name: name)
            })), sheetOnly: true)
            return
        }

        // /runner: a Camera Runner challenge card — open the game with the
        // score to beat.
        if path.hasPrefix("/runner") {
            let target = comps?.queryItems?.first(where: { $0.name == "score" })?.value.flatMap(Int.init)
            let result = comps?.queryItems?.first(where: { $0.name == "result" })?.value
            let run = comps?.queryItems?.first(where: { $0.name == "run" })?.value.flatMap(Int.init)
            let vs = comps?.queryItems?.first(where: { $0.name == "vs" })?.value.flatMap(Int.init)
            let who = comps?.queryItems?.first(where: { $0.name == "who" })?.value
            let by = comps?.queryItems?.first(where: { $0.name == "by" })?.value
            host(AnyView(InfiniteRunnerView(presentation: presentation, challengeScore: target, result: result, postedScore: run, versusScore: vs, senderName: who, isMine: by == nil || by == Player.id, onChallenge: { [weak self] score, challenge in
                self?.sendRunnerChallenge(score, against: challenge)
            })), sheetOnly: true)
            return
        }
        // /p/<token> and /p/<token>/ship: the token'd forms, native.
        if path.hasPrefix("/p/") {
            let isShip = path.hasSuffix("/ship")
            if isShip {
                host(AnyView(ShipFormView(formURL: target, presentation: presentation)))
            } else {
                host(AnyView(ProfileFormView(formURL: target, presentation: presentation)))
            }
            return
        }
        // /ticket/<chat>/<id>: a stored ticket (venue, RSVP, paid, match, plan)
        // rendered natively from its JSON.
        if path.hasPrefix("/ticket/") {
            let parts = path.dropFirst("/ticket/".count).split(separator: "/", maxSplits: 1).map(String.init)
            if parts.count == 2 {
                let chat = parts[0].removingPercentEncoding ?? parts[0]
                host(AnyView(TicketCardView(base: baseURL(of: target), chat: chat, ticketId: parts[1], presentation: presentation)))
                return
            }
        }
        showWeb(target)
    }

    private func chatId(from path: String, prefix: String) -> String? {
        let raw = String(path.dropFirst(prefix.count))
        guard !raw.isEmpty else { return nil }
        return raw.removingPercentEncoding ?? raw
    }

    private func baseURL(of url: URL) -> URL {
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.path = ""
        comps.query = nil
        return comps.url ?? homeURL
    }

    private func planStore(base: URL, chat: String) -> PlanStore {
        if let existing = store, storeChat == chat { return existing }
        let fresh = PlanStore(base: base, chat: chat)
        store = fresh
        storeChat = chat
        return fresh
    }

    /// The hosted view has no compact-drawer layout (runner, slots).
    private var sheetOnly = false

    private func host(_ root: AnyView, sheetOnly: Bool = false) {
        self.sheetOnly = sheetOnly
        webView.removeFromSuperview()
        spinner.removeFromSuperview()
        if let hosting {
            hosting.rootView = root
        } else {
            let host = UIHostingController(rootView: root)
            hosting = host
            addChild(host)
            host.view.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(host.view)
            NSLayoutConstraint.activate([
                host.view.topAnchor.constraint(equalTo: view.topAnchor),
                host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            ])
            host.didMove(toParent: self)
        }
        updateBackButton()
    }

    /// Puts a score card in the input field; the person hits send. A fresh
    /// challenge invites the chat; a reply to a challenge announces win or
    /// loss and — reusing the tapped card's session — replaces the old card,
    /// so the crown visibly changes heads (or holds).
    private func sendRunnerChallenge(_ score: Int, against challenge: Int?) {
        withPlayerName { [weak self] in
            guard let self else { return }
            guard let conversation = self.activeConversation else { return }
            let won = challenge.map { score > $0 }
            // Next player still chases the reigning score; the bubble itself
            // announces this run's win or loss.
            let target = won == false ? challenge! : score
            let who = Player.name
            var comps = URLComponents(url: self.homeURL.appendingPathComponent("runner"), resolvingAgainstBaseURL: false)!
            var items = [
                URLQueryItem(name: "score", value: String(target)),
                URLQueryItem(name: "run", value: String(score)),
                URLQueryItem(name: "result", value: won == true ? "won" : won == false ? "lost" : "challenge"),
                URLQueryItem(name: "who", value: who),
                URLQueryItem(name: "by", value: Player.id),
            ]
            if let challenge {
                items.append(URLQueryItem(name: "vs", value: String(challenge)))
            }
            comps.queryItems = items
            let layout = MSMessageTemplateLayout()
            switch won {
            case true:
                layout.caption = "\(who) won"
                layout.subcaption = "\(score) beats \(challenge!)"
                layout.trailingCaption = "WON"
            case false:
                layout.caption = "\(who) lost"
                layout.subcaption = "\(score) didn't beat \(challenge!)"
                layout.trailingCaption = "LOST"
            default:
                layout.caption = "\(who) scored \(score)"
                layout.subcaption = "Beat \(score) to win"
                layout.trailingCaption = "GO"
            }
            // The banner is the widget: crown on a win, X on a loss.
            let face = UserDefaults.standard.data(forKey: "whim.runner.avatar").flatMap(UIImage.init(data:))
            let outcome: RunnerResultWidget.Outcome = won == true ? .won : won == false ? .lost : .challenge
            let banner = RunnerCardBanner(score: score, versus: challenge, face: face, outcome: outcome)
            let renderer = ImageRenderer(content: banner)
            renderer.scale = 3
            layout.image = renderer.uiImage
            let session = challenge != nil ? (conversation.selectedMessage?.session ?? MSSession()) : MSSession()
            let message = MSMessage(session: session)
            message.url = comps.url
            message.layout = layout
            message.summaryText = layout.caption
            conversation.insert(message)
            self.present(url: nil)
            self.requestPresentationStyle(.compact)
        }
    }

    /// The verdict card: three reels frozen on the payer, into the input field.
    private func sendSlotsResult(face: UIImage, name: String) {
        guard let conversation = activeConversation else { return }
        let layout = MSMessageTemplateLayout()
        layout.caption = "\u{1F3B0} \(name) pays"
        layout.subcaption = "The reels have spoken."
        let renderer = ImageRenderer(content: SlotsCardBanner(face: face, name: name))
        renderer.scale = 3
        layout.image = renderer.uiImage
        let message = MSMessage(session: MSSession())
        message.url = homeURL.appendingPathComponent("slots")
        message.layout = layout
        message.summaryText = "Face slots verdict"
        conversation.insert(message)
        present(url: nil)
        requestPresentationStyle(.compact)
    }

    private func showWeb(_ url: URL) {
        store?.stop()
        hosting?.willMove(toParent: nil)
        hosting?.view.removeFromSuperview()
        hosting?.removeFromParent()
        hosting = nil

        if webView.superview == nil {
            webView.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(webView)
            view.addSubview(spinner)
            NSLayoutConstraint.activate([
                // Safe-area top: drops below the back button when it shows.
                webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
                webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            ])
        }
        if webView.url?.absoluteString != url.absoluteString {
            spinner.startAnimating()
            webView.load(URLRequest(url: url))
        }
        isHome = false
        updateBackButton()
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        spinner.stopAnimating()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        spinner.stopAnimating()
        showLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        spinner.stopAnimating()
        showLoadFailure(error)
    }

    /// A failed page is a dead end with no message otherwise: name the URL so
    /// a bad card link is diagnosable on the phone itself.
    private func showLoadFailure(_ error: Error) {
        let failing = (error as NSError).userInfo[NSURLErrorFailingURLStringErrorKey] as? String
            ?? webView.url?.absoluteString ?? "unknown URL"
        Logger(subsystem: "com.lukalavric.whim", category: "route")
            .error("web load failed: \(failing, privacy: .public) — \(error.localizedDescription, privacy: .public)")
        webView.loadHTMLString(
            "<body style=\"font: -apple-system-body; padding: 24px; word-break: break-all\">"
            + "<h3>Couldn’t load</h3><p><code>\(failing)</code></p><p>\(error.localizedDescription)</p></body>",
            baseURL: nil)
    }
}

/// The transcript face of a generated web game: a poster, never the game —
/// the bubble's tap must reach Messages so the card can expand.
struct WebGamePosterView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "gamecontroller.fill")
                .font(.system(size: 40))
                .foregroundStyle(Whim.coral)
            Text("A game built just for this chat")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Whim.ink)
            Label("Tap to play", systemImage: "hand.tap")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.accentColor)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Whim.paper)
    }
}
