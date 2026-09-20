import SwiftUI

/// A living style guide: every widget state on fixture data, rendered in a
/// plain window. Built and relaunched from the CLI after each design edit —
/// no canvas, no debugger, no simulator.
@main
struct PreviewsApp: App {
    var body: some Scene {
        WindowGroup { GalleryView() }
    }
}

private struct Screen: Identifiable {
    let id: String
    let bubble: Bool
    let make: () -> AnyView
}

struct GalleryView: View {
    @State private var selected = "Plan · sheet"

    private var screens: [Screen] {
        [
            Screen(id: "Plan · bubble", bubble: true) { AnyView(TicketView(store: fixturePlanStore(fxPlan), presentation: fxTranscript)) },
            Screen(id: "Plan · sheet", bubble: false) { AnyView(TicketView(store: fixturePlanStore(fxPlan), presentation: fxSheet)) },
            Screen(id: "Game · lobby", bubble: false) {
                var g = fxRound
                g = GameView_(kind: g.kind, bj: nil, id: g.id, title: g.title, topic: g.topic, phase: "lobby", round: 0, totalRounds: 5,
                              players: g.players, question: nil, reveal: nil, joined: false)
                return AnyView(TriviaGameView(store: fixtureGameStore(g), presentation: fxSheet))
            },
            Screen(id: "Game · round", bubble: false) { AnyView(TriviaGameView(store: fixtureGameStore(fxRound), presentation: fxSheet)) },
            Screen(id: "Game · reveal", bubble: false) { AnyView(TriviaGameView(store: fixtureGameStore(fxReveal), presentation: fxSheet)) },
            Screen(id: "Game · bubble", bubble: true) { AnyView(TriviaGameView(store: fixtureGameStore(fxRound), presentation: fxTranscript)) },
            Screen(id: "Blackjack · round", bubble: false) { AnyView(TriviaGameView(store: fixtureGameStore(fxBlackjackRound), presentation: fxSheet)) },
            Screen(id: "Blackjack · reveal", bubble: false) { AnyView(TriviaGameView(store: fixtureGameStore(fxBlackjackReveal), presentation: fxSheet)) },
            Screen(id: "Cart · sheet", bubble: false) { AnyView(CartListView(store: fixturePlanStore(fxPlan), presentation: fxSheet, focusShop: "levainbakery.com", onCheckout: { _ in })) },
            Screen(id: "Cart · bubble", bubble: true) { AnyView(CartListView(store: fixturePlanStore(fxPlan), presentation: fxTranscript, focusShop: "levainbakery.com", onCheckout: { _ in })) },
            Screen(id: "Playlist · sheet", bubble: false) { AnyView(PlaylistView(store: fixturePlanStore(fxPlan), presentation: fxSheet)) },
            Screen(id: "Home · linked", bubble: false) { AnyView(HomeView(base: URL(string: "https://preview.invalid")!, chat: "preview", presentation: fxSheet, onRoute: { _ in })) },
            Screen(id: "Runner · sheet", bubble: false) { AnyView(InfiniteRunnerView(presentation: fxSheet)) },
            Screen(id: "Runner · card", bubble: false) {
                // The exact pipeline the challenge card uses: view -> UIImage.
                let banner = RunnerCardBanner(big: "👑 23", label: "NEW CHAMP", face: nil, crowned: true)
                let renderer = ImageRenderer(content: banner)
                renderer.scale = 3
                return AnyView(VStack(spacing: 12) {
                    Text(renderer.uiImage == nil ? "ImageRenderer: NIL" : "ImageRenderer: ok")
                        .font(.caption.weight(.bold))
                    if let ui = renderer.uiImage {
                        Image(uiImage: ui).resizable().scaledToFit().padding()
                            .border(.quaternary)
                    }
                })
            },
        ]
    }

    /// CLI automation: SIMCTL_CHILD_SCREEN="Game · lobby" simctl launch …
    /// renders that screen directly, so a script can screenshot every state.
    private var forced: Screen? {
        screens.first { $0.id == ProcessInfo.processInfo.environment["SCREEN"] }
    }

    var body: some View {
        if let s = forced {
            screenBody(s)
        } else {
            NavigationStack {
                List(screens) { s in
                    NavigationLink(s.id) {
                        screenBody(s)
                            .navigationTitle(s.id)
                            .navigationBarTitleDisplayMode(.inline)
                    }
                }
                .navigationTitle("Whim widgets")
            }
        }
    }

    private func screenBody(_ s: Screen) -> some View {
        Group {
            if s.bubble {
                // Bubble states at bubble height, boxed like a transcript card.
                s.make()
                    .frame(height: 300)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(.quaternary, lineWidth: 1))
                    .padding(16)
                    .frame(maxHeight: .infinity, alignment: .top)
            } else {
                s.make()
            }
        }
    }
}
