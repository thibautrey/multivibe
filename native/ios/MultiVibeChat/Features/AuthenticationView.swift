import SwiftUI
import AuthenticationServices
import CryptoKit

/// Invalidation stops UI/session adoption, not the bounded HTTP exchange: cancelling
/// URLSession immediately could discard tokens already issued by the server.
@MainActor @Observable final class NativeCredentialFlow {
    struct Services {
        var issue: @MainActor (String, [String: String]) async throws -> AuthReply = {
            try await ChatAPI.shared.authenticate(mode: $0, fields: $1)
        }
        var revoke: @MainActor (String) async throws -> Void = { try await ChatAPI.shared.revoke(token: $0) }
    }
    private let services: Services
    private var current: UUID?
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private(set) var busy = false
    init(services: Services = Services()) { self.services = services }

    func cancel() { current = nil; busy = false }

    func submit(mode: String, fields: [String: String],
                accept: @escaping @MainActor (NativeSession) async throws -> Void,
                challenge: @escaping @MainActor (String) -> Void,
                failure: @escaping @MainActor (Error, @escaping @MainActor () -> Bool) async -> Void,
                passkey: @escaping @MainActor (NativePasskeyOptions?) -> Void = { _ in }) {
        guard !busy else { return }
        let id = UUID(); current = id; busy = true
        tasks[id] = Task {
            defer {
                tasks[id] = nil
                if current == id { current = nil; busy = false }
            }
            do {
                let reply = try await services.issue(mode, fields)
                guard current == id else {
                    // Revoke even a partially malformed reply if it contains a token.
                    if let token = reply.refreshToken { try? await services.revoke(token) }
                    return
                }
                if reply.status == "mfa_required", let value = reply.challenge,
                   !value.isEmpty, reply.refreshToken == nil, reply.accessToken == nil {
                    passkey(reply.passkeyOptions)
                    challenge(value)
                    return
                }
                let session: NativeSession
                do {
                    guard reply.status != "mfa_required", reply.challenge == nil else { throw APIError.invalidResponse }
                    session = try reply.session()
                }
                catch {
                    if let token = reply.refreshToken { try? await services.revoke(token) }
                    throw error
                }
                // No suspension between the identity check and starting acceptance.
                // The manager persists synchronously before restoration can suspend.
                try await accept(session)
            } catch {
                guard current == id else { return }
                await failure(error, { self.current == id })
            }
        }
    }
}

struct AuthenticationView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(ConversationManager.self) private var manager
    @State private var sso = NativeSSOController()
    @State private var passkeyController = NativePasskeyController()
    @State private var passkeyOptions: NativePasskeyOptions?
    @State private var ssoTask: Task<Void, Never>?
    @State private var credentials = NativeCredentialFlow()
    @State private var signup = false
    @State private var privacyPresented = false
    @State private var authConfiguration: NativeAuthConfiguration?
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @FocusState private var focusedField: Field?
    private enum Field: Hashable { case email, password, confirmation, code }
    @State private var terms = false
    @State private var challenge: String?
    @State private var code = ""
    @State private var ssoBusy = false
    private var busy: Bool { ssoBusy || credentials.busy }
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
            ScrollView {
                VStack(spacing: 20) {
                    header
                    VStack(alignment: .leading, spacing: 18) {
                        credentialFields
                        if let message = error ?? manager.error {
                            Label(message, systemImage: "exclamationmark.circle")
                                .font(.callout).foregroundStyle(.red)
                                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
                                .accessibilityIdentifier("authenticationError")
                        }
                        Button { authenticate() } label: {
                            HStack(spacing: 10) {
                                if credentials.busy { ProgressView().tint(.white) }
                                Text(challenge != nil ? "Vérifier le code" : signup ? "Créer mon compte" : "Se connecter")
                                    .fontWeight(.semibold)
                            }.frame(maxWidth: .infinity).frame(minHeight: 32)
                        }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .buttonBorderShape(.roundedRectangle(radius: 16))
                        .disabled(!canSubmit).accessibilityIdentifier("submitAuthentication")
                    }
                    if challenge == nil {
                        VStack(spacing: 18) {
                            HStack(spacing: 16) {
                                Rectangle().fill(.primary.opacity(0.12)).frame(height: 1)
                                Text("ou").font(.caption).foregroundStyle(.secondary)
                                Rectangle().fill(.primary.opacity(0.12)).frame(height: 1)
                            }.accessibilityHidden(true)
                            ForEach(["Google", "GitHub"], id: \.self) { provider in
                                Button { authenticateSSO(provider: provider.lowercased()) } label: {
                                    Text("Continuer avec \(provider)").fontWeight(.medium)
                                        .frame(maxWidth: .infinity).frame(minHeight: 32)
                                }
                                .buttonStyle(.bordered).controlSize(.large)
                                .buttonBorderShape(.roundedRectangle(radius: 16))
                                .disabled(busy || authConfiguration?.nativeProviderSelection != true
                                    || (authConfiguration?.signupEnabled == true && !terms))
                                .accessibilityIdentifier("signInWith" + provider)
                            }
                            if !signup, authConfiguration?.signupEnabled == true { signupConsent }
                            Button("Autre fournisseur SSO") { authenticateSSO() }.disabled(busy)
                            Text("Authentification dans une fenêtre sécurisée d’iOS.")
                                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }
                    }
                    if challenge != nil, passkeyOptions != nil {
                        Button("Utiliser une passkey", systemImage: "person.badge.key") { authenticatePasskey() }
                            .buttonStyle(.bordered).controlSize(.large).disabled(busy)
                            .accessibilityIdentifier("verifyWithPasskey")
                    }
                    footer
                }
                .frame(maxWidth: 420).padding(.horizontal, 24).padding(.top, 0).padding(.bottom, 28)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(MultiVibeTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fermer la connexion", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Terminé") { focusedField = nil }
                }
            }
        }
        .sheet(isPresented: $privacyPresented) { NativePrivacyView() }
        .task { await loadConfiguration() }
        .onDisappear { credentials.cancel(); ssoTask?.cancel(); sso.cancel(); passkeyController.cancel(); passkeyOptions = nil; password = ""; confirmPassword = ""; code = ""; challenge = nil }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Image("MultiVibeMark").renderingMode(.original).resizable().scaledToFit()
                .frame(width: 64, height: 64).accessibilityHidden(true)
            Text(challenge != nil ? "Vérifiez votre identité" : signup ? "Bienvenue chez vous" : "Ravi de vous retrouver")
                .font(.title.bold()).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
            Text(challenge != nil ? "Saisissez le code de votre application d’authentification." : signup ? "Créez votre compte pour commencer à discuter." : "Connectez-vous pour reprendre la conversation.")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity)
    }

    private var credentialFields: some View {
        VStack(alignment: .leading, spacing: 16) {
            if challenge != nil {
                field("Code de vérification", icon: "lock.shield", focused: focusedField == .code) {
                    TextField("Code à six chiffres", text: $code).textContentType(.oneTimeCode).keyboardType(.numberPad)
                        .focused($focusedField, equals: .code).disabled(busy)
                }
            } else {
                field("Adresse e-mail", icon: "envelope", focused: focusedField == .email) {
                    TextField("Adresse e-mail", text: $email).textContentType(.emailAddress)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focusedField, equals: .email).submitLabel(.next)
                        .onSubmit { focusedField = .password }.disabled(busy)
                }
                field("Mot de passe", icon: "lock", focused: focusedField == .password) {
                    SecureField("Mot de passe", text: $password).textContentType(signup ? .newPassword : .password)
                        .focused($focusedField, equals: .password).submitLabel(signup ? .next : .go)
                        .onSubmit { if signup { focusedField = .confirmation } else { authenticate() } }.disabled(busy)
                }
                if signup {
                    field("Confirmation", icon: "lock", focused: focusedField == .confirmation) {
                        SecureField("Confirmer le mot de passe", text: $confirmPassword).textContentType(.newPassword)
                            .focused($focusedField, equals: .confirmation).submitLabel(.done)
                            .onSubmit { focusedField = nil }.disabled(busy)
                    }
                    Text("Conseil : utilisez une phrase de passe d’au moins 12 caractères.").font(.caption).foregroundStyle(.secondary)
                    if !confirmPassword.isEmpty && password != confirmPassword {
                        Text("Les mots de passe ne correspondent pas.").font(.caption).foregroundStyle(.red)
                    }
                    signupConsent
                } else {
                    Button("Mot de passe oublié ?") {
                        focusedField = nil
                        manager.passwordRecovery = PasswordRecoveryRequest(email: email)
                    }
                    .font(.subheadline.weight(.medium)).frame(minHeight: 44)
                    .frame(maxWidth: .infinity, alignment: .trailing).disabled(busy)
                }
            }
        }
    }

    private func field<Content: View>(_ title: String, icon: String, focused: Bool,
                                      @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.subheadline.weight(.medium)).accessibilityHidden(true)
            HStack(spacing: 12) {
                Image(systemName: icon).foregroundStyle(.secondary).frame(width: 20).accessibilityHidden(true)
                content().textFieldStyle(.plain)
            }
            .padding(.horizontal, 16).padding(.vertical, 16)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(focused ? MultiVibeTheme.accent : Color.primary.opacity(0.10), lineWidth: focused ? 2 : 1))
        }
    }

    @ViewBuilder private var signupConsent: some View {
        if let config = authConfiguration, config.signupEnabled,
           let termsUrl = config.termsUrl, let privacyUrl = config.privacyUrl {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("J’accepte les conditions d’utilisation", isOn: $terms).font(.subheadline).disabled(busy)
                Link("Conditions d’utilisation", destination: termsUrl)
                Link("Politique de confidentialité", destination: privacyUrl)
            }.font(.footnote)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("L’inscription est indisponible tant que les documents légaux ne sont pas chargés.")
                Button("Recharger les conditions") { Task { await loadConfiguration() } }.disabled(busy)
            }.font(.caption).foregroundStyle(.secondary)
        }
    }

    private var footer: some View {
        VStack(spacing: 4) {
            if challenge != nil {
                Button("Recommencer la connexion") { challenge = nil; passkeyOptions = nil; code = ""; password = ""; error = nil }
                    .disabled(busy)
            } else {
                Text(signup ? "Déjà membre de MultiVibe ?" : "Pas encore de compte ?").foregroundStyle(.secondary)
                Button(signup ? "J’ai déjà un compte" : "Créer un compte") {
                    signup.toggle(); error = nil; password = ""; confirmPassword = ""; terms = false; focusedField = nil
                }.fontWeight(.semibold).disabled(busy).frame(minHeight: 44)
            }
            Button("Confidentialité et données", systemImage: "hand.raised") { privacyPresented = true }
                .font(.caption).foregroundStyle(.secondary).frame(minHeight: 44)
        }.font(.subheadline).frame(maxWidth: .infinity)
    }

    private func loadConfiguration() async {
        terms = false
        do { authConfiguration = try await ChatAPI.shared.authenticationConfiguration() }
        catch { authConfiguration = nil; self.error = error.localizedDescription }
    }
    private func authenticateSSO(provider: String? = nil) {
        guard !busy else { return }
        ssoBusy = true; error = nil
        ssoTask = Task {
            defer { ssoBusy = false; ssoTask = nil }
            do {
                let session = try await sso.signIn(provider: provider, termsVersion: terms ? authConfiguration?.termsVersion : nil)
                do { try Task.checkCancellation() }
                catch { try? await ChatAPI.shared.revoke(token: session.refreshToken); throw error }
                try await manager.accept(session); password = ""
            } catch is CancellationError {
            } catch let failure as ASWebAuthenticationSessionError where failure.code == .canceledLogin {
            } catch { self.error = error.localizedDescription }
        }
    }
    private func authenticatePasskey() {
        guard !busy, let challenge, let options = passkeyOptions else { return }
        ssoBusy = true; error = nil; focusedField = nil
        ssoTask = Task {
            defer { ssoBusy = false; ssoTask = nil }
            do {
                let response = try await passkeyController.assertion(options: options)
                try Task.checkCancellation()
                submitCredentials(mode: "passkey", fields: ["challenge": challenge, "response": response])
            } catch is CancellationError {
            } catch let failure as ASAuthorizationError where failure.code == .canceled {
            } catch { self.error = error.localizedDescription }
        }
    }

    private func authenticate() {
        guard canSubmit else { return }
        focusedField = nil; error = nil
        let mode = challenge != nil ? "otp" : signup ? "signup" : "login"
        let fields = challenge.map { ["challenge": $0, "code": code] }
            ?? ["email": email, "password": password, "termsAccepted": terms ? "true" : "false",
                "termsVersion": authConfiguration?.termsVersion ?? ""]
        submitCredentials(mode: mode, fields: fields)
    }
    private func submitCredentials(mode: String, fields: [String: String]) {
        credentials.submit(mode: mode, fields: fields, accept: { session in
            try await manager.accept(session)
            password = ""; confirmPassword = ""
        }, challenge: { value in
            challenge = value; password = ""; confirmPassword = ""; focusedField = .code
        }, failure: { failure, isCurrent in
            if case APIError.server(409, "signup_terms_changed") = failure {
                let refreshed = try? await ChatAPI.shared.authenticationConfiguration()
                guard isCurrent() else { return }
                terms = false; authConfiguration = refreshed
                error = "Les conditions ont changé. Consultez-les et acceptez-les avant de réessayer."
            } else { error = failure.localizedDescription }
        }, passkey: { passkeyOptions = $0 })
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

    func signIn(provider: String? = nil, termsVersion: String? = nil) async throws -> NativeSession {
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
        if let provider {
            guard ["google", "github"].contains(provider) else { throw APIError.invalidResponse }
            url.queryItems?.append(URLQueryItem(name: "provider", value: provider))
            if let termsVersion { url.queryItems?.append(URLQueryItem(name: "terms_version", value: termsVersion)) }
        }
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

/// The system returns a signed WebAuthn assertion; private keys never leave the credential provider.
@MainActor @Observable final class NativePasskeyController: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var controller: ASAuthorizationController?
    private var pending: CheckedContinuation<String, Error>?
    private var window: UIWindow?
    func assertion(options: NativePasskeyOptions) async throws -> String {
        try Task.checkCancellation()
        guard controller == nil, let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .filter({ $0.activationState == .foregroundActive }).flatMap(\.windows).first(where: \.isKeyWindow) else { throw APIError.invalidResponse }
        let request = try options.request()
        self.window = window
        defer { controller = nil; self.window = nil }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                pending = continuation
                let controller = ASAuthorizationController(authorizationRequests: [request])
                self.controller = controller
                controller.delegate = self; controller.presentationContextProvider = self
                controller.performRequests()
            }
        } onCancel: { Task { @MainActor in self.cancel() } }
    }
    func cancel() { controller?.cancel(); finish(.failure(CancellationError())) }
    private func finish(_ result: Result<String, Error>) { let continuation = pending; pending = nil; continuation?.resume(with: result) }
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { window! }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard self.controller === controller else { return }; finish(.failure(error))
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard self.controller === controller else { return }
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            finish(.failure(APIError.invalidResponse)); return
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: ["id": credential.credentialID.base64URL,
                "rawId": credential.credentialID.base64URL, "type": "public-key", "clientExtensionResults": [:],
                "response": ["clientDataJSON": credential.rawClientDataJSON.base64URL,
                    "authenticatorData": credential.rawAuthenticatorData.base64URL,
                    "signature": credential.signature.base64URL, "userHandle": credential.userID.base64URL]])
            guard let response = String(data: data, encoding: .utf8) else { throw APIError.invalidResponse }
            finish(.success(response))
        } catch { finish(.failure(error)) }
    }
}
