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
            .onOpenURL { url in
                guard let request = PasswordRecoveryRequest(url: url) else { return }
                manager.voice.silence()
                // Do not replace a form while the user is entering a password
                // or while a reset request may be in flight.
                guard manager.passwordRecovery == nil else { return }
                manager.passwordRecovery = request
            }
            .sheet(item: Binding(get: { manager.passwordRecovery }, set: { manager.passwordRecovery = $0 })) { request in
                PasswordRecoveryView(initialEmail: request.email, initialLink: request.link)
            }
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
