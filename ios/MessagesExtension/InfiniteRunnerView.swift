import AVFoundation
import SwiftUI
import UIKit
import Vision

/// Fixed, on-device camera game. Hand pinches become jumps; tapping is a
/// fallback so it remains playable if camera permission is declined.
final class HandRunnerTracker: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    @Published private(set) var jumpToken = 0
    @Published private(set) var cameraDenied = false

    private let sessionQueue = DispatchQueue(label: "whim.camera-runner")
    private var configured = false
    private var lastJump = Date.distantPast
    /// Latest camera frame, owned by sessionQueue; the avatar snap reads it.
    private var lastFrame: CVPixelBuffer?

    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: configureAndStart()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                if granted { self?.configureAndStart() }
                else { DispatchQueue.main.async { self?.cameraDenied = true } }
            }
        default:
            cameraDenied = true
        }
    }

    func stop() {
        sessionQueue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    private func configureAndStart() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if !self.configured {
                self.session.beginConfiguration()
                self.session.sessionPreset = .medium
                guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
                      let input = try? AVCaptureDeviceInput(device: camera), self.session.canAddInput(input) else {
                    self.session.commitConfiguration()
                    DispatchQueue.main.async { self.cameraDenied = true }
                    return
                }
                self.session.addInput(input)
                let output = AVCaptureVideoDataOutput()
                output.alwaysDiscardsLateVideoFrames = true
                output.setSampleBufferDelegate(self, queue: self.sessionQueue)
                guard self.session.canAddOutput(output) else {
                    self.session.commitConfiguration()
                    DispatchQueue.main.async { self.cameraDenied = true }
                    return
                }
                self.session.addOutput(output)
                self.configured = true
                self.session.commitConfiguration()
            }
            if !self.session.isRunning { self.session.startRunning() }
        }
    }

    /// Cut the person out of the latest frame — the "mii": photo in, sticker out.
    func snapAvatar(completion: @escaping (UIImage?) -> Void) {
        sessionQueue.async { [weak self] in
            guard let frame = self?.lastFrame else { return DispatchQueue.main.async { completion(nil) } }
            let segmentation = VNGeneratePersonSegmentationRequest()
            segmentation.qualityLevel = .accurate
            segmentation.outputPixelFormat = kCVPixelFormatType_OneComponent8
            let faces = VNDetectFaceRectanglesRequest()
            let handler = VNImageRequestHandler(cvPixelBuffer: frame, orientation: .leftMirrored)
            guard (try? handler.perform([segmentation, faces])) != nil,
                  let mask = segmentation.results?.first?.pixelBuffer else {
                return DispatchQueue.main.async { completion(nil) }
            }
            let image = CIImage(cvPixelBuffer: frame).oriented(.leftMirrored)
            var maskImage = CIImage(cvPixelBuffer: mask)
            maskImage = maskImage.transformed(by: CGAffineTransform(
                scaleX: image.extent.width / maskImage.extent.width,
                y: image.extent.height / maskImage.extent.height))
            let blend = CIFilter(name: "CIBlendWithMask", parameters: [
                kCIInputImageKey: image,
                kCIInputBackgroundImageKey: CIImage(color: .clear).cropped(to: image.extent),
                kCIInputMaskImageKey: maskImage,
            ])
            guard var cutout = blend?.outputImage else { return DispatchQueue.main.async { completion(nil) } }
            // Crop tight to the face — the sticker is a head, mii-style,
            // with a little margin for hair and chin.
            if let face = faces.results?.first {
                let b = face.boundingBox
                let rect = CGRect(x: b.minX * image.extent.width, y: b.minY * image.extent.height,
                                  width: b.width * image.extent.width, height: b.height * image.extent.height)
                    .insetBy(dx: -0.3 * b.width * image.extent.width, dy: -0.45 * b.height * image.extent.height)
                    .intersection(image.extent)
                if !rect.isEmpty { cutout = cutout.cropped(to: rect) }
            }
            // The Mr. Electric treatment: a hard fisheye bulge on the face.
            if let bump = CIFilter(name: "CIBumpDistortion", parameters: [
                kCIInputImageKey: cutout,
                kCIInputCenterKey: CIVector(x: cutout.extent.midX, y: cutout.extent.midY),
                kCIInputRadiusKey: min(cutout.extent.width, cutout.extent.height) * 0.6,
                kCIInputScaleKey: 0.7,
            ])?.outputImage {
                cutout = bump.cropped(to: cutout.extent)
            }
            let context = CIContext()
            guard let cg = context.createCGImage(cutout, from: cutout.extent) else {
                return DispatchQueue.main.async { completion(nil) }
            }
            DispatchQueue.main.async { completion(UIImage(cgImage: cg)) }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) { lastFrame = buffer }
        let request = VNDetectHumanHandPoseRequest()
        request.maximumHandCount = 1
        guard (try? VNImageRequestHandler(cmSampleBuffer: sampleBuffer, orientation: .leftMirrored).perform([request])) != nil,
              let hand = request.results?.first,
              let points = try? hand.recognizedPoints(.all),
              let thumb = points[.thumbTip], let index = points[.indexTip],
              thumb.confidence > 0.45, index.confidence > 0.45 else { return }
        let distance = hypot(thumb.location.x - index.location.x, thumb.location.y - index.location.y)
        guard distance < 0.09, Date().timeIntervalSince(lastJump) > 0.42 else { return }
        lastJump = Date()
        DispatchQueue.main.async { self.jumpToken += 1 }
    }
}

private struct RunnerCameraPreview: UIViewRepresentable {
    @ObservedObject var tracker: HandRunnerTracker

    /// The preview layer must track the view's real bounds — sizing it from
    /// updateUIView leaves it at zero (the grey box).
    final class PreviewHostView: UIView {
        var previewLayer: AVCaptureVideoPreviewLayer? {
            didSet { setNeedsLayout() }
        }
        override func layoutSubviews() {
            super.layoutSubviews()
            previewLayer?.frame = bounds
        }
    }

    func makeUIView(context: Context) -> PreviewHostView {
        let view = PreviewHostView()
        let layer = AVCaptureVideoPreviewLayer(session: tracker.session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        view.previewLayer = layer
        return view
    }

    func updateUIView(_ view: PreviewHostView, context: Context) {}
}

/// Your face on a little ink body, limbs swinging with the run — the person
/// the dino game never had. Airborne tucks the legs.
struct FaceRunnerSprite: View {
    let face: UIImage?
    let phase: Double
    let airborne: Bool
    var crowned = false

    var body: some View {
        let swing = airborne ? 24.0 : sin(phase) * 32
        VStack(spacing: -3) {
            if crowned {
                Text("👑").font(.system(size: 16)).offset(y: 6).zIndex(2)
            }
            Group {
                if let face {
                    Image(uiImage: face).resizable().scaledToFill()
                        .frame(width: 38, height: 38).clipShape(Circle())
                        .overlay(Circle().strokeBorder(.white, lineWidth: 2))
                } else {
                    Circle().fill(Whim.ink).frame(width: 26, height: 26)
                        .overlay(Circle().fill(.white).frame(width: 5, height: 5).offset(x: 6, y: -4))
                }
            }
            .zIndex(1)
            ZStack {
                // Arms behind the torso.
                Capsule().fill(Whim.ink).frame(width: 6, height: 18)
                    .rotationEffect(.degrees(swing), anchor: .top).offset(y: 2)
                Capsule().fill(Whim.ink).frame(width: 6, height: 18)
                    .rotationEffect(.degrees(-swing), anchor: .top).offset(y: 2)
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Whim.ink).frame(width: 16, height: 24)
            }
            ZStack {
                Capsule().fill(Whim.ink).frame(width: 6, height: 20)
                    .rotationEffect(.degrees(airborne ? 40 : swing), anchor: .top)
                Capsule().fill(Whim.ink).frame(width: 6, height: 20)
                    .rotationEffect(.degrees(airborne ? 55 : -swing), anchor: .top)
            }
            .offset(y: -4)
        }
        .shadow(color: .black.opacity(0.2), radius: 2, y: 2)
    }
}

/// The challenge card's picture: a slice of the dino course with the sender's
/// runner and a giant score. Rendered to a UIImage for MSMessageTemplateLayout.
struct RunnerCardBanner: View {
    let big: String
    let label: String
    let face: UIImage?
    var crowned = false

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Whim.paper
            Text("✳︎").font(.system(size: 130, weight: .heavy))
                .foregroundStyle(Whim.coral.opacity(0.16))
                .rotationEffect(.degrees(12)).offset(x: 120, y: 40)
            VStack(alignment: .leading, spacing: 0) {
                Text(big).font(.system(size: 58, weight: .heavy, design: .rounded)).foregroundStyle(Whim.ink)
                Text(label).font(.system(size: 13, weight: .heavy)).kerning(2.5).foregroundStyle(Whim.coral)
            }
            .padding(.leading, 22).padding(.bottom, 88)
            Rectangle().fill(Whim.ink.opacity(0.75)).frame(height: 3).padding(.bottom, 34)
            ZStack(alignment: .bottom) {
                Capsule().fill(Whim.greenDeep).frame(width: 12, height: 52)
                Capsule().fill(Whim.greenDeep).frame(width: 8, height: 24).offset(x: -9, y: -16)
                Capsule().fill(Whim.greenDeep).frame(width: 8, height: 20).offset(x: 9, y: -22)
            }
            .offset(x: 250, y: -36)
            FaceRunnerSprite(face: face, phase: 1.1, airborne: false, crowned: crowned)
                .scaleEffect(1.35, anchor: .bottom)
                .offset(x: 40, y: -36)
        }
        .frame(width: 340, height: 210)
    }
}

/// A deliberately fixed game, not a generated surface: pinch in the camera
/// to jump an endless obstacle course, with a normal tap fallback.
struct InfiniteRunnerView: View {
    @ObservedObject var presentation: PresentationInfo
    /// A score somebody sent this chat to beat.
    var challengeScore: Int? = nil
    /// Sends a score card into the conversation (host wires it up): a fresh
    /// challenge, or — when a challenge score is given — a win/loss result.
    var onChallenge: ((Int, Int?) -> Void)? = nil
    @StateObject private var tracker = HandRunnerTracker()
    @State private var score = 0
    @State private var runnerY: CGFloat = 0
    @State private var verticalSpeed: CGFloat = 0
    @State private var obstacleX: CGFloat = 340
    @State private var obstacleHeight: CGFloat = 68
    @State private var running = false
    @State private var gameOver = false
    @State private var timer: Timer?
    @State private var avatar: UIImage?
    @State private var snapping = false
    @State private var runPhase: Double = 0
    @State private var best = UserDefaults.standard.integer(forKey: InfiniteRunnerView.bestKey)

    private static let avatarKey = "whim.runner.avatar"
    private static let bestKey = "whim.runner.best"

    var body: some View {
        Group {
            if presentation.isTranscript { compact }
            else { expanded }
        }
        .background(Whim.paper)
        .whimPage()
        // Camera starts on the explicit Start tap, not on appear: presenting
        // the TCC prompt while the drawer is compact kills the extension.
        .onAppear {
            if let data = UserDefaults.standard.data(forKey: Self.avatarKey) { avatar = UIImage(data: data) }
        }
        .onDisappear { stopRun(); tracker.stop() }
        .onChange(of: tracker.jumpToken) { _ in jump() }
    }

    private var compact: some View {
        VStack(alignment: .leading, spacing: 8) {
            WhimHeader(context: "Camera runner", chipText: running ? "Live" : "Ready", chipTint: running ? .green : .secondary)
            Text("Pinch to jump. Run forever.").font(.system(.title3, design: .rounded).weight(.bold))
            HStack {
                Label("Score \(score)", systemImage: "figure.run").font(.footnote.weight(.semibold))
                Spacer()
                Label("Tap to play", systemImage: "hand.tap").font(.footnote.weight(.semibold)).foregroundStyle(Color.accentColor)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @State private var capturing = false

    private var expanded: some View {
        VStack(alignment: .leading, spacing: 14) {
            WhimHeader(context: "Camera runner",
                       chipText: running ? "Live" : (capturing ? "Say cheese" : "Endless"),
                       chipTint: running ? .green : .accentColor)
            if capturing { captureView }
            else if running || gameOver { gameView }
            else { menuView }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Pre-game menu: your face is the character select.
    private var menuView: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 0)
            Text("Camera Runner").font(.system(.title2, design: .rounded).weight(.heavy))
            Text("Pinch to jump. Your face runs the course.")
                .font(.subheadline).foregroundStyle(.secondary)
            if let challengeScore {
                Label("Beat \(challengeScore) to win the chat", systemImage: "flag.checkered")
                    .font(.subheadline.weight(.bold)).foregroundStyle(Whim.coral)
            }
            if best > 0 {
                Text("Your best: \(best)").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
            }
            ZStack {
                if let avatar {
                    Image(uiImage: avatar).resizable().scaledToFill()
                        .frame(width: 110, height: 110).clipShape(Circle())
                        .overlay(Circle().strokeBorder(Whim.coral, lineWidth: 3))
                } else {
                    Circle().strokeBorder(Whim.coral, style: StrokeStyle(lineWidth: 3, dash: [7, 6]))
                        .frame(width: 110, height: 110)
                    Image(systemName: "person.crop.circle.badge.plus")
                        .font(.system(size: 40)).foregroundStyle(Whim.coral)
                }
            }
            Button(avatar == nil ? "Snap your face" : "Re-snap your face") {
                capturing = true
                tracker.start()
            }
            .buttonStyle(PillButtonStyle(prominent: avatar == nil))
            Button("Start running") { startRun() }
                .buttonStyle(PillButtonStyle(prominent: avatar != nil))
            if score > 0 { Text("Last run: \(score)").font(.footnote).foregroundStyle(.secondary) }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    /// Camera with an oval to fit your face into, mii-booth style.
    private var captureView: some View {
        VStack(spacing: 12) {
            ZStack {
                RunnerCameraPreview(tracker: tracker)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                Color.black.opacity(0.45)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .mask(
                        ZStack {
                            Rectangle()
                            Ellipse().frame(width: 190, height: 250).blendMode(.destinationOut)
                        }.compositingGroup()
                    )
                Ellipse()
                    .stroke(Whim.coral, style: StrokeStyle(lineWidth: 3, dash: [9, 7]))
                    .frame(width: 190, height: 250)
                if tracker.cameraDenied {
                    Text("Camera unavailable").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                }
            }
            .frame(height: 330)
            Text("Fit your face in the oval, then snap.")
                .font(.footnote).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button("Cancel") {
                    capturing = false
                    if !running { tracker.stop() }
                }
                .buttonStyle(PillButtonStyle(prominent: false))
                Button(snapping ? "Cutting you out…" : "Snap") { snapAvatar() }
                    .buttonStyle(PillButtonStyle())
                    .disabled(snapping || tracker.cameraDenied)
            }
        }
    }

    private var gameView: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("Pinch jump").font(.system(.title3, design: .rounded).weight(.bold))
                Spacer()
                Text("\(score)").font(.system(.title2, design: .rounded).weight(.bold)).monospacedDigit()
            }
            runnerScene
            if gameOver {
                let beatChallenge = challengeScore.map { best > $0 } ?? false
                Text(beatChallenge ? "Challenge beaten — \(score)!" : "Nice run — \(score) obstacles cleared.")
                    .font(.subheadline.weight(.semibold))
                HStack(spacing: 8) {
                    Button("Menu") { gameOver = false; running = false; tracker.stop() }
                        .buttonStyle(PillButtonStyle(prominent: false))
                    Button("Run again") { startRun() }.buttonStyle(PillButtonStyle(prominent: onChallenge == nil))
                    if let onChallenge, best > 0 {
                        Button(challengeScore == nil ? "Challenge the chat" : (beatChallenge ? "Claim the crown" : "Send result")) {
                            onChallenge(best, challengeScore)
                        }
                        .buttonStyle(PillButtonStyle())
                    }
                }
            } else {
                Text(tracker.cameraDenied ? "Camera unavailable — tap Jump instead." : "Pinch thumb and index finger to jump. Tapping works too.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Jump") { jump() }.buttonStyle(PillButtonStyle(prominent: false))
            }
        }
    }

    /// The chrome-dino look on brand paper: ink ground, capsule cacti, and
    /// you — a face on an ink running body. The camera shrinks to a pip so
    /// the pinch hand stays visible.
    private var runnerScene: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                Whim.paper
                // Clouds, dino-game sparse.
                Image(systemName: "cloud.fill").font(.system(size: 22)).foregroundStyle(Whim.ink.opacity(0.08))
                    .offset(x: geo.size.width * 0.25, y: -geo.size.height + 46)
                Image(systemName: "cloud.fill").font(.system(size: 16)).foregroundStyle(Whim.ink.opacity(0.08))
                    .offset(x: geo.size.width * 0.7, y: -geo.size.height + 74)
                // Ground line with a dashed dirt row under it.
                Rectangle().fill(Whim.ink.opacity(0.75)).frame(height: 2).padding(.bottom, 22)
                HStack(spacing: 10) {
                    ForEach(0..<12, id: \.self) { _ in
                        Capsule().fill(Whim.ink.opacity(0.2)).frame(width: 8, height: 2)
                    }
                }
                .padding(.bottom, 14)
                cactus
                    .offset(x: obstacleX, y: -24)
                FaceRunnerSprite(face: avatar, phase: runPhase, airborne: runnerY > 2,
                                 crowned: challengeScore.map { score > $0 } ?? false)
                    .rotationEffect(.degrees(runnerY > 2 ? -8 : 0))
                    .offset(x: 40, y: -runnerY - 22)
                // Live pinch-hand pip.
                if !tracker.cameraDenied && running {
                    RunnerCameraPreview(tracker: tracker)
                        .frame(width: 64, height: 84)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.white, lineWidth: 2))
                        .shadow(color: .black.opacity(0.15), radius: 3, y: 2)
                        .offset(x: geo.size.width - 76, y: -geo.size.height + 96)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
        }
        .frame(height: 250)
        .background(Whim.paper)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Whim.ink.opacity(0.1), lineWidth: 1))
        .onTapGesture { jump() }
    }

    /// A capsule cactus, ink like the dino game's.
    private var cactus: some View {
        ZStack(alignment: .bottom) {
            Capsule().fill(Whim.greenDeep).frame(width: 14, height: obstacleHeight)
            Capsule().fill(Whim.greenDeep).frame(width: 10, height: obstacleHeight * 0.45)
                .offset(x: -11, y: -obstacleHeight * 0.3)
            Capsule().fill(Whim.greenDeep).frame(width: 10, height: obstacleHeight * 0.38)
                .offset(x: 11, y: -obstacleHeight * 0.42)
        }
    }

    private func startRun() {
        tracker.start()
        stopRun()
        score = 0
        runnerY = 0
        verticalSpeed = 0
        obstacleX = 340
        obstacleHeight = 68
        gameOver = false
        running = true
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { _ in tick() }
    }

    private func tick() {
        guard running else { return }
        verticalSpeed -= 0.9
        runnerY = max(0, runnerY + verticalSpeed)
        if runnerY == 0 { verticalSpeed = 0 }
        runPhase += 0.38
        // Dino-game ramp: a little faster with every obstacle cleared.
        obstacleX -= min(6.5 + Double(score) * 0.25, 12)
        if obstacleX < 64 && obstacleX > 36 && runnerY < obstacleHeight - 18 {
            gameOver = true
            running = false
            if score > best {
                best = score
                UserDefaults.standard.set(best, forKey: Self.bestKey)
            }
            stopRun()
        } else if obstacleX < -36 {
            score += 1
            obstacleX = 340
            obstacleHeight = CGFloat(Int.random(in: 52...122))
        }
    }

    private func jump() {
        guard running, runnerY < 2 else { return }
        verticalSpeed = 15
    }

    private func snapAvatar() {
        snapping = true
        tracker.snapAvatar { image in
            snapping = false
            guard let image else { return }
            avatar = image
            if let data = image.pngData() { UserDefaults.standard.set(data, forKey: Self.avatarKey) }
            capturing = false
            if !running { tracker.stop() }
        }
    }

    private func stopRun() {
        timer?.invalidate()
        timer = nil
    }
}
