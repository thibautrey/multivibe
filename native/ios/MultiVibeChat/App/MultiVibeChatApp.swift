import SwiftUI

@main struct MultiVibeChatApp: App {
    @State private var manager = ConversationManager.shared
    var body: some Scene {
        WindowGroup {
            ChatEntryView()
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

        }
    }
}

/// Keep authentication optional until an account-backed action is requested.
/// The guest draft lives only in memory and is never automatically submitted.
struct ChatEntryView: View {
    @Environment(ConversationManager.self) private var manager
    @State private var draft = ""
    @State private var authenticationPresented = false

    var body: some View {
        Group {
            if manager.session != nil && !manager.isRestoring {
                ChatView()
            } else {
                NavigationStack {
                    ChatWelcomeView(text: $draft)
                        .background(MultiVibeTheme.background)
                        .navigationTitle("MultiVibe")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("Historique", systemImage: "sidebar.left") { authenticationPresented = true }
                                    .labelStyle(.iconOnly).disabled(manager.isRestoring)
                            }
                            ToolbarItem(placement: .topBarTrailing) {
                                Button("Se connecter") { authenticationPresented = true }
                                    .accessibilityIdentifier("openAuthentication").disabled(manager.isRestoring)
                            }
                        }
                        .safeAreaInset(edge: .bottom) { guestComposer }
                }
            }
        }
        .sheet(isPresented: $authenticationPresented) {
            AuthenticationView()
                .presentationDragIndicator(.visible)
                .overlay(alignment: .topTrailing) {
                    Button("Fermer la connexion", systemImage: "xmark.circle.fill") { authenticationPresented = false }
                        .labelStyle(.iconOnly).font(.title2).padding(16)
                }
                .sheet(item: recoveryRequest) { request in
                    PasswordRecoveryView(initialEmail: request.email, initialLink: request.link)
                }
        }
        // Recovery from a deep link works both from the chat and over the auth sheet.
        .sheet(item: Binding(get: { authenticationPresented ? nil : manager.passwordRecovery },
                             set: { manager.passwordRecovery = $0 })) { request in
            PasswordRecoveryView(initialEmail: request.email, initialLink: request.link)
        }
        .onChange(of: manager.isRestoring) { _, restoring in
            guard !restoring, manager.session != nil else { return }
            if !draft.isEmpty {
                manager.wantsNewConversation = true
                manager.pendingDraft = draft
                draft = ""
            }
            authenticationPresented = false
        }
    }

    private var recoveryRequest: Binding<PasswordRecoveryRequest?> {
        Binding(get: { manager.passwordRecovery }, set: { manager.passwordRecovery = $0 })
    }

    private var guestComposer: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Que souhaitez-vous savoir ?", text: $draft, axis: .vertical)
                .accessibilityLabel("Message").lineLimit(1...8).padding(.horizontal, 6).padding(.top, 6)
            HStack {
                if manager.isRestoring { ProgressView("Restauration…").font(.caption) }
                else { Text("Connectez-vous pour envoyer un message.").font(.caption).foregroundStyle(.secondary) }
                Spacer(minLength: 8)
                Button("Envoyer", systemImage: "arrow.up.circle.fill") { authenticationPresented = true }
                    .accessibilityIdentifier("guestSend")
                    .labelStyle(.iconOnly).font(.title).frame(minWidth: 44, minHeight: 44)
                    .disabled(manager.isRestoring || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28))
        .overlay(RoundedRectangle(cornerRadius: 28).stroke(.primary.opacity(0.08), lineWidth: 1))
        .frame(maxWidth: 760).padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity).background(MultiVibeTheme.background)
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
