import AppKit
import SwiftUI

@MainActor struct NativeAccountPickerView: View {
    @ObservedObject var identity: NativeDesktopIdentity
    @State private var pin = ""
    @State private var settings = false
    private var pending: NativeCloudProfile? { identity.profiles.first { $0.id == identity.pendingAccountID } }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 28)
                .padding(.top, 26)
                .padding(.bottom, 24)

            if identity.scanning {
                scanningStatus
                    .padding(.horizontal, 28)
                    .padding(.bottom, 18)
            }

            if let pending {
                pinEntry(for: pending)
                    .padding(.horizontal, 28)
                    .padding(.bottom, 28)
            } else {
                accountList
                    .padding(.horizontal, 28)
                    .padding(.bottom, 24)

                if !identity.profiles.isEmpty {
                    Divider()
                    askEveryTime
                        .padding(.horizontal, 28)
                        .padding(.vertical, 25)

                    if let active = identity.activeProfile {
                        Divider()
                        accountActions(for: active)
                            .padding(.horizontal, 28)
                            .padding(.vertical, 17)
                    }
                }
            }
        }
        .frame(width: 540).background(ChatPalette.canvas)
        .interactiveDismissDisabled(identity.requiresSelection || identity.working)
        .sheet(isPresented: $settings) { NativeAccountSettingsView(identity: identity) }
        .onChange(of: identity.pendingAccountID) { _ in pin = "" }
        .onChange(of: identity.requiresSelection) { required in if required { settings = false } }
        .disabled(identity.working)
    }
    private func submitPIN(_ profile: NativeCloudProfile) {
        guard pin.count == 4, !identity.working else { return }
        let value = pin; pin = ""
        Task { await identity.unlock(profile.id, pin: value) }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Votre espace MultiVibe")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(ChatPalette.accent)
                    .textCase(.uppercase)
                    .tracking(1.6)
                Text(pending == nil ? "Qui utilise MultiVibe ?" : "Bonjour, \(pending!.displayName)")
                    .font(.system(size: 21, weight: .semibold))
                Text(pending == nil ? "Choisissez un compte pour continuer." : "Saisissez votre PIN à 4 chiffres pour ouvrir ce compte.")
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if !identity.requiresSelection {
                Button { identity.showsPicker = false } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .medium))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(ChatActionStyle())
                .foregroundStyle(.secondary)
                .accessibilityLabel("Fermer le choix de compte")
            }
        }
    }

    private var scanningStatus: some View {
        HStack(spacing: 11) {
            ProgressView().controlSize(.small)
            VStack(alignment: .leading, spacing: 3) {
                Text("Je regarde qui est là…").fontWeight(.medium)
                Text("La caméra s’éteindra dans quelques secondes.").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Choisir moi-même") { identity.openPicker() }.buttonStyle(.borderless)
        }
        .padding(14)
        .background(ChatPalette.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private func pinEntry(for profile: NativeCloudProfile) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            SecureField("PIN à 4 chiffres", text: $pin)
                .textFieldStyle(.roundedBorder)
                .onChange(of: pin) { value in pin = String(value.filter { $0.isASCII && $0.isNumber }.prefix(4)) }
                .onSubmit { submitPIN(profile) }
            HStack {
                Button("Autre compte") { identity.pendingAccountID = nil; identity.error = nil; pin = "" }
                Spacer()
                Button("Déverrouiller") { submitPIN(profile) }
                    .buttonStyle(.borderedProminent).disabled(pin.count != 4 || identity.working)
            }
            operationStatus
        }
        .padding(18)
        .background(ChatPalette.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).strokeBorder(ChatPalette.hairline, lineWidth: 1))
    }

    private var accountList: some View {
        VStack(alignment: .leading, spacing: 11) {
            if identity.profiles.isEmpty {
                Text("Connectez votre premier compte. Vous pourrez en ajouter d’autres ici.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(identity.profiles) { profile in accountCard(profile) }
                    }
                }
                .frame(maxHeight: 250)
            }
            addAccountButton
            operationStatus
        }
    }

    private func accountCard(_ profile: NativeCloudProfile) -> some View {
        let active = profile.id == identity.activeProfile?.id
        return Button { identity.choose(profile) } label: {
            HStack(spacing: 15) {
                avatar(profile.displayName)
                VStack(alignment: .leading, spacing: 7) {
                    Text(profile.displayName)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.primary)
                    HStack(spacing: 7) {
                        Circle().fill(ChatPalette.accent.opacity(0.82)).frame(width: 6, height: 6)
                        Text("Compte connecté").font(.system(size: 13)).foregroundStyle(.secondary)
                        if profile.hasPIN {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .accessibilityLabel("Protégé par PIN")
                        }
                    }
                }
                Spacer(minLength: 12)
                if active {
                    Text("Compte actuel")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(ChatPalette.accent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(ChatPalette.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(ChatPalette.accent.opacity(0.12), lineWidth: 1))
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(active ? ChatPalette.accent.opacity(0.72) : Color.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 15)
            .contentShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        }
        .buttonStyle(.plain)
        .background(active ? ChatPalette.accent.opacity(0.065) : ChatPalette.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).strokeBorder(active ? ChatPalette.accent.opacity(0.20) : ChatPalette.hairline, lineWidth: 1))
        .accessibilityLabel("Choisir \(profile.displayName)\(active ? ", compte actuel" : "")\(profile.hasPIN ? ", PIN requis" : "")")
    }

    private var addAccountButton: some View {
        Button { Task { await identity.addAccount() } } label: {
            Label("Ajouter un compte MultiVibe Cloud", systemImage: "plus.circle")
                .font(.system(size: 14, weight: .medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .contentShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).strokeBorder(ChatPalette.hairline, style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
        .accessibilityHint("Ouvre la connexion MultiVibe Cloud")
    }

    private var operationStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            if identity.working { ProgressView("Ouverture du compte…").controlSize(.small) }
            if let error = identity.error { Text(error).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        }
    }

    private var askEveryTime: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 9) {
                Text("Toujours demander le compte").font(.system(size: 14, weight: .semibold))
                Text("Afficher ce choix au lancement et après 10 minutes d’inactivité. Utile si vous partagez cet appareil.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .lineSpacing(3)
            }
            Spacer(minLength: 0)
            Toggle("", isOn: Binding(get: { identity.asksEveryTime }, set: { identity.setAsksEveryTime($0) }))
                .labelsHidden()
                .toggleStyle(.switch)
        }
    }

    private func accountActions(for profile: NativeCloudProfile) -> some View {
        HStack {
            Button { identity.error = nil; settings = true } label: {
                Label("Réglages de \(profile.displayName)", systemImage: "gearshape")
            }
            Spacer()
            Button { identity.lock() } label: { Label("Verrouiller", systemImage: "lock") }
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
    }

    private func avatar(_ name: String) -> some View {
        Text(String(name.prefix(1)).uppercased()).font(.system(size: 19, weight: .semibold))
            .foregroundStyle(ChatPalette.accent).frame(width: 48, height: 48)
            .background(ChatPalette.accent.opacity(0.12), in: Circle())
    }
}

@MainActor private struct NativeAccountSettingsView: View {
    @ObservedObject var identity: NativeDesktopIdentity
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var editingPIN = false
    @State private var appearanceSetup = false
    @State private var confirmingRemoval = false
    @State private var confirmingFaceRemoval = false

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack { Text("Votre compte sur ce Mac").font(.title2.weight(.semibold)); Spacer(); Button("Terminé") { dismiss() } }
            VStack(alignment: .leading, spacing: 9) {
                Text("Nom dans le sélecteur").font(.headline)
                HStack {
                    TextField("Prénom ou nom du compte", text: $name).textFieldStyle(.roundedBorder).onSubmit { identity.rename(name) }
                    Button("Enregistrer") { identity.rename(name) }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            Divider()
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Label("PIN à 4 chiffres", systemImage: "lock").font(.headline)
                    Text(identity.activeProfile?.hasPIN == true ? "Demandé à chaque déverrouillage, même avec la caméra." : "Optionnel, pour protéger l’ouverture de ce compte.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button(identity.activeProfile?.hasPIN == true ? "Modifier…" : "Configurer…") { editingPIN = true; identity.error = nil }
            }
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                Label("Reconnaître mon apparence", systemImage: "camera").font(.headline)
                Text("Au retour dans MultiVibe, la caméra peut choisir votre compte en quelques secondes. Les signatures restent dans le Trousseau de ce Mac ; aucune photo n’est conservée ni envoyée.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Toggle("Activer au premier plan", isOn: Binding(get: { identity.cameraEnabled }, set: { enabled in
                    if enabled && !identity.enrolled { appearanceSetup = true }
                    else { identity.setCameraEnabled(enabled) }
                })).toggleStyle(.switch)
                HStack {
                    Button(identity.enrolled ? "Refaire mon apparence…" : "Enregistrer mon apparence…") { appearanceSetup = true }
                    Spacer()
                    if identity.enrolled { Button("Effacer mon apparence", role: .destructive) { confirmingFaceRemoval = true }.buttonStyle(.borderless) }
                }
            }
            Divider()
            HStack {
                Button("Retirer ce compte de ce Mac…", role: .destructive) { confirmingRemoval = true }.buttonStyle(.borderless)
                Spacer()
            }
            if let error = identity.error { Text(error).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        }.padding(28).frame(width: 540).background(ChatPalette.canvas)
            .onAppear { name = identity.activeProfile?.displayName ?? "" }
            .sheet(isPresented: $editingPIN) { NativeAccountPINEditor(identity: identity) }
            .sheet(isPresented: $appearanceSetup) { NativeAppearanceOnboarding(identity: identity) }
            .confirmationDialog("Retirer ce compte de ce Mac ?", isPresented: $confirmingRemoval, titleVisibility: .visible) {
                Button("Retirer le compte", role: .destructive) { Task { await identity.forgetActiveAccount(); if identity.activeProfile == nil { dismiss() } } }
                Button("Annuler", role: .cancel) {}
            } message: { Text("La session et l’apparence enregistrées sur ce Mac seront supprimées. Votre compte Cloud et ses conversations seront conservés.") }
            .confirmationDialog("Effacer votre apparence de ce Mac ?", isPresented: $confirmingFaceRemoval, titleVisibility: .visible) {
                Button("Effacer mon apparence", role: .destructive) { identity.deleteAppearance() }
                Button("Annuler", role: .cancel) {}
            }
    }
}

@MainActor private struct NativeAccountPINEditor: View {
    @ObservedObject var identity: NativeDesktopIdentity
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var pin = ""
    @State private var confirmation = ""
    private var protected: Bool { identity.activeProfile?.hasPIN == true }
    private func valid(_ value: String) -> Bool { value.utf8.count == 4 && value.utf8.allSatisfy { (48...57).contains($0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 17) {
            Text(protected ? "Modifier votre PIN" : "Créer votre PIN").font(.title2.weight(.semibold))
            Text("Choisissez 4 chiffres. Ils seront demandés pour ouvrir ce compte sur ce Mac.").foregroundStyle(.secondary)
            if protected { SecureField("PIN actuel", text: $current).textFieldStyle(.roundedBorder) }
            SecureField("Nouveau PIN à 4 chiffres", text: $pin).textFieldStyle(.roundedBorder)
            SecureField("Confirmer les 4 chiffres", text: $confirmation).textFieldStyle(.roundedBorder)
            if !confirmation.isEmpty && pin != confirmation { Text("Les deux PIN doivent être identiques.").font(.caption).foregroundStyle(.secondary) }
            if let error = identity.error { Text(error).foregroundStyle(.red).font(.callout) }
            HStack {
                if protected {
                    Button("Supprimer le PIN", role: .destructive) { Task { if await identity.savePIN(nil, current: current) { dismiss() } } }
                        .disabled(!valid(current) || identity.working)
                }
                Spacer()
                Button("Annuler") { dismiss() }
                Button("Enregistrer") {
                    let value = pin, previous = current; pin = ""; confirmation = ""; current = ""
                    Task { if await identity.savePIN(value, current: previous) { dismiss() } }
                }.buttonStyle(.borderedProminent).disabled(!valid(pin) || pin != confirmation || (protected && !valid(current)) || identity.working)
            }
        }.padding(28).frame(width: 420).interactiveDismissDisabled(identity.working)
            .onDisappear { current = ""; pin = ""; confirmation = "" }
    }
}

@MainActor struct NativeAppearanceOnboarding: View {
    @ObservedObject var identity: NativeDesktopIdentity
    @ObservedObject private var camera: NativeFaceRecognition
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var started = false
    @State private var samples: [[Float]] = []
    @State private var capturing = false
    @State private var completed = false
    @State private var error: String?
    @State private var captureTask: Task<Void, Never>?
    @State private var accountID: String?
    private let poses = ["Regardez droit devant vous", "Tournez légèrement à gauche", "Tournez légèrement à droite", "Levez un peu le menton", "Baissez un peu le menton"]
    private let icons = ["person.crop.circle", "arrow.turn.up.left", "arrow.turn.up.right", "arrow.up", "arrow.down"]
    init(identity: NativeDesktopIdentity) {
        self.identity = identity; _camera = ObservedObject(wrappedValue: identity.camera)
    }
    var body: some View {
        VStack(spacing: 20) {
            HStack { Text("Votre apparence").font(.headline); Spacer(); Text(completed ? "Terminé" : (started ? "\(min(samples.count + 1, 5)) / 5" : "Optionnel")).foregroundStyle(.secondary) }
            ZStack {
                Circle().fill(ChatPalette.accent.opacity(0.07))
                if let preview = camera.preview, capturing {
                    Image(nsImage: preview).resizable().scaledToFill().frame(width: 200, height: 200).clipShape(Circle())
                } else {
                    Image(systemName: completed ? "checkmark" : (started ? icons[min(samples.count, 4)] : "camera.viewfinder"))
                        .font(.system(size: 58, weight: .light)).foregroundStyle(ChatPalette.accent)
                }
                Circle().trim(from: 0, to: completed ? 1 : Double(samples.count) / 5)
                    .stroke(ChatPalette.accent, style: StrokeStyle(lineWidth: 4, lineCap: .round)).rotationEffect(.degrees(-90))
            }.frame(width: 200, height: 200).clipped().accessibilityHidden(true)
            Text(completed ? "C’est prêt, \(identity.activeProfile?.displayName ?? "vous") !" : (started ? poses[min(samples.count, 4)] : "MultiVibe peut vous reconnaître"))
                .font(.system(size: 25, weight: .semibold)).multilineTextAlignment(.center)
            Text(completed ? "Au retour dans MultiVibe, la caméra cherchera votre compte puis s’éteindra. Vous pouvez désactiver cette option ou effacer votre apparence à tout moment." : (started ? "Restez seul dans le cadre, avec le visage bien éclairé. Cliquez quand vous êtes prêt." : "Cinq petites prises de vue suffisent. Elles restent en mémoire le temps du réglage ; seules des signatures de votre visage sont enregistrées dans le Trousseau de ce Mac."))
                .foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            if started && !completed {
                HStack(spacing: 8) { ForEach(0..<5) { index in Circle().fill(index < samples.count ? ChatPalette.accent : Color.secondary.opacity(0.2)).frame(width: 8, height: 8) } }
            }
            if capturing { HStack { ProgressView().controlSize(.small); Text(camera.message).font(.callout) } }
            if let error { Text(error).font(.callout).foregroundStyle(.red).multilineTextAlignment(.center) }
            HStack {
                if !completed { Button(started ? "Annuler" : "Plus tard") { dismiss() } }
                Spacer()
                Button(completed ? "Terminer" : (started ? "Prendre cette vue" : "Commencer")) {
                    if completed { dismiss() }
                    else if !started { started = true }
                    else { capture() }
                }.buttonStyle(.borderedProminent).controlSize(.large).disabled(capturing)
            }
            if !started { Text("La caméra s’allumera uniquement pendant les prises de vue, puis quelques secondes au retour au premier plan.").font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center) }
        }.padding(30).frame(width: 480).background(ChatPalette.canvas)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: samples.count)
            .onAppear { accountID = identity.session?.accountID; identity.beginAppearanceSetup() }
            .onDisappear { captureTask?.cancel(); samples = []; identity.endAppearanceSetup() }
            .onChange(of: identity.requiresSelection) { required in if required { dismiss() } }
    }
    private func capture() {
        guard !capturing, let accountID else { return }
        capturing = true; error = nil
        captureTask = Task { @MainActor in
            defer { capturing = false; captureTask = nil }
            do {
                let sample = try await camera.captureSample()
                try Task.checkCancellation()
                if let first = samples.first {
                    let distance = zip(first, sample).reduce(Float(0)) { $0 + pow($1.0 - $1.1, 2) }.squareRoot()
                    guard sample.count == first.count, distance < 0.65 else {
                        error = "Revenez un peu vers le centre, puis réessayez avec la même personne."
                        return
                    }
                }
                let next = samples + [sample]
                if next.count == 5 { try identity.saveAppearance(next, accountID: accountID); completed = true; camera.cancel() }
                samples = next
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}
