import SwiftUI

struct MemoryView: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var confirmSync = false
    @State private var forget: MemoryItem?
    @State private var project = ""
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Seuls les souvenirs validés, non expirés et sans contradiction sont utilisables. Une déclaration mémorisée n’est pas une preuve indépendante.")
                    if let error = manager.memoryError { Text(error).foregroundStyle(.red) }
                    Button("Ajouter un souvenir", systemImage: "plus") {
                        manager.memoryDraft = MemoryDraft(text: "", evidence: MemoryEvidence(origin: .userEntry,
                            quote: "", date: Date(), sourceRole: "user"), scope: manager.current?.memoryScope ?? "")
                    }.accessibilityIdentifier("addMemory")
                }
                if manager.selection != nil {
                    Section("Projet de cette conversation") {
                        TextField("Nom du projet (vide : général)", text: $project).onSubmit { manager.setMemoryScope(project) }
                        Button("Appliquer le projet") { manager.setMemoryScope(project) }
                        Text("Les souvenirs généraux et ceux de ce projet seront consultables par l’agent.")
                    }
                }
                Section("Souvenirs") {
                    ForEach(manager.memoryItems.filter { search.isEmpty || $0.id.uuidString.localizedCaseInsensitiveContains(search) || $0.memory.text.localizedCaseInsensitiveContains(search) || $0.memory.topic.localizedCaseInsensitiveContains(search) }) { item in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.memory.topic).font(.headline)
                            Text(item.memory.text)
                            Text(item.label).font(.caption).foregroundStyle(item.conflicting ? .orange : .secondary)
                            Text(item.memory.kind.label + (item.memory.scope.isEmpty ? " · Général" : " · " + item.memory.scope)).font(.caption)
                            if let evidence = item.memory.evidence {
                                DisclosureGroup("Source et date") {
                                    Text(evidence.quote).textSelection(.enabled)
                                    if let prior = evidence.priorQuote { Text("Avant votre confirmation : " + prior) }
                                    Text("Rôle initial : " + evidence.sourceRole)
                                    Text("Noté ou confirmé le " + evidence.date.formatted()).font(.caption)
                                    Text("Identifiant mémoire : " + item.id.uuidString).font(.caption)
                                }
                            }
                            if item.conflicting {
                                DisclosureGroup("Versions à comparer") {
                                    ForEach(manager.memoryRecords.filter { $0.id == item.id && $0.state != .deleted }, id: \.version) { version in
                                        Text(version.text + " — " + version.updatedAt.formatted())
                                    }
                                    Text("Corrigez le souvenir avec la version exacte à conserver, puis confirmez.")
                                }
                            }
                            HStack {
                                Button(item.memory.state == .proposed ? "Valider" : "Corriger") { manager.editMemory(item) }
                                    .frame(minHeight: 44)
                                Spacer()
                                Button("Oublier", role: .destructive) { forget = item }.frame(minHeight: 44)
                            }.buttonStyle(.borderless)
                        }.accessibilityElement(children: .contain)
                    }
                    if manager.memoryItems.isEmpty { Text("Aucun souvenir enregistré. Utilisez « Retiens ceci : … » ou le bouton Retenir d’un message.") }
                }
                Section("Synchronisation") {
                    if let status = manager.historyStatus { Text(status).font(.caption) }
                    if manager.session == nil { Text("Mémoire invitée locale. Elle n’est pas copiée automatiquement dans un compte.") }
                    else {
                        Toggle("Synchroniser la mémoire", isOn: Binding(get: { manager.memorySyncEnabled }, set: {
                            if $0 { confirmSync = true } else { manager.setMemorySync(false) }
                        }))
                        Text("Envoie les souvenirs validés et leurs sources au compte. Les corrections et oublis seront synchronisés ; les propositions restent locales. Activez aussi la synchronisation automatique de l’historique pour le retour du réseau. Désactiver ne supprime pas la copie serveur.")
                        Button("Synchroniser maintenant") { Task { await manager.synchronizeHistory() } }
                            .disabled(!manager.memorySyncEnabled)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(MultiVibeTheme.softAccent.ignoresSafeArea())
            .disabled(manager.isStreaming || manager.isRestoring || manager.isSynchronizing)
            .searchable(text: $search, prompt: "Rechercher un souvenir")
            .navigationTitle("Mémoire")
            .toolbar { Button("Terminé") { dismiss() } }
            .onAppear { project = manager.current?.memoryScope ?? "" }
            .sheet(item: Binding(get: { manager.memoryDraft }, set: { manager.memoryDraft = $0 })) { draft in
                MemoryEditor(draft: draft)
            }
            .confirmationDialog("Synchroniser vos souvenirs et leurs sources avec votre compte ?", isPresented: $confirmSync) {
                Button("Activer la synchronisation") { manager.setMemorySync(true) }
            }
            .confirmationDialog("Oublier ce souvenir ?", isPresented: Binding(get: { forget != nil }, set: { if !$0 { forget = nil } })) {
                Button("Confirmer l’oubli", role: .destructive) { if let forget { _ = manager.forgetMemory(forget.id) }; forget = nil }
            } message: { Text("Le souvenir ne sera plus utilisé et sa suppression sera synchronisée si activée. Le message original dans l’historique reste conservé.") }
        }
    }
}

struct MemoryEditor: View {
    @Environment(ConversationManager.self) private var manager
    @Environment(\.dismiss) private var dismiss
    @State var draft: MemoryDraft
    var body: some View {
        NavigationStack {
            Form {
                Section("Information à retenir") {
                    TextField("Sujet (ex. Langue préférée)", text: $draft.topic).accessibilityIdentifier("memoryTopic")
                    TextField("Souvenir", text: $draft.text, axis: .vertical).lineLimit(3...6).accessibilityIdentifier("memoryText")
                    Picker("Type", selection: $draft.kind) { ForEach(AgentMemory.Kind.allCases, id: \.self) { Text($0.label).tag($0) } }
                    TextField("Projet (vide : général)", text: $draft.scope)
                    if draft.kind == .temporary {
                        DatePicker("Valide jusqu’au", selection: Binding(get: { draft.expiresAt ?? Date().addingTimeInterval(86400) }, set: { draft.expiresAt = $0 }))
                    }
                }
                Section("Source") {
                    Text(draft.evidence.quote.isEmpty ? "Votre saisie dans cette fiche" : draft.evidence.quote).textSelection(.enabled)
                    Text("Rôle initial : " + draft.evidence.sourceRole).font(.caption)
                    Text("Vérifiez l’information avant de la valider, notamment si elle vient d’une réponse de l’assistant.")
                }
                Section {
                    Toggle("Remplacer les souvenirs contradictoires du même sujet et projet", isOn: $draft.resolveConflicts)
                    if let error = manager.memoryError { Text(error).foregroundStyle(.red) }

                }
            }
            .scrollContentBackground(.hidden)
            .background(MultiVibeTheme.softAccent.ignoresSafeArea())
            .navigationTitle(draft.replaces == nil ? "Retenir une information" : "Corriger le souvenir")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annuler") { manager.memoryDraft = nil } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Valider") {
                        if draft.evidence.quote.isEmpty { draft.evidence.quote = draft.text; draft.evidence.date = Date() }
                        _ = manager.saveMemory(draft)
                    }.disabled(draft.topic.trimmingCharacters(in: .whitespaces).isEmpty || draft.text.isEmpty)
                        .accessibilityLabel("Je confirme cette information").accessibilityIdentifier("confirmMemory")
                }
            }
        }
    }
}
