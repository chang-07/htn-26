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

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
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

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        let layer = AVCaptureVideoPreviewLayer(session: tracker.session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        context.coordinator.layer = layer
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.layer?.frame = view.bounds
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var layer: AVCaptureVideoPreviewLayer? }
}

/// A deliberately fixed game, not a generated surface: pinch in the camera
/// to jump an endless obstacle course, with a normal tap fallback.
struct InfiniteRunnerView: View {
    @ObservedObject var presentation: PresentationInfo
    @StateObject private var tracker = HandRunnerTracker()
    @State private var score = 0
    @State private var runnerY: CGFloat = 0
    @State private var verticalSpeed: CGFloat = 0
    @State private var obstacleX: CGFloat = 340
    @State private var obstacleHeight: CGFloat = 68
    @State private var running = false
    @State private var gameOver = false
    @State private var timer: Timer?

    var body: some View {
        Group {
            if presentation.isTranscript { compact }
            else { expanded }
        }
        .background(Whim.paper)
        .whimPage()
        .onAppear { tracker.start() }
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

    private var expanded: some View {
        VStack(alignment: .leading, spacing: 14) {
            WhimHeader(context: "Camera runner", chipText: running ? "Live" : "Endless", chipTint: running ? .green : .accentColor)
            HStack(alignment: .firstTextBaseline) {
                Text("Pinch jump").font(.system(.title3, design: .rounded).weight(.bold))
                Spacer()
                Text("\(score)").font(.system(.title2, design: .rounded).weight(.bold)).monospacedDigit()
            }
            runnerScene
            if gameOver {
                Text("Nice run — \(score) obstacles cleared.").font(.subheadline.weight(.semibold))
                Button("Run again") { startRun() }.buttonStyle(PillButtonStyle())
            } else if running {
                Text(tracker.cameraDenied ? "Camera unavailable — tap Jump instead." : "Pinch thumb and index finger to jump. Tapping works too.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Jump") { jump() }.buttonStyle(PillButtonStyle(prominent: false))
            } else {
                Text(tracker.cameraDenied ? "Camera unavailable — tap to play." : "Allow camera access, then pinch to jump.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Start running") { startRun() }.buttonStyle(PillButtonStyle())
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var runnerScene: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                RunnerCameraPreview(tracker: tracker)
                    .opacity(tracker.cameraDenied ? 0 : 0.28)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                LinearGradient(colors: [Whim.green.opacity(0.18), Whim.greenDeep.opacity(0.32)], startPoint: .top, endPoint: .bottom)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                Capsule().fill(Color.primary.opacity(0.18)).frame(height: 4).padding(.horizontal, 14).padding(.bottom, 20)
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(.orange)
                    .frame(width: 26, height: obstacleHeight)
                    .offset(x: obstacleX, y: -24)
                Image(systemName: "figure.run")
                    .font(.system(size: 38, weight: .bold))
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.2), radius: 3, y: 2)
                    .offset(x: 46, y: -runnerY - 18)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
        }
        .frame(height: 250)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onTapGesture { jump() }
    }

    private func startRun() {
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
        obstacleX -= 6.5
        if obstacleX < 64 && obstacleX > 36 && runnerY < obstacleHeight - 18 {
            gameOver = true
            running = false
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

    private func stopRun() {
        timer?.invalidate()
        timer = nil
    }
}
