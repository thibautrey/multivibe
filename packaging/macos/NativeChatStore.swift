import Foundation
import Combine

struct NativeChatMessage: Codable, Identifiable, Equatable {
    var id = UUID()
    var role: String
    var content: String
    var interrupted = false
}

struct NativeChatConversation: Codable, Identifiable {
    var id = UUID()
    var title = "Nouvelle conversation"
    var model = ""
    var messages: [NativeChatMessage] = []
    var updatedAt = Date()
    var draft = ""
    var harnessID: String?
    var harnessSessionID: String?
}

/// Device-owned history; provider credentials are never stored here.
@MainActor final class NativeChatStore: ObservableObject {
    static let defaultHarnessKey = "assistantDefaultHarness"
    static var defaultHarnessID: String {
        get { let value = UserDefaults.standard.string(forKey: defaultHarnessKey) ?? "native"; return value == "computer-use" ? "native" : value }
        set { UserDefaults.standard.set(newValue, forKey: defaultHarnessKey) }
    }
    @Published var conversations: [NativeChatConversation] = []
    @Published var selection: UUID?
    @Published var error: String?
    @Published var generating: UUID?
    let computer = ComputerUseController()
    private var task: Task<Void, Never>?
    private let file: URL
    private var canSave = true

    init(file: URL? = nil) {
        self.file = file ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MultiVibe/NativeChat/conversations.json")
        do {
            if FileManager.default.fileExists(atPath: self.file.path) {
                let data = try Data(contentsOf: self.file)
                conversations = try JSONDecoder().decode([NativeChatConversation].self, from: data)
                for index in conversations.indices where conversations[index].harnessID == "computer-use" { conversations[index].harnessID = nil; conversations[index].harnessSessionID = nil }
            }
        } catch {
            canSave = false
            self.error = "L’historique ne peut pas être lu. Le fichier original est préservé : \(error.localizedDescription)"
        }
        selection = conversations.first?.id
        computer.onStop = { [weak self] in self?.task?.cancel() }
    }
    var current: NativeChatConversation? { conversations.first { $0.id == selection } }
    func newConversation(text: String = "") {
        if text.isEmpty, let index = conversations.firstIndex(where: { $0.messages.isEmpty && $0.draft.isEmpty }) {
            conversations[index].model = HostAssistantClient.shared.defaultModel
            let harness = Self.defaultHarnessID
            conversations[index].harnessID = harness == "native" ? nil : harness
            conversations[index].harnessSessionID = nil
            conversations[index].updatedAt = Date()
            selection = conversations[index].id
            save()
            return
        }
        var item = NativeChatConversation()
        item.model = HostAssistantClient.shared.defaultModel
        let harness = Self.defaultHarnessID
        item.harnessID = harness == "native" ? nil : harness
        item.draft = text
        conversations.insert(item, at: 0); selection = item.id
        save()
    }
    func edit(_ change: (inout NativeChatConversation) -> Void) {
        guard let i = conversations.firstIndex(where: { $0.id == selection }) else { return }
        change(&conversations[i]); save()
    }
    func delete(_ id: UUID) {
        guard generating != id else { return }
        conversations.removeAll { $0.id == id }
        if selection == id { selection = conversations.first?.id }
        save()
    }
    func save() {
        guard canSave else { return }
        do {
            let folder = file.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try JSONEncoder().encode(conversations).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { self.error = "Enregistrement impossible : \(error.localizedDescription)" }
    }
    func stop() { task?.cancel(); if computer.running { computer.stop() } }
    func send(retry: Bool = false, interactiveAnswers: Bool = true) {
        guard generating == nil, let i = conversations.firstIndex(where: { $0.id == selection }) else { return }
        let prompt = conversations[i].draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !conversations[i].model.isEmpty else { error = "Choisissez un modèle."; return }
        if retry {
            guard conversations[i].messages.last?.role == "assistant", conversations[i].messages.last?.interrupted == true else { return }
            conversations[i].messages.removeLast()
        } else {
            guard !prompt.isEmpty, prompt.count <= 32_000 else { error = "Saisissez entre 1 et 32 000 caractères."; return }
            conversations[i].messages.append(NativeChatMessage(role: "user", content: prompt))
            conversations[i].draft = ""
            if conversations[i].messages.count == 1 { conversations[i].title = String(prompt.prefix(65)) }
        }
        let id = conversations[i].id, model = conversations[i].model
        let harnessID = conversations[i].harnessID
        let harnessSessionID = conversations[i].harnessSessionID
        let messages = conversations[i].messages
        conversations[i].messages.append(NativeChatMessage(role: "assistant", content: "", interrupted: true))
        conversations[i].updatedAt = Date()
        generating = id; error = nil; save()
        task = Task { @MainActor in
            defer { generating = nil; task = nil; save() }
            do {
                if let harnessID, harnessID != "native", harnessID != "computer-use" {
                    let harnessPrompt = retry ? (messages.last(where: { $0.role == "user" })?.content ?? "") : prompt
                    let sessionID = try await NativeHarnessClient.shared.stream(
                        harnessID: harnessID, conversationID: id, prompt: interactiveAnswers ? NativeInteractiveDocument.prompt(harnessPrompt) : harnessPrompt, model: model,
                        sessionID: harnessSessionID
                    ) { text in self.updateStreamedReply(text, conversationID: id) }
                    if let index = conversations.firstIndex(where: { $0.id == id }), let sessionID {
                        conversations[index].harnessSessionID = sessionID
                    }
                } else {
                    let requestMessages = messages.map { ["role": $0.role, "content": $0.content] }
                    let prepared = interactiveAnswers ? NativeInteractiveDocument.messages(requestMessages) : requestMessages
                    if model == AppleFoundationModel.id {
                        try await HostAssistantClient.shared.stream(prepared, model: model) { text in self.updateStreamedReply(text, conversationID: id) }
                    } else {
                        try await computer.run(conversation: id, messages: prepared, model: model,
                            turn: { context, model in try await HostAssistantClient.shared.computerTurn(context, model: model) },
                            update: { text in self.updateStreamedReply(text, conversationID: id) })
                    }
                }
                if let index = conversations.firstIndex(where: { $0.id == id }) {
                    conversations[index].messages[conversations[index].messages.count - 1].interrupted = false
                }
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }

    private func updateStreamedReply(_ text: String, conversationID: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationID }),
              let last = conversations[index].messages.indices.last else { return }
        conversations[index].messages[last].content = text
    }
}
