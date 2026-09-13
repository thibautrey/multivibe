import SwiftUI

@main struct MultiVibeChatApp: App {
    @State private var manager = ConversationManager.shared
    var body: some Scene {
        WindowGroup {
            Group {
                if manager.session == nil { AuthenticationView() }
                else { ChatView() }
            }
            .environment(manager)
            .tint(Color(red: 0.03, green: 0.46, blue: 0.26))
            .task { await manager.restore() }
        }
    }
}
