import SwiftUI

/// Container app. Exists so the Messages extension has something to ship
/// inside; everything real happens in the extension.
@main
struct PlanApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 12) {
                Text("Plan").font(.largeTitle.bold())
                Text("Open Messages and pick Plan from the app drawer.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}
