import SwiftUI

@main struct MultiVibeChatApp: App {
    @UIApplicationDelegateAdaptor(ModelDownloadAppDelegate.self) private var downloadDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var manager = ConversationManager.shared
    @State private var sdkAuthorization: SDKAuthorizationRequest?
    var body: some Scene {
        WindowGroup {
            ChatEntryView()
            .environment(manager)
            .alert("Modèles sur cet appareil", isPresented: Binding(get: { LocalModelLibrary.shared.storageError != nil }, set: { if !$0 { LocalModelLibrary.shared.storageError = nil } })) {
                Button("OK") { LocalModelLibrary.shared.storageError = nil }
            } message: { Text(LocalModelLibrary.shared.storageError ?? "") }
            .tint(MultiVibeTheme.accent)
            .task { LocalModelLibrary.shared.start(); await manager.restoreForNativeEntry(); if manager.session != nil { await manager.reloadModels() } }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { Task { await DownloadedModelRuntime.shared.unload() } }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
                Task { await DownloadedModelRuntime.shared.unload() }
            }
            .sheet(item: $sdkAuthorization) { request in SDKConsentView(request: request).environment(manager) }
            .onOpenURL { url in
                if let request = SDKAuthorizationRequest(url: url) { sdkAuthorization = request; return }
                guard let request = PasswordRecoveryRequest(url: url) else { return }
                manager.voice.silence()
                // Do not replace a form while the user is entering a password
                // or while a reset request may be in flight.
                guard manager.passwordRecovery == nil else { return }
                manager.passwordRecovery = request
            }

        }
    }
}

/// Local chat and its history are available before any account is created.
struct ChatEntryView: View {
    @Environment(ConversationManager.self) private var manager
    var body: some View {
        @Bindable var manager = manager
        Group {
            if manager.isRestoring {
                VStack(spacing: 18) {
                    Image("MultiVibeMark").resizable().scaledToFit().frame(width: 78, height: 78)
                        .symbolEffect(.breathe, options: .repeating)
                    ProgressView("Ouverture des conversations…")
                }.frame(maxWidth: .infinity, maxHeight: .infinity).background(MultiVibeTheme.background)
            }
            else { ChatView() }
        }
        .sheet(isPresented: $manager.authenticationPresented) {
            AuthenticationView().presentationDragIndicator(.visible)
                .sheet(item: $manager.passwordRecovery) { request in
                    PasswordRecoveryView(initialEmail: request.email, initialLink: request.link)
                }
        }
        .sheet(item: Binding(get: { manager.authenticationPresented ? nil : manager.passwordRecovery },
                             set: { manager.passwordRecovery = $0 })) { request in
            PasswordRecoveryView(initialEmail: request.email, initialLink: request.link)
        }
        .onChange(of: manager.session?.accountId) { _, account in
            if account != nil { manager.authenticationPresented = false }
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
    static let warmAccent = Color(red: 0.91, green: 0.58, blue: 0.27)
    static let background = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x07 / 255.0, green: 0x11 / 255.0, blue: 0x0f / 255.0, alpha: 1)
            : UIColor(red: 0xf5 / 255.0, green: 0xf7 / 255.0, blue: 0xf1 / 255.0, alpha: 1)
    })
    static let card = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x10 / 255.0, green: 0x20 / 255.0, blue: 0x1c / 255.0, alpha: 0.94)
            : UIColor(white: 1, alpha: 0.9)
    })
    static let softAccent = LinearGradient(colors: [accent.opacity(0.16), accent.opacity(0.035)], startPoint: .topLeading, endPoint: .bottomTrailing)
}
