import SwiftUI
import AVFoundation

// Native renders for the remaining core widgets — same system design language
// as TicketView: SF type, semantic colors, capsules, SF Symbols.

// MARK: - Shopping list / cart

struct CartListView: View {
    @ObservedObject var store: PlanStore
    @ObservedObject var presentation: PresentationInfo
    /// The store this card was about, when the card named one.
    let focusShop: String?
    /// Hand a checkout off to the web view (Shopify checkout can't be native).
    let onCheckout: (URL) -> Void

    private var carts: [CartSummary] { store.plan?.carts ?? [] }

    var body: some View {
        Group {
            if carts.isEmpty {
                emptyState
            } else if presentation.isTranscript {
                compact
            } else {
                expanded
            }
        }
        .background(Color(uiColor: .systemBackground))
        .whimPage()
        .animation(.snappy(duration: 0.35), value: store.plan)
        .onAppear { store.start() }
        .onDisappear { store.stop() }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "cart").font(.title2).foregroundStyle(.secondary)
            Text(store.plan == nil ? "Loading…" : "No carts yet")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func headerRow(unpaid: Int, total: String?) -> some View {
        WhimHeader(context: "Shopping list", chipText: total)
    }

    private var compact: some View {
        let unpaid = carts.filter { $0.paidBy == nil }.count
        let focused = carts.first { $0.shop == focusShop } ?? carts[0]
        return VStack(alignment: .leading, spacing: 10) {
            headerRow(unpaid: unpaid, total: focused.total)
            Text(focused.shop).font(.title3.weight(.bold))
            ForEach(focused.lines.prefix(2), id: \.title) { line in
                HStack(spacing: 8) {
                    Text("\(line.quantity)×").font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
                    Text(line.title).font(.subheadline.weight(.medium)).lineLimit(1)
                    Spacer(minLength: 6)
                    if let p = line.price { Text(p).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            HStack {
                if focused.lines.count > 2 {
                    Text("+\(focused.lines.count - 2) more").font(.footnote).foregroundStyle(.secondary)
                }
                Spacer()
                if let paidBy = focused.paidBy {
                    Label("Paid by \(paidBy)", systemImage: "checkmark.seal.fill")
                        .font(.footnote.weight(.semibold)).foregroundStyle(.green)
                } else {
                    Label("Tap to check out", systemImage: "hand.tap")
                        .font(.footnote.weight(.semibold)).foregroundStyle(Color.accentColor)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var expanded: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                headerRow(unpaid: carts.filter { $0.paidBy == nil }.count, total: nil)
                ForEach(carts) { cart in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(cart.shop).font(.headline)
                            Spacer()
                            if let paidBy = cart.paidBy {
                                Label(paidBy, systemImage: "checkmark.seal.fill")
                                    .font(.caption.weight(.semibold)).foregroundStyle(.green)
                            } else {
                                Text(cart.total).font(.subheadline.weight(.semibold))
                            }
                        }
                        ForEach(cart.lines, id: \.title) { line in
                            HStack(spacing: 8) {
                                Text("\(line.quantity)×").font(.subheadline).foregroundStyle(.secondary).monospacedDigit()
                                Text(line.title).font(.subheadline).lineLimit(2)
                                Spacer(minLength: 6)
                                if let p = line.price { Text(p).font(.footnote).foregroundStyle(.secondary) }
                            }
                        }
                        if cart.paidBy == nil, let url = URL(string: cart.checkoutUrl) {
                            Button {
                                onCheckout(url)
                            } label: {
                                Text("Check out \(cart.total)")
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                    .padding(12)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                Text("Whoever pays taps through — or thumbs-up the cart in the chat and the agent handles it.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(16)
        }
    }
}

// MARK: - Playlist

struct PlaylistView: View {
    @ObservedObject var store: PlanStore
    @ObservedObject var presentation: PresentationInfo

    @State private var player: AVPlayer?
    @State private var playingId: String?

    private var tracks: [Track] { store.plan?.playlist ?? [] }

    var body: some View {
        Group {
            if tracks.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "music.note.list").font(.title2).foregroundStyle(.secondary)
                    Text(store.plan == nil ? "Loading…" : "No songs yet — name one in the chat")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .padding(14)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if presentation.isTranscript {
                compact
            } else {
                expanded
            }
        }
        .background(Color(uiColor: .systemBackground))
        .whimPage()
        .onAppear { store.start() }
        .onDisappear { store.stop(); player?.pause() }
    }

    private var header: some View {
        WhimHeader(context: "Group playlist", chipText: "\(tracks.count) tracks")
    }

    private var compact: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            ForEach(tracks.prefix(3)) { t in
                HStack(spacing: 8) {
                    Image(systemName: "music.note").font(.caption).foregroundStyle(.secondary)
                    Text(t.title).font(.subheadline.weight(.medium)).lineLimit(1)
                    Spacer(minLength: 6)
                    Text(t.artist).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            HStack {
                if tracks.count > 3 { Text("+\(tracks.count - 3) more").font(.footnote).foregroundStyle(.secondary) }
                Spacer()
                Label("Tap to play", systemImage: "play.fill")
                    .font(.footnote.weight(.semibold)).foregroundStyle(Color.accentColor)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var expanded: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                header
                ForEach(tracks) { t in
                    Button { toggle(t) } label: {
                        HStack(spacing: 10) {
                            AsyncImage(url: t.artUrl.flatMap(URL.init)) { img in
                                img.resizable().scaledToFill()
                            } placeholder: {
                                Color(uiColor: .secondarySystemFill)
                            }
                            .frame(width: 42, height: 42)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(t.title).font(.subheadline.weight(.medium)).lineLimit(1).foregroundStyle(.primary)
                                Text(t.artist + (t.addedBy.map { " · added by \($0)" } ?? ""))
                                    .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 6)
                            Image(systemName: playingId == t.id ? "pause.circle.fill" : (t.previewUrl == nil ? "slash.circle" : "play.circle.fill"))
                                .font(.title2)
                                .foregroundStyle(t.previewUrl == nil ? Color(uiColor: .tertiaryLabel) : Color.accentColor)
                        }
                        .padding(10)
                        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(t.previewUrl == nil)
                }
                Text("30-second previews via iTunes. Name a song in the chat to add it.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(16)
        }
    }

    private func toggle(_ t: Track) {
        guard let urlStr = t.previewUrl, let url = URL(string: urlStr) else { return }
        if playingId == t.id {
            player?.pause()
            playingId = nil
            return
        }
        player?.pause()
        player = AVPlayer(url: url)
        player?.play()
        playingId = t.id
    }
}
