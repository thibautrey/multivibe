import SwiftUI

struct AuthenticationView: View {
    @Environment(ConversationManager.self) private var manager
    @State private var signup = false
    @State private var email = ""
    @State private var password = ""
    @State private var terms = false
    @State private var challenge: String?
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    @State private var resetPresented = false
    @State private var resetSent = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("MultiVibe", systemImage: "bubble.left.and.bubble.right.fill")
                        .font(.largeTitle.bold()).padding(.vertical)
                    Text("Vos modèles, vos conversations.").foregroundStyle(.secondary)
                }
                Section(signup ? "Créer un compte" : "Connexion") {
                    if challenge != nil {
                        TextField("Code à six chiffres", text: $code).textContentType(.oneTimeCode).keyboardType(.numberPad)
                    } else {
                    TextField("Adresse e-mail", text: $email).textContentType(.emailAddress)
                        .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Mot de passe", text: $password).textContentType(signup ? .newPassword : .password)
                    if signup {
                        Text("Au moins 12 caractères.").font(.caption).foregroundStyle(.secondary)
                        Toggle("J’accepte les conditions d’utilisation", isOn: $terms)
                        Link("Lire les conditions", destination: URL(string: "https://multivibe.cloud/terms")!)
                    }
                    }
                    Button(challenge != nil ? "Vérifier le code" : signup ? "Créer mon compte" : "Se connecter") { authenticate() }
                        .disabled(busy || (challenge != nil ? code.count != 6 : email.isEmpty || password.isEmpty || (signup && !terms)))
                    if busy { ProgressView() }
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    if challenge != nil {
                        Button("Recommencer la connexion") { challenge = nil; code = ""; password = ""; error = nil }
                    } else {
                        Button(signup ? "J’ai déjà un compte" : "Créer un compte") { signup.toggle(); error = nil }
                        if !signup { Button("Mot de passe oublié ?") { resetSent = false; resetPresented = true } }
                    }
                }.disabled(busy)
            }
            .navigationTitle(challenge != nil ? "Double authentification" : signup ? "Bienvenue" : "MultiVibe Chat")
            .sheet(isPresented: $resetPresented) {
                NavigationStack {
                    Form {
                        if resetSent {
                            Text("Si un compte correspond à cette adresse, vous recevrez un lien pour choisir un nouveau mot de passe.")
                        } else {
                            TextField("Adresse e-mail", text: $email).textContentType(.emailAddress)
                                .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Button("Envoyer le lien") { requestReset() }.disabled(busy || email.isEmpty)
                        }
                        if busy { ProgressView() }
                        if let error { Text(error).foregroundStyle(.red) }
                    }
                    .navigationTitle("Réinitialiser le mot de passe")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Terminé") { resetPresented = false }.disabled(busy) } }
                    .interactiveDismissDisabled(busy)
                }
            }
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
    private func authenticate() {
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                let fields = challenge.map { ["challenge": $0, "code": code] } ?? ["email": email, "password": password, "termsAccepted": terms ? "true" : "false"]
                let reply = try await ChatAPI.shared.authenticate(mode: challenge != nil ? "otp" : signup ? "signup" : "login", fields: fields)
                if reply.status == "mfa_required", let challenge = reply.challenge { self.challenge = challenge; password = ""; return }
                try await manager.accept(reply.session()); password = ""
            } catch { self.error = error.localizedDescription }
        }
    }
}
