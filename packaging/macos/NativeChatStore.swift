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
}

/// Device-owned history; provider credentials are never stored here.
@MainActor final class NativeChatStore: ObservableObject {
    @Published var conversations: [NativeChatConversation] = []
    @Published var selection: UUID?
    @Published var error: String?
    @Published var generating: UUID?
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

            }
        } catch {
            canSave = false
            self.error = "L’historique ne peut pas être lu. Le fichier original est préservé : \(error.localizedDescription)"
        }
        selection = conversations.first?.id
    }
    var current: NativeChatConversation? { conversations.first { $0.id == selection } }
    func newConversation(text: String = "") {
        if text.isEmpty, let empty = conversations.first(where: { $0.messages.isEmpty && $0.draft.isEmpty }) { selection = empty.id; return }
        var item = NativeChatConversation()
        item.model = HostAssistantClient.shared.defaultModel
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
    func stop() { task?.cancel() }
    func send(retry: Bool = false) {
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
        let messages = conversations[i].messages
        conversations[i].messages.append(NativeChatMessage(role: "assistant", content: "", interrupted: true))
        conversations[i].updatedAt = Date()
        generating = id; error = nil; save()
        task = Task { @MainActor in
            defer { generating = nil; task = nil; save() }
            do {
                try await HostAssistantClient.shared.stream(messages.map { ["role": $0.role, "content": $0.content] }, model: model) { text in
                    guard let index = self.conversations.firstIndex(where: { $0.id == id }) else { return }
                    let last = self.conversations[index].messages.count - 1
                    self.conversations[index].messages[last].content = text
                }
                if let index = conversations.firstIndex(where: { $0.id == id }) {
                    conversations[index].messages[conversations[index].messages.count - 1].interrupted = false
                }
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }
}
