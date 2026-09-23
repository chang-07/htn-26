import Foundation
import UIKit

// Mirrors the Worker's public PlanState (src/types.ts). Private data never
// leaves the server, so this is exactly what the vote page also sees.
struct PlanOption: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let subtitle: String?
    let availability: String?
}

struct CartLine: Codable, Equatable {
    let title: String
    let quantity: Int
    let price: String?
    let imageUrl: String?
}

struct CartSummary: Codable, Equatable, Identifiable {
    let shop: String
    let checkoutUrl: String
    let total: String
    let lines: [CartLine]
    let paidBy: String?
    var id: String { shop }
}

struct Track: Codable, Equatable, Identifiable {
    let title: String
    let artist: String
    let artUrl: String?
    let previewUrl: String?
    let appleMusicUrl: String?
    let addedBy: String?
    var id: String { title + "|" + artist }
}

struct PlanState: Codable, Equatable {
    let title: String
    let status: String
    let options: [PlanOption]
    let counts: [String: Int]
    let awaiting: [String]
    let chosenOptionId: String?
    let bookingNote: String?
    let version: Int
    let carts: [CartSummary]?
    let playlist: [Track]?
}

/// Fetches plan state over plain HTTP (GET /api/widget/<chat>) and votes with
/// a POST. Polls while visible; the page's WebSocket equivalent, minus sockets.
@MainActor
final class PlanStore: ObservableObject {
    @Published var plan: PlanState?
    @Published var mine: String?
    @Published var failed = false

    let base: URL
    let chat: String
    private var timer: Timer?

    init(base: URL, chat: String) {
        self.base = base
        self.chat = chat
    }

    /// One voter per phone, stable across opens.
    private var voter: String {
        "ios:" + (UIDevice.current.identifierForVendor?.uuidString ?? "unknown")
    }

    private var stateURL: URL {
        base.appendingPathComponent("api/widget/\(chat)")
    }

    func start() {
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() {
        Task {
            do {
                var req = URLRequest(url: stateURL)
                req.cachePolicy = .reloadIgnoringLocalCacheData
                let (data, _) = try await URLSession.shared.data(for: req)
                let next = try JSONDecoder().decode(PlanState.self, from: data)
                if next != plan { plan = next }
                failed = false
            } catch {
                failed = plan == nil
            }
        }
    }

    func vote(_ optionId: String) {
        mine = optionId
        Task {
            var req = URLRequest(url: stateURL.appendingPathComponent("vote"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["optionId": optionId, "voter": voter])
            if let (data, _) = try? await URLSession.shared.data(for: req),
               let next = try? JSONDecoder().decode(PlanState.self, from: data) {
                plan = next
            }
        }
    }
}
