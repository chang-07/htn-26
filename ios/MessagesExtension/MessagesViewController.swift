import UIKit
import Messages
import SwiftUI
import WebKit

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

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        view.addGestureRecognizer(expandTap)
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
        // Touches stay ON: the inline tap is ours to handle (expandTap).
        view.isUserInteractionEnabled = true
        hosting?.view.isUserInteractionEnabled = true
        expandTap.isEnabled = transcript
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
        if let path = url?.path { transcriptHeight = transcriptHeight(for: path) }
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
                    if self.presentationStyle == .compact { self.requestPresentationStyle(.expanded) }
                    self.host(AnyView(InfiniteRunnerView(presentation: self.presentation, onChallenge: { [weak self] score, challenge in
                        self?.sendRunnerChallenge(score, against: challenge)
                    })))
                case .slots:
                    if self.presentationStyle == .compact { self.requestPresentationStyle(.expanded) }
                    self.host(AnyView(SlotsView(presentation: self.presentation, onShare: { [weak self] face, name in
                        self?.sendSlotsResult(face: face, name: name)
                    })))
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
                }
            })))
            return
        }
        let comps = URLComponents(url: target, resolvingAgainstBaseURL: false)
        let path = target.path

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
        // console, so expand before loading it.
        if path.hasPrefix("/game-web/") {
            if presentationStyle == .compact { requestPresentationStyle(.expanded) }
            showWeb(target)
            return
        }
        // /runner: a Camera Runner challenge card — open the game with the
        // score to beat.
        if path.hasPrefix("/runner") {
            let target = comps?.queryItems?.first(where: { $0.name == "score" })?.value.flatMap(Int.init)
            host(AnyView(InfiniteRunnerView(presentation: presentation, challengeScore: target, onChallenge: { [weak self] score, challenge in
                self?.sendRunnerChallenge(score, against: challenge)
            })))
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

    private func host(_ root: AnyView) {
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
    }

    /// Puts a score card in the input field; the person hits send. A fresh
    /// challenge invites the chat; a reply to a challenge announces win or
    /// loss and — reusing the tapped card's session — replaces the old card,
    /// so the crown visibly changes heads (or holds).
    private func sendRunnerChallenge(_ score: Int, against challenge: Int?) {
        guard let conversation = activeConversation else { return }
        let won = challenge.map { score > $0 }
        // The card's target stays whatever the reigning score is.
        let target = won == false ? challenge! : score
        var comps = URLComponents(url: homeURL.appendingPathComponent("runner"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "score", value: String(target))]
        let layout = MSMessageTemplateLayout()
        switch won {
        case true:
            layout.caption = "👑 New champ: \(score)"
            layout.subcaption = "The crown changed heads. Take it back?"
        case false:
            layout.caption = "Lost: \(score) vs \(challenge!)"
            layout.subcaption = "The crown holds. Beat \(challenge!)?"
        default:
            layout.caption = "Camera Runner: \(score)"
            layout.subcaption = "Pinch to jump. Beat it if you can."
        }
        layout.trailingCaption = "▶︎"
        // The banner: dino course, the sender's runner, giant score.
        let face = UserDefaults.standard.data(forKey: "whim.runner.avatar").flatMap(UIImage.init(data:))
        let banner = RunnerCardBanner(
            big: "\(target)",
            label: won == true ? "NEW CHAMP" : won == false ? "CROWN HOLDS" : "CAMERA RUNNER",
            face: face,
            crowned: won == true)
        let renderer = ImageRenderer(content: banner)
        renderer.scale = 3
        layout.image = renderer.uiImage
        let session = challenge != nil ? (conversation.selectedMessage?.session ?? MSSession()) : MSSession()
        let message = MSMessage(session: session)
        message.url = comps.url
        message.layout = layout
        message.summaryText = "A Camera Runner challenge"
        conversation.insert(message)
        requestPresentationStyle(.compact)
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
                webView.topAnchor.constraint(equalTo: view.topAnchor),
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
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        spinner.stopAnimating()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        spinner.stopAnimating()
    }
}
