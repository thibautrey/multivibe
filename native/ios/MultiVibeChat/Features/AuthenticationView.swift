import SwiftUI
import AuthenticationServices
import CryptoKit

struct AuthenticationView: View {
    @Environment(ConversationManager.self) private var manager
    @State private var sso = NativeSSOController()
    @State private var ssoTask: Task<Void, Never>?
    @State private var signup = false
    @State private var authConfiguration: NativeAuthConfiguration?
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @FocusState private var focusedField: Field?
    private enum Field: Hashable { case email, password, confirmation, code }
    @State private var terms = false
    @State private var challenge: String?
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    private var canSubmit: Bool {
        guard !busy else { return false }
        if challenge != nil { return code.utf8.count == 6 && code.utf8.allSatisfy { (48...57).contains($0) } }
        return !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
            && (!signup || (NativePasswordPolicy.accepts(password) && password == confirmPassword
                && terms && authConfiguration?.signupEnabled == true))
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("MultiVibe", systemImage: "bubble.left.and.bubble.right.fill")
                        .font(.largeTitle.bold()).foregroundStyle(MultiVibeTheme.accent).padding(.vertical)
                    Text("Vos modèles, vos conversations.").foregroundStyle(.secondary)
                }
                Section(signup ? "Créer un compte" : "Connexion") {
                    if challenge != nil {
                        TextField("Code à six chiffres", text: $code).textContentType(.oneTimeCode).keyboardType(.numberPad)
                            .focused($focusedField, equals: .code).disabled(busy)
                    } else {
                    TextField("Adresse e-mail", text: $email).textContentType(.emailAddress)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focusedField, equals: .email).submitLabel(.next)
                        .onSubmit { focusedField = .password }.disabled(busy)
                    SecureField("Mot de passe", text: $password).textContentType(signup ? .newPassword : .password)
                        .focused($focusedField, equals: .password).submitLabel(signup ? .next : .go)
                        .onSubmit { if signup { focusedField = .confirmation } else { authenticate() } }
                        .disabled(busy)
                    if signup {
                        SecureField("Confirmer le mot de passe", text: $confirmPassword).textContentType(.newPassword)
                            .focused($focusedField, equals: .confirmation).submitLabel(.done)
                            .onSubmit { focusedField = nil }.disabled(busy)
                        Text("Conseil : utilisez une phrase de passe d’au moins 12 caractères.").font(.caption).foregroundStyle(.secondary)
                        if !confirmPassword.isEmpty && password != confirmPassword {
                            Text("Les mots de passe ne correspondent pas.").font(.caption).foregroundStyle(.red)
                        }
                        if let config = authConfiguration, config.signupEnabled,
                           let termsUrl = config.termsUrl, let privacyUrl = config.privacyUrl {
                            Link("Conditions d’utilisation", destination: termsUrl)
                            Link("Politique de confidentialité", destination: privacyUrl)
                            Toggle("J’accepte les conditions d’utilisation", isOn: $terms).disabled(busy)
                        } else {
                            Text("L’inscription est indisponible tant que les documents légaux ne sont pas chargés.")
                            Button("Recharger les conditions") { Task { await loadConfiguration() } }.disabled(busy)
                        }
                    }
                    }
                    Button(challenge != nil ? "Vérifier le code" : signup ? "Créer mon compte" : "Se connecter") { authenticate() }
                        .disabled(!canSubmit)
                    if busy { ProgressView() }
                }
                if challenge == nil {
                    Section {
                        Button("Continuer avec le SSO", systemImage: "person.badge.key.fill") { authenticateSSO() }.disabled(busy)
                        Text("Choisissez votre fournisseur dans la fenêtre sécurisée. Les conditions et la double authentification y sont conservées.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let message = error ?? manager.error { Section { Text(message).foregroundStyle(.red) } }
                Section {
                    if challenge != nil {
                        Button("Recommencer la connexion") { challenge = nil; code = ""; password = ""; error = nil }
                    } else {
                        Button(signup ? "J’ai déjà un compte" : "Créer un compte") { signup.toggle(); error = nil; password = ""; confirmPassword = ""; terms = false; focusedField = .email }
                        if !signup { Button("Mot de passe oublié ?") { manager.passwordRecovery = PasswordRecoveryRequest(email: email) } }
                    }
                }.disabled(busy)
            }
            .scrollContentBackground(.hidden)
            .background(MultiVibeTheme.background)
            .navigationTitle(challenge != nil ? "Double authentification" : signup ? "Bienvenue" : "MultiVibe Chat")

        }
        .task { await loadConfiguration() }
        .onDisappear { ssoTask?.cancel(); sso.cancel() }
    }
    private func loadConfiguration() async {
        terms = false
        do { authConfiguration = try await ChatAPI.shared.authenticationConfiguration() }
        catch { authConfiguration = nil; self.error = error.localizedDescription }
    }
    private func authenticateSSO() {
        busy = true; error = nil
        ssoTask = Task {
            defer { busy = false; ssoTask = nil }
            do {
                let session = try await sso.signIn()
                do { try Task.checkCancellation() }
                catch { try? await ChatAPI.shared.revoke(token: session.refreshToken); throw error }
                try await manager.accept(session); password = ""
            } catch is CancellationError {
            } catch let failure as ASWebAuthenticationSessionError where failure.code == .canceledLogin {
            } catch { self.error = error.localizedDescription }
        }
    }
    private func authenticate() {
        guard canSubmit else { return }
        focusedField = nil
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                let fields = challenge.map { ["challenge": $0, "code": code] } ?? ["email": email, "password": password, "termsAccepted": terms ? "true" : "false", "termsVersion": authConfiguration?.termsVersion ?? ""]
                let reply = try await ChatAPI.shared.authenticate(mode: challenge != nil ? "otp" : signup ? "signup" : "login", fields: fields)
                if reply.status == "mfa_required", let challenge = reply.challenge { self.challenge = challenge; password = ""; confirmPassword = ""; focusedField = .code; return }
                try await manager.accept(reply.session()); password = ""; confirmPassword = ""
            } catch APIError.server(409, "signup_terms_changed") {
                await loadConfiguration()
                self.error = "Les conditions ont changé. Consultez-les et acceptez-les avant de réessayer."
            } catch { self.error = error.localizedDescription }
        }
    }
}


/// Shared recovery form for an email universal link or manual recovery. The
/// incoming token is retained only in view state, never persisted or redeemed
/// until the user explicitly submits a confirmed new password.
struct PasswordRecoveryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var email: String
    @State private var resetLink: String
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var resetSent = false
    @State private var resetCompleted = false
    @State private var busy = false
    @State private var error: String?
    init(initialEmail: String = "", initialLink: String = "") {
        _email = State(initialValue: initialEmail)
        _resetLink = State(initialValue: initialLink)
    }
    var body: some View {
        NavigationStack {
            Form {
                if resetCompleted {
                    Text("Votre mot de passe a été modifié. Reconnectez-vous avec votre nouveau mot de passe et votre double authentification éventuelle.")
                } else {
                if resetSent {
                    Text("Si un compte correspond à cette adresse, vous recevrez un lien pour choisir un nouveau mot de passe.")
                } else {
                    TextField("Adresse e-mail", text: $email).textContentType(.emailAddress)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Envoyer le lien") { requestReset() }.disabled(busy || email.isEmpty)
                }
                Section("J’ai reçu le lien") {
                    Text(PasswordResetLink.token(from: resetLink) == nil
                            ? "Copiez le lien de réinitialisation reçu par e-mail et collez-le ici."
                            : "Lien reçu. Choisissez un nouveau mot de passe pour le compte concerné. Le lien ne sera utilisé qu’après votre confirmation.")
                    SecureField("Lien de réinitialisation", text: $resetLink)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Nouveau mot de passe", text: $newPassword).textContentType(.newPassword)
                    SecureField("Confirmer le mot de passe", text: $confirmPassword).textContentType(.newPassword)
                    Text("Conseil : utilisez une phrase de passe d’au moins 12 caractères.").font(.caption).foregroundStyle(.secondary)
                    Button("Changer mon mot de passe") { completeReset() }
                        .disabled(busy || PasswordResetLink.token(from: resetLink) == nil || !NativePasswordPolicy.accepts(newPassword) || newPassword != confirmPassword)
                }
                }
                if busy { ProgressView() }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Réinitialiser le mot de passe")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Terminé") { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .onDisappear { resetLink = ""; newPassword = ""; confirmPassword = "" }
        }
    }
    private func completeReset() {
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                try await ChatAPI.shared.completePasswordReset(link: resetLink, password: newPassword)
                resetCompleted = true; resetLink = ""; newPassword = ""; confirmPassword = ""
            } catch APIError.server(400, "password_reset_invalid") {
                error = "Ce lien est invalide, expiré ou déjà utilisé, ou le mot de passe est refusé. Demandez un nouveau lien et vérifiez votre mot de passe."
            } catch { self.error = error.localizedDescription }
        }
    }
    private func requestReset() {
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await ChatAPI.shared.requestPasswordReset(email: email); resetSent = true }
            catch { self.error = error.localizedDescription }
        }
    }
}

/// The system owns the provider UI and cookies. Only the one-time first-party
/// authorization code returns to the app; provider tokens never enter it.
@MainActor @Observable final class NativeSSOController: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var authentication: ASWebAuthenticationSession?
    private var window: UIWindow?
    private var continuation: CheckedContinuation<URL, Error>?
    private var attempt: UUID?

    func signIn() async throws -> NativeSession {
        try Task.checkCancellation()
        guard attempt == nil else { throw APIError.invalidResponse }
        guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .filter({ $0.activationState == .foregroundActive }).flatMap(\.windows).first(where: \.isKeyWindow) else {
            throw APIError.invalidResponse
        }
        let id = UUID()
        attempt = id
        self.window = window
        defer { authentication = nil; self.window = nil; attempt = nil }
        let verifier = try randomToken()
        let state = try randomToken()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        var url = URLComponents(string: "https://auth.multivibe.cloud/oauth/authorize")!
        url.queryItems = [URLQueryItem(name: "client_id", value: "multivibe-ios"),
            URLQueryItem(name: "redirect_uri", value: "https://auth.multivibe.cloud/oauth/callback/ios"),
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "scope", value: "openid profile projects:read"),
            URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state)]
        let callback = try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            self.continuation = continuation
            let session = ASWebAuthenticationSession(url: url.url!, callback: .https(host: "auth.multivibe.cloud", path: "/oauth/callback/ios")) { callback, error in
                Task { @MainActor in
                    guard self.attempt == id else { return }
                    if let callback { self.finish(.success(callback)) }
                    else { self.finish(.failure(error ?? APIError.invalidResponse)) }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            authentication = session
            if !session.start() { finish(.failure(APIError.invalidResponse)) }
        }
        } onCancel: {
            Task { @MainActor in
                guard self.attempt == id else { return }
                self.cancel()
            }
        }
        try Task.checkCancellation()
        guard let parsed = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              parsed.scheme == "https", parsed.host == "auth.multivibe.cloud", parsed.port == nil,
              parsed.user == nil, parsed.password == nil, parsed.path == "/oauth/callback/ios", parsed.fragment == nil else {
            throw APIError.invalidResponse
        }
        let fields = parsed.queryItems ?? []
        guard fields.filter({ $0.name == "state" }).count == 1,
              fields.first(where: { $0.name == "state" })?.value == state,
              fields.filter({ $0.name == "code" }).count == 1,
              !fields.contains(where: { $0.name == "error" }),
              let code = fields.first(where: { $0.name == "code" })?.value,
              code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw APIError.invalidResponse }
        let issued = try await ChatAPI.shared.exchangeAuthorizationCode(code, verifier: verifier)
        if Task.isCancelled {
            // Cleanup must not inherit cancellation from the sign-in task.
            _ = await Task.detached { try? await ChatAPI.shared.revoke(token: issued.refreshToken) }.value
            throw CancellationError()
        }
        return issued
    }
    func cancel() {
        authentication?.cancel()
        finish(.failure(CancellationError()))
    }
    private func finish(_ result: Result<URL, Error>) {
        let pending = continuation
        continuation = nil
        pending?.resume(with: result)
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // The foreground window is captured before the session can start.
        window!
    }
    private func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw APIError.invalidResponse }
        return Data(bytes).base64URL
    }
}

private extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
