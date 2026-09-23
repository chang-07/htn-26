#if DEBUG
import SwiftUI

// Golden fixtures for the Xcode canvas: design iteration without a phone
// install. Same data shapes the server sends; the harness's fixtures-first rule.

@MainActor
func fixturePlanStore(_ plan: PlanState) -> PlanStore {
    let s = PlanStore(base: URL(string: "https://preview.invalid")!, chat: "preview")
    s.plan = plan
    return s
}

@MainActor
func fixtureGameStore(_ g: GameView_) -> GameStore {
    let s = GameStore(base: URL(string: "https://preview.invalid")!, chat: "preview", gameId: "fx")
    s.game = g
    return s
}

let fxTranscript = { () -> PresentationInfo in let p = PresentationInfo(); p.isTranscript = true; return p }()
let fxSheet = { () -> PresentationInfo in let p = PresentationInfo(); p.isTranscript = false; p.isExpanded = true; return p }()

let fxPlan = PlanState(
    title: "Next week at 6:00 PM",
    status: "voting",
    options: [
        PlanOption(id: "a", title: "Games on Tap Board Game Café", subtitle: "1,000+ games, casual food", availability: nil),
        PlanOption(id: "b", title: "Public Kitchen and Bar", subtitle: "Tapas and small plates", availability: "open: 6:30, 8:45"),
        PlanOption(id: "c", title: "AOK Craft Beer and Arcade", subtitle: "Craft beer, arcade games", availability: nil),
    ],
    counts: ["a": 2, "b": 1, "c": 0],
    awaiting: ["Karan"],
    chosenOptionId: nil,
    bookingNote: nil,
    version: 3,
    carts: [CartSummary(shop: "levainbakery.com", checkoutUrl: "https://example.com", total: "$128.00", lines: [
        CartLine(title: "Chocolate Chip Walnut 4-pack", quantity: 3, price: "$32.00", imageUrl: nil),
        CartLine(title: "Signature Assortment", quantity: 1, price: "$32.00", imageUrl: nil),
    ], paidBy: nil)],
    playlist: [
        Track(title: "Mr. Brightside", artist: "The Killers", artUrl: nil, previewUrl: "https://example.com/p.m4a", appleMusicUrl: nil, addedBy: "Luka"),
        Track(title: "Kryptonite", artist: "3 Doors Down", artUrl: nil, previewUrl: nil, appleMusicUrl: nil, addedBy: "chang"),
    ]
)

let fxRound = GameView_(
    kind: "trivia", bj: nil, id: "fx", title: "Hackathons & All-Nighters", topic: "Coding sprints and caffeine",
    phase: "round", round: 2, totalRounds: 5,
    players: [
        .init(name: "Luka", score: 100, answered: true),
        .init(name: "chang", score: 200, answered: false),
        .init(name: "Karan", score: 0, answered: false),
    ],
    question: .init(q: "What does a rubber duck have to do with debugging?", options: [
        "It squeaks at bad code", "You explain your code to it", "It floats the stack", "Nothing, it's a myth",
    ], myAnswer: 1),
    reveal: nil, joined: true
)

let fxReveal = GameView_(
    kind: "trivia", bj: nil, id: "fx", title: "Hackathons & All-Nighters", topic: "Coding sprints and caffeine",
    phase: "reveal", round: 2, totalRounds: 5,
    players: [
        .init(name: "Luka", score: 200, answered: false),
        .init(name: "chang", score: 200, answered: false),
        .init(name: "Karan", score: 0, answered: false),
    ],
    question: nil,
    reveal: .init(q: "What does a rubber duck have to do with debugging?", options: [
        "It squeaks at bad code", "You explain your code to it", "It floats the stack", "Nothing, it's a myth",
    ], correct: 1, myAnswer: 1, gotIt: ["Luka"]), joined: true
)

let fxBlackjackRound = GameView_(
    kind: "blackjack",
    bj: .init(myHand: ["A♠", "7♥"], myTotal: 18, myDone: false, myBust: false,
              dealer: ["K♦", "??"], dealerTotal: nil, outcomes: nil),
    id: "bj", title: "Hackathon High Rollers", topic: "First to 1,000 chips",
    phase: "round", round: 2, totalRounds: 4,
    players: [
        .init(name: "Luka", score: 600, answered: false),
        .init(name: "chang", score: 500, answered: true),
    ],
    question: nil, reveal: nil,
    joined: true
)

let fxBlackjackReveal = GameView_(
    kind: "blackjack",
    bj: .init(myHand: ["A♠", "7♥"], myTotal: 18, myDone: true, myBust: false,
              dealer: ["K♦", "6♣", "8♥"], dealerTotal: 24,
              outcomes: [.init(name: "Luka", result: "win", delta: 100), .init(name: "chang", result: "lose", delta: -100)]),
    id: "bj", title: "Hackathon High Rollers", topic: "First to 1,000 chips",
    phase: "reveal", round: 2, totalRounds: 4,
    players: [
        .init(name: "Luka", score: 700, answered: false),
        .init(name: "chang", score: 400, answered: false),
    ],
    question: nil, reveal: nil,
    joined: true
)

#Preview("Plan — bubble") { TicketView(store: fixturePlanStore(fxPlan), presentation: fxTranscript).frame(height: 300) }
#Preview("Plan — sheet") { TicketView(store: fixturePlanStore(fxPlan), presentation: fxSheet) }
#Preview("Game — round") { TriviaGameView(store: fixtureGameStore(fxRound), presentation: fxSheet) }
#Preview("Game — reveal") { TriviaGameView(store: fixtureGameStore(fxReveal), presentation: fxSheet) }
#Preview("Game — bubble") { TriviaGameView(store: fixtureGameStore(fxRound), presentation: fxTranscript).frame(height: 280) }
#Preview("Cart — sheet") {
    CartListView(store: fixturePlanStore(fxPlan), presentation: fxSheet, focusShop: "levainbakery.com", onCheckout: { _ in })
}
#Preview("Playlist — sheet") { PlaylistView(store: fixturePlanStore(fxPlan), presentation: fxSheet) }
#Preview("Home — linked") {
    HomeView(base: URL(string: "https://preview.invalid")!, chat: "preview", presentation: fxSheet, onRoute: { _ in })
}
#endif
