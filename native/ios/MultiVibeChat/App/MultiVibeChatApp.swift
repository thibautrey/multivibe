import SwiftUI

@main struct MultiVibeChatApp: App {
    @State private var manager = ConversationManager.shared
    var body: some Scene {
        WindowGroup {
            Group {
                if manager.isRestoring { ProgressView("Restauration…") }
                else if manager.session == nil { AuthenticationView() }
                else { ChatView() }
            }
            .environment(manager)
            .tint(MultiVibeTheme.accent)
            .task { await manager.restore() }
        }
    }
}

/// Brand color adapts to system appearance; typography, controls and materials
/// remain native. The brighter mint tint is reserved for dark backgrounds.
enum MultiVibeTheme {
    static let accent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x72 / 255.0, green: 0xf7 / 255.0, blue: 0xb9 / 255.0, alpha: 1)
            : UIColor(red: 0x08 / 255.0, green: 0x74 / 255.0, blue: 0x43 / 255.0, alpha: 1)
    })
    static let background = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x07 / 255.0, green: 0x11 / 255.0, blue: 0x0f / 255.0, alpha: 1)
            : UIColor(red: 0xf5 / 255.0, green: 0xf7 / 255.0, blue: 0xf1 / 255.0, alpha: 1)
    })
}
