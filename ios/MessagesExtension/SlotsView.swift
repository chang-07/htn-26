import AVFoundation
import SwiftUI
import UIKit

// Face slots: everyone at the table snaps a face, the reels spin, and whoever
// they land on pays. Pass-the-phone; nothing leaves the device until the
// result card is shared to the chat.

struct SlotsPlayer: Identifiable {
    let id = UUID()
    let name: String
    let face: UIImage
}

/// The result card's picture: the three reels frozen on the payer.
struct SlotsCardBanner: View {
    let face: UIImage
    let name: String

    var body: some View {
        ZStack {
            Whim.paper
            Text("✳︎").font(.system(size: 130, weight: .heavy))
                .foregroundStyle(Whim.coral.opacity(0.16))
                .rotationEffect(.degrees(12)).offset(x: 120, y: 60)
            VStack(spacing: 14) {
                HStack(spacing: 12) {
                    ForEach(0..<3, id: \.self) { _ in
                        Image(uiImage: face).resizable().scaledToFill()
                            .frame(width: 72, height: 72).clipShape(Circle())
                            .overlay(Circle().strokeBorder(Whim.coral, lineWidth: 3))
                    }
                }
                VStack(spacing: 2) {
                    Text("🎰 \(name.uppercased()) PAYS")
                        .font(.system(size: 26, weight: .heavy, design: .rounded)).foregroundStyle(Whim.ink)
                    Text("THE REELS HAVE SPOKEN")
                        .font(.system(size: 11, weight: .heavy)).kerning(2.5).foregroundStyle(Whim.coral)
                }
            }
        }
        .frame(width: 340, height: 210)
    }
}

struct SlotsView: View {
    @ObservedObject var presentation: PresentationInfo
    /// Shares the result card into the conversation (host wires it up).
    var onShare: ((UIImage, String) -> Void)? = nil

    @StateObject private var tracker = HandRunnerTracker()
    @State private var players: [SlotsPlayer] = []
    @State private var capturing = false
    @State private var snapping = false
    @State private var name = ""
    @State private var spinning = false
    @State private var reels: [Int] = [0, 0, 0]
    @State private var stopped = 0
    @State private var chosen: SlotsPlayer?
    @State private var spinTimer: Timer?

    var body: some View {
        Group {
            if presentation.isTranscript { compact } else { expanded }
        }
        .background(Whim.paper)
        .whimPage()
        .onDisappear { spinTimer?.invalidate(); tracker.stop() }
    }

    private var compact: some View {
        VStack(alignment: .leading, spacing: 8) {
            WhimHeader(context: "Face slots", chipText: "\(players.count) in")
            Text("Spin to see who pays.").font(.system(.title3, design: .rounded).weight(.bold))
            Label("Tap to open", systemImage: "hand.tap").font(.footnote.weight(.semibold)).foregroundStyle(Color.accentColor)
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var expanded: some View {
        VStack(alignment: .leading, spacing: 14) {
            WhimHeader(context: "Face slots", chipText: capturing ? "Say cheese" : "\(players.count) in")
            if capturing { captureView } else if let chosen { resultView(chosen) } else { machineView }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: machine

    private var machineView: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 0)
            Text("Who pays?").font(.system(.title2, design: .rounded).weight(.heavy))
            Text("Everyone snaps a face. The reels decide.")
                .font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                ForEach(0..<3, id: \.self) { i in
                    reelWindow(i)
                }
            }
            .padding(14)
            .background(.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Whim.ink.opacity(0.08), lineWidth: 1))
            if !players.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(players) { p in
                            VStack(spacing: 3) {
                                Image(uiImage: p.face).resizable().scaledToFill()
                                    .frame(width: 44, height: 44).clipShape(Circle())
                                Text(p.name).font(.caption2.weight(.semibold)).lineLimit(1)
                            }
                        }
                    }
                }
            }
            Button("Add a player") { capturing = true; tracker.start() }
                .buttonStyle(PillButtonStyle(prominent: players.count < 2))
            Button(spinning ? "Spinning…" : "Spin") { spin() }
                .buttonStyle(PillButtonStyle(prominent: players.count >= 2))
                .disabled(players.count < 2 || spinning)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    private func reelWindow(_ i: Int) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Whim.paper)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Whim.coral.opacity(0.5), lineWidth: 2))
            if players.isEmpty {
                Text("?").font(.system(size: 34, weight: .heavy, design: .rounded)).foregroundStyle(Whim.coral.opacity(0.4))
            } else {
                Image(uiImage: players[reels[i] % players.count].face)
                    .resizable().scaledToFill()
                    .frame(width: 66, height: 66).clipShape(Circle())
            }
        }
        .frame(width: 84, height: 92)
    }

    // MARK: capture

    private var captureView: some View {
        VStack(spacing: 12) {
            ZStack {
                RunnerCameraPreview2(tracker: tracker)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                Color.black.opacity(0.45)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .mask(
                        ZStack {
                            Rectangle()
                            Ellipse().frame(width: 170, height: 220).blendMode(.destinationOut)
                        }.compositingGroup()
                    )
                Ellipse().stroke(Whim.coral, style: StrokeStyle(lineWidth: 3, dash: [9, 7]))
                    .frame(width: 170, height: 220)
                if tracker.cameraDenied {
                    Text("Camera unavailable").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                }
            }
            .frame(height: 280)
            TextField("Player name", text: $name)
                .textFieldStyle(.roundedBorder)
            HStack(spacing: 8) {
                Button("Done adding") { capturing = false; tracker.stop() }
                    .buttonStyle(PillButtonStyle(prominent: false))
                Button(snapping ? "Cutting…" : "Snap") { snap() }
                    .buttonStyle(PillButtonStyle())
                    .disabled(snapping || tracker.cameraDenied || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func snap() {
        snapping = true
        tracker.snapAvatar { image in
            snapping = false
            guard let image else { return }
            players.append(SlotsPlayer(name: name.trimmingCharacters(in: .whitespaces), face: image))
            name = ""
            // Stay in the booth: the next person is already leaning in.
        }
    }

    // MARK: spin

    private func spin() {
        guard players.count >= 2 else { return }
        spinning = true
        chosen = nil
        stopped = 0
        let winner = Int.random(in: 0..<players.count)
        var ticks = 0
        spinTimer?.invalidate()
        spinTimer = Timer.scheduledTimer(withTimeInterval: 0.07, repeats: true) { _ in
            ticks += 1
            for i in stopped..<3 { reels[i] = (reels[i] + 1 + i) % max(players.count, 1) }
            // Reels lock left to right, each on the winner.
            if ticks == 14 || ticks == 22 || ticks == 30 {
                reels[stopped] = winner
                stopped += 1
                if stopped == 3 {
                    spinTimer?.invalidate()
                    spinning = false
                    withAnimation(.snappy) { chosen = players[winner] }
                }
            }
        }
    }

    // MARK: result

    private func resultView(_ p: SlotsPlayer) -> some View {
        VStack(spacing: 14) {
            Spacer(minLength: 0)
            Image(uiImage: p.face).resizable().scaledToFill()
                .frame(width: 130, height: 130).clipShape(Circle())
                .overlay(Circle().strokeBorder(Whim.coral, lineWidth: 4))
            Text("🎰 \(p.name) pays").font(.system(.title2, design: .rounded).weight(.heavy))
            Text("The reels have spoken.").font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button("Spin again") { chosen = nil }
                    .buttonStyle(PillButtonStyle(prominent: false))
                if let onShare {
                    Button("Send to the chat") { onShare(p.face, p.name) }
                        .buttonStyle(PillButtonStyle())
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Same live preview host the runner uses; duplicated because the runner's is
/// file-private.
struct RunnerCameraPreview2: UIViewRepresentable {
    @ObservedObject var tracker: HandRunnerTracker

    final class HostView: UIView {
        var previewLayer: CALayer? { didSet { setNeedsLayout() } }
        override func layoutSubviews() {
            super.layoutSubviews()
            previewLayer?.frame = bounds
        }
    }

    func makeUIView(context: Context) -> HostView {
        let view = HostView()
        let layer = AVCaptureVideoPreviewLayer(session: tracker.session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        view.previewLayer = layer
        return view
    }

    func updateUIView(_ view: HostView, context: Context) {}
}

