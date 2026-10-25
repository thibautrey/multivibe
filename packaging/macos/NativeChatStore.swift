import Foundation
import Combine
import CryptoKit
import UniformTypeIdentifiers

struct NativeChatMessage: Codable, Identifiable, Equatable {
    var id = UUID()
    var role: String
    var content: String
    var interrupted = false
    var parts: [DesktopMessagePart]?
    var runtimeTurnID: String?
    var runtimeTextParts: [String: String]?
    var runtimeTextOrder: [String]?
    var attachedFiles: [DesktopHarnessAttachment]?
}

struct NativeQueuedMessage: Codable, Identifiable {
    var id = UUID()
    let text: String
    let model: String
    let interactiveAnswers: Bool
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
    var executionTargetID: String?
    var authMode: String?
    var workspace: String?
    var runtimeSessionID: String?
    var runtimeSession: DesktopHarnessSession?
    var runtimeCursor: Int?
    var runtimeEvents: [DesktopHarnessEvent]?
    var runtimeUserText: [String: String]?
    var draftAttachments: [DesktopDraftAttachment]?
    var pendingSubmissions: [DesktopPendingSubmission]?
    var nativeQueue: [NativeQueuedMessage]?
    var queuePaused: Bool?
    var pinned: Bool?
    var archived: Bool?
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
    @Published private(set) var activeConversations: Set<UUID> = []
    @Published private(set) var runtimeQueues: [UUID: [DesktopHarnessReceipt]] = [:]
    @Published private(set) var runtimeInteractions: [UUID: [DesktopHarnessInteraction]] = [:]
    var generating: UUID? { if let selection, activeConversations.contains(selection) { return selection }; return activeConversations.first }
    func isGenerating(_ id: UUID?) -> Bool { id.map { activeConversations.contains($0) } ?? false }
    let computer = ComputerUseController()
    private var nativeTasks: [UUID: Task<Void, Never>] = [:]
    private var subscriptions: [UUID: Task<Void, Never>] = [:]
    private var submissions: [UUID: Task<Void, Never>] = [:]
    private var saveTask: Task<Void, Never>?
    private let runtime: any DesktopHarnessServing
    private let file: URL
    private var canSave = true

    init(file: URL? = nil, runtime: (any DesktopHarnessServing)? = nil) {
        self.runtime = runtime ?? DesktopHarnessClient.shared
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
        computer.onStop = { [weak self] in
            guard let self else { return }
            if let owner = self.computer.conversationID { self.nativeTasks[owner]?.cancel() }
        }
        for conversation in conversations where conversation.runtimeSessionID != nil { attachRuntime(conversation.id) }
    }
    var current: NativeChatConversation? { conversations.first { $0.id == selection } }
    func newConversation(text: String = "") {
        if text.isEmpty, let index = conversations.firstIndex(where: { $0.messages.isEmpty && $0.draft.isEmpty && $0.runtimeSessionID == nil && $0.pendingSubmissions?.isEmpty != false && $0.draftAttachments?.isEmpty != false && $0.nativeQueue?.isEmpty != false && $0.archived != true }) {
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
        let previous = conversations[i]
        change(&conversations[i])
        if !previous.messages.isEmpty || previous.runtimeSessionID != nil || previous.pendingSubmissions?.isEmpty == false {
            conversations[i].harnessID = previous.harnessID
            conversations[i].executionTargetID = previous.executionTargetID
            conversations[i].workspace = previous.workspace
            conversations[i].authMode = previous.authMode
        }
        save()
    }
    func delete(_ id: UUID) {
        guard !isGenerating(id) else { return }
        if let conversation = conversations.first(where: { $0.id == id }), let runtimeID = conversation.runtimeSessionID {
            Task { @MainActor in
                do { _ = try await runtime.call("/sessions/\(runtimeID)", method: "DELETE", target: conversation.executionTargetID ?? "local", body: nil); removeConversation(id) }
                catch { self.error = error.localizedDescription }
            }
            return
        }
        removeConversation(id)
    }
    private func removeConversation(_ id: UUID) {
        subscriptions.removeValue(forKey: id)?.cancel()
        conversations.removeAll { $0.id == id }
        if selection == id { selection = conversations.first?.id }
        save()
    }
    func save() {
        guard canSave else { return }
        do {
            let folder = file.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let backup = file.appendingPathExtension("before-harness-runtime")
            if FileManager.default.fileExists(atPath: file.path), !FileManager.default.fileExists(atPath: backup.path) {
                try FileManager.default.copyItem(at: file, to: backup)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: backup.path)
            }
            try JSONEncoder().encode(conversations).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { self.error = "Enregistrement impossible : \(error.localizedDescription)" }
    }
    private func saveSoon() {
        guard saveTask == nil else { return }
        saveTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            saveTask = nil; save()
        }
    }
    func stop() {
        guard let id = selection, let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index].queuePaused = true
        if conversations[index].runtimeSessionID != nil { runtimeCommand(id, type: "interrupt") }
        else { nativeTasks[id]?.cancel(); if computer.running && computer.conversationID == id { computer.stop() } }
        save()
    }
    func send(retry: Bool = false, interactiveAnswers: Bool = true) {
        guard let i = conversations.firstIndex(where: { $0.id == selection }) else { return }
        if let harnessID = conversations[i].harnessID, harnessID != "native", harnessID != "computer-use" {
            submitHarness(conversations[i].id, interactiveAnswers: interactiveAnswers)
            return
        }
        let prompt = conversations[i].draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !conversations[i].model.isEmpty else { error = "Choisissez un modèle."; return }
        if retry {
            guard !isGenerating(conversations[i].id) else { return }
            guard conversations[i].messages.last?.role == "assistant", conversations[i].messages.last?.interrupted == true else { return }
            conversations[i].messages.removeLast()
        } else {
            guard !prompt.isEmpty, prompt.count <= 32_000 else { error = "Saisissez entre 1 et 32 000 caractères."; return }
            conversations[i].draft = ""
            conversations[i].nativeQueue = (conversations[i].nativeQueue ?? []) + [NativeQueuedMessage(text: prompt, model: conversations[i].model, interactiveAnswers: interactiveAnswers)]
            save(); drainNative(conversations[i].id); return
        }
        conversations[i].queuePaused = false
        startNative(conversations[i].id, text: prompt, model: conversations[i].model, interactiveAnswers: interactiveAnswers, retry: true)
    }
    private func drainNative(_ id: UUID) {
        guard nativeTasks[id] == nil, let i = conversations.firstIndex(where: { $0.id == id }), conversations[i].queuePaused != true,
              let next = conversations[i].nativeQueue?.first else { return }
        conversations[i].nativeQueue?.removeFirst()
        startNative(id, text: next.text, model: next.model, interactiveAnswers: next.interactiveAnswers)
    }
    private func startNative(_ id: UUID, text: String, model: String, interactiveAnswers: Bool, retry: Bool = false) {
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        if !retry { conversations[i].messages.append(NativeChatMessage(role: "user", content: text)) }
        if conversations[i].messages.count == 1 { conversations[i].title = String(text.prefix(65)) }
        let messages = conversations[i].messages
        conversations[i].messages.append(NativeChatMessage(role: "assistant", content: "", interrupted: true))
        conversations[i].updatedAt = Date()
        activeConversations.insert(id); error = nil; save()
        nativeTasks[id] = Task { @MainActor in
            defer { activeConversations.remove(id); nativeTasks[id] = nil; save(); drainNative(id) }
            do {
                    let requestMessages = messages.map { ["role": $0.role, "content": $0.content] }
                    let prepared = interactiveAnswers ? NativeInteractiveDocument.messages(requestMessages) : requestMessages
                    if model == AppleFoundationModel.id {
                        try await HostAssistantClient.shared.stream(prepared, model: model) { text in self.updateStreamedReply(text, conversationID: id) }
                    } else {
                        // The Mac's graphical input is a shared resource, unlike model/harness sessions.
                        while computer.running { try await Task.sleep(nanoseconds: 100_000_000); try Task.checkCancellation() }
                        try await computer.run(conversation: id, messages: prepared, model: model,
                            turn: { context, model in try await HostAssistantClient.shared.computerTurn(context, model: model) },
                            update: { text in self.updateStreamedReply(text, conversationID: id) })
                    }
                if let index = conversations.firstIndex(where: { $0.id == id }) {
                    conversations[index].messages[conversations[index].messages.count - 1].interrupted = false
                }
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
                if let index = conversations.firstIndex(where: { $0.id == id }) { conversations[index].queuePaused = true }
            }
        }
    }

    private func updateStreamedReply(_ text: String, conversationID: UUID) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationID }),
              let last = conversations[index].messages.indices.last else { return }
        conversations[index].messages[last].content = text
    }

    func stageAttachments(_ urls: [URL], conversationID: UUID) throws {
        guard let index = conversations.firstIndex(where: { $0.id == conversationID }) else { return }
        let folder = file.deletingLastPathComponent().appendingPathComponent("HarnessAttachments")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var staged: [DesktopDraftAttachment] = []
        do {
            for url in urls {
                let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                let info = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                guard info.isRegularFile == true, (info.fileSize ?? Int.max) <= 16 * 1024 * 1024 else { throw DesktopHarnessError.rejected("Chaque pièce jointe doit être un fichier de 16 Mo maximum.") }
                let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
                let data = try handle.read(upToCount: 16 * 1024 * 1024 + 1) ?? Data()
                guard !data.isEmpty, data.count <= 16 * 1024 * 1024 else { throw DesktopHarnessError.rejected("Pièce jointe vide ou trop volumineuse.") }
                let id = UUID(), destination = folder.appendingPathComponent(id.uuidString)
                try data.write(to: destination, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                staged.append(.init(id: id, name: url.lastPathComponent, mimeType: mime, localPath: destination.path, size: data.count, sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()))
            }
            guard (conversations[index].draftAttachments?.count ?? 0) + staged.count <= 16 else { throw DesktopHarnessError.rejected("Joignez au maximum 16 fichiers par message.") }
            conversations[index].draftAttachments = (conversations[index].draftAttachments ?? []) + staged; save()
        } catch { for attachment in staged { try? FileManager.default.removeItem(atPath: attachment.localPath) }; throw error }
    }
    func removeAttachment(_ id: UUID) {
        guard let i = conversations.firstIndex(where: { $0.id == selection }), let a = conversations[i].draftAttachments?.first(where: { $0.id == id }) else { return }
        try? FileManager.default.removeItem(atPath: a.localPath); conversations[i].draftAttachments?.removeAll { $0.id == id }; save()
    }
    private func ensureRuntime(_ id: UUID) async throws -> String {
        guard let i = conversations.firstIndex(where: { $0.id == id }), let harness = conversations[i].harnessID else { throw DesktopHarnessError.invalidResponse }
        if let sessionID = conversations[i].runtimeSessionID { return sessionID }
        let conversation = conversations[i]
        var body: [String: HarnessJSON] = ["id": .string(id.uuidString.lowercased()), "harnessId": .string(harness), "targetId": .string(conversation.executionTargetID ?? "local"), "authMode": .string(conversation.authMode ?? "native"), "title": .string(conversation.title)]
        if conversation.authMode == "multivibe", !conversation.model.isEmpty { body["model"] = .string(conversation.model) }
        if let workspace = conversation.workspace, !workspace.isEmpty { body["workspace"] = .string(workspace) }
        if !conversation.messages.isEmpty {
            body["history"] = .array(conversation.messages.filter { ["user", "assistant"].contains($0.role) }.map { .object(["role": .string($0.role), "content": .string($0.content)]) })
        }
        let response = try await runtime.call("/sessions", method: "POST", target: conversation.executionTargetID ?? "local", body: .object(body))
        let session = try response["session"].decode(DesktopHarnessSession.self)
        guard let current = conversations.firstIndex(where: { $0.id == id }) else { throw DesktopHarnessError.invalidResponse }
        conversations[current].runtimeSessionID = session.id; conversations[current].runtimeSession = session
        conversations[current].harnessSessionID = session.nativeSessionId; save(); attachRuntime(id)
        return session.id
    }
    private func submitHarness(_ id: UUID, interactiveAnswers: Bool, steer: Bool = false) {
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        let text = conversations[i].draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = conversations[i].draftAttachments ?? []
        guard (!text.isEmpty || !attachments.isEmpty), text.count <= 32_000 else { error = "Saisissez un message ou joignez un fichier."; return }
        error = nil
        let submission = DesktopPendingSubmission(id: UUID(), text: interactiveAnswers && !text.isEmpty ? NativeInteractiveDocument.prompt(text) : text, attachments: attachments, intent: steer ? "steer" : "prompt", turnID: steer ? conversations[i].runtimeSession?.activeTurnId : nil, displayText: text)
        var userText = conversations[i].runtimeUserText ?? [:]; userText[submission.id.uuidString.lowercased()] = text; conversations[i].runtimeUserText = userText
        conversations[i].pendingSubmissions = (conversations[i].pendingSubmissions ?? []) + [submission]
        conversations[i].draft = ""; conversations[i].draftAttachments = []
        if conversations[i].messages.isEmpty { conversations[i].title = String((text.isEmpty ? attachments.first!.name : text).prefix(65)) }
        save(); retryPending(id)
    }
    func retryPending(_ id: UUID) {
        guard submissions[id] == nil else { return }
        activeConversations.insert(id)
        submissions[id] = Task { @MainActor in
            defer { submissions[id] = nil; if conversations.first(where: { $0.id == id })?.runtimeSession?.running != true { activeConversations.remove(id) }; save() }
            do {
                let sessionID = try await ensureRuntime(id)
                while let i = conversations.firstIndex(where: { $0.id == id }), let submission = conversations[i].pendingSubmissions?.first {
                    let target = conversations[i].executionTargetID ?? "local"
                    if let status = try? await runtime.call("/sessions/\(sessionID)/commands/\(submission.id.uuidString.lowercased())", method: "GET", target: target, body: nil),
                       let known = try? status["receipt"].decode(DesktopHarnessReceipt.self) {
                        if known.state == "failed" { throw DesktopHarnessError.rejected(known.error ?? "Envoi refusé ; conservez-le en brouillon pour le modifier.") }
                        conversations[i].pendingSubmissions?.removeAll { $0.id == submission.id }; save()
                        for attachment in submission.attachments { try? FileManager.default.removeItem(atPath: attachment.localPath) }
                        continue
                    }
                    var parts = submission.text.isEmpty ? [] : [DesktopMessagePart.text(submission.text)]
                    for a in submission.attachments {
                        let data = try Data(contentsOf: URL(fileURLWithPath: a.localPath))
                        let result = try await runtime.call("/sessions/\(sessionID)/attachments", method: "POST", target: target, body: .object(["name": .string(a.name), "mimeType": .string(a.mimeType), "sha256": .string(a.sha256), "base64": .string(data.base64EncodedString())]))
                        let attachment = try result["attachment"].decode(DesktopHarnessAttachment.self)
                        parts.append(.init(type: "attachment", attachmentId: attachment.id))
                    }
                    var command: [String: HarnessJSON] = ["id": .string(submission.id.uuidString.lowercased()), "type": .string(submission.intent ?? "prompt"), "parts": try .encode(parts)]
                    if let turnID = submission.turnID { command["turnId"] = .string(turnID) }
                    command["displayText"] = .string(submission.displayText ?? submission.text)
                    let result = try await runtime.call("/sessions/\(sessionID)/commands", method: "POST", target: target, body: .object(command))
                    let receipt = try result["receipt"].decode(DesktopHarnessReceipt.self)
                    if receipt.state == "failed" { throw DesktopHarnessError.rejected(receipt.error ?? "Envoi refusé") }
                    if let index = conversations.firstIndex(where: { $0.id == id }) { conversations[index].pendingSubmissions?.removeAll { $0.id == submission.id } }
                    for a in submission.attachments { try? FileManager.default.removeItem(atPath: a.localPath) }
                    save()
                }
                try await refreshRuntime(id)
            } catch { self.error = error.localizedDescription }
        }
    }
    func runtimeCommand(_ id: UUID, type: String, value: HarnessJSON? = nil, parts: [DesktopMessagePart]? = nil) {
        Task { @MainActor in
            do { _ = try await command(id, type: type, value: value, parts: parts); try await refreshRuntime(id) }
            catch { self.error = error.localizedDescription }
        }
    }
    func restorePending(_ id: UUID) {
        guard submissions[id] == nil, let i = conversations.firstIndex(where: { $0.id == id }), let pending = conversations[i].pendingSubmissions?.first else { return }
        conversations[i].draft = [conversations[i].draft, pending.displayText ?? pending.text].filter { !$0.isEmpty }.joined(separator: "\n\n")
        conversations[i].draftAttachments = (conversations[i].draftAttachments ?? []) + pending.attachments
        conversations[i].pendingSubmissions?.removeFirst(); save()
    }
    func command(_ id: UUID, type: String, value: HarnessJSON? = nil, parts: [DesktopMessagePart]? = nil) async throws -> DesktopHarnessReceipt {
        let sessionID = try await ensureRuntime(id)
        guard let conversation = conversations.first(where: { $0.id == id }) else { throw DesktopHarnessError.invalidResponse }
        var body: [String: HarnessJSON] = ["id": .string(UUID().uuidString.lowercased()), "type": .string(type)]
        if let value { body["value"] = value }; if let parts { body["parts"] = try .encode(parts) }
        if type == "steer", let turnID = conversation.runtimeSession?.activeTurnId { body["turnId"] = .string(turnID) }
        let response = try await runtime.call("/sessions/\(sessionID)/commands", method: "POST", target: conversation.executionTargetID ?? "local", body: .object(body))
        let receipt = try response["receipt"].decode(DesktopHarnessReceipt.self)
        guard receipt.state != "failed" else { throw DesktopHarnessError.rejected(receipt.error ?? "Commande refusée") }
        return receipt
    }
    func refreshRuntime(_ id: UUID) async throws {
        guard let conversation = conversations.first(where: { $0.id == id }), let sessionID = conversation.runtimeSessionID else { return }
        let result = try await runtime.call("/sessions/\(sessionID)", method: "GET", target: conversation.executionTargetID ?? "local", body: nil)
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        let session = try result["session"].decode(DesktopHarnessSession.self)
        conversations[i].runtimeSession = session; conversations[i].harnessSessionID = session.nativeSessionId
        runtimeQueues[id] = try result["queue"].decode([DesktopHarnessReceipt].self)
        runtimeInteractions[id] = try result["interactions"].decode([DesktopHarnessInteraction].self)
        if session.running { activeConversations.insert(id) } else if submissions[id] == nil { activeConversations.remove(id) }
        saveSoon()
    }
    private func attachRuntime(_ id: UUID) {
        guard subscriptions[id] == nil else { return }
        subscriptions[id] = Task { @MainActor in
            var delay: UInt64 = 1_000_000_000
            while !Task.isCancelled {
                guard let conversation = conversations.first(where: { $0.id == id }), let sessionID = conversation.runtimeSessionID else { break }
                do {
                    try await refreshRuntime(id)
                    try await runtime.events(sessionID: sessionID, target: conversation.executionTargetID ?? "local", after: conversation.runtimeCursor ?? 0) { [weak owner = self] event in owner?.applyRuntime(event, conversationID: id) }
                    delay = 1_000_000_000
                } catch { if Task.isCancelled { break }; if selection == id { self.error = error.localizedDescription } }
                try? await Task.sleep(nanoseconds: delay); delay = min(delay * 2, 30_000_000_000)
            }
            subscriptions[id] = nil
        }
    }
    func applyRuntime(_ event: DesktopHarnessEvent, conversationID: UUID) {
        guard let i = conversations.firstIndex(where: { $0.id == conversationID }), event.sessionId == conversations[i].runtimeSessionID, event.seq > (conversations[i].runtimeCursor ?? 0) else { return }
        conversations[i].runtimeCursor = event.seq
        let turnID = event.turnId ?? event.itemId ?? "history-\(event.seq)"
        switch event.type {
        case "session.created", "session.updated":
            if let session = try? event.payload.decode(DesktopHarnessSession.self) {
                conversations[i].runtimeSession = session; conversations[i].harnessSessionID = session.nativeSessionId
                if session.running { activeConversations.insert(conversationID) } else if submissions[conversationID] == nil { activeConversations.remove(conversationID) }
            }
        case "capabilities.updated":
            if let values = try? event.payload.decode([String: DesktopHarnessCapability].self) { conversations[i].runtimeSession?.capabilities = values }
        case "message.user":
            if !conversations[i].messages.contains(where: { $0.runtimeTurnID == turnID && $0.role == "user" }) {
                let parts = (try? event.payload["parts"].decode([DesktopMessagePart].self)) ?? []
                let text = event.payload["displayText"].string ?? conversations[i].runtimeUserText?[turnID] ?? parts.compactMap(\.text).joined(separator: "\n")
                let files = try? event.payload["attachments"].decode([DesktopHarnessAttachment].self)
                conversations[i].messages.append(.init(role: "user", content: text, parts: parts, runtimeTurnID: turnID, attachedFiles: files))
            }
        case "message.delta", "message.part":
            if !conversations[i].messages.contains(where: { $0.runtimeTurnID == turnID && $0.role == "assistant" }) { conversations[i].messages.append(.init(role: "assistant", content: "", interrupted: true, runtimeTurnID: turnID)) }
            if let index = conversations[i].messages.firstIndex(where: { $0.runtimeTurnID == turnID && $0.role == "assistant" }) {
                let key = event.itemId ?? "assistant", text = event.payload["text"].string ?? ""
                var parts = conversations[i].messages[index].runtimeTextParts ?? [:]
                var order = conversations[i].messages[index].runtimeTextOrder ?? parts.keys.sorted(); if !order.contains(key) { order.append(key) }
                parts[key] = event.type == "message.part" ? text : (parts[key] ?? "") + text
                conversations[i].messages[index].runtimeTextParts = parts
                conversations[i].messages[index].runtimeTextOrder = order
                conversations[i].messages[index].content = order.compactMap { parts[$0] }.joined(separator: "\n\n")
            }
        case "history.message":
            let role = event.payload["role"].string ?? "assistant", key = "history:" + (event.itemId ?? String(event.seq)), text = event.payload["text"].string ?? ""
            if let index = conversations[i].messages.firstIndex(where: { $0.runtimeTurnID == key && $0.role == role }) {
                conversations[i].messages[index].content = event.payload["append"] == .bool(true) ? conversations[i].messages[index].content + text : text
            } else { conversations[i].messages.append(.init(role: role, content: text, runtimeTurnID: key)) }
        case "turn.completed":
            for index in conversations[i].messages.indices where conversations[i].messages[index].runtimeTurnID == turnID { conversations[i].messages[index].interrupted = false }
        case "turn.cancelled":
            for index in conversations[i].messages.indices where conversations[i].messages[index].runtimeTurnID == turnID && conversations[i].messages[index].role == "assistant" { conversations[i].messages[index].interrupted = true }
        case "interaction.requested":
            if let interaction = try? event.payload.decode(DesktopHarnessInteraction.self) {
                runtimeInteractions[conversationID] = (runtimeInteractions[conversationID] ?? []).filter { $0.id != interaction.id } + [interaction]
                if interaction.kind == "authentication" { Task { @MainActor in try? await refreshRuntime(conversationID) } }
            }
        case "interaction.updated": runtimeInteractions[conversationID]?.removeAll { $0.id == event.payload["id"].string }
        case "command.updated":
            if let receipt = try? event.payload.decode(DesktopHarnessReceipt.self), receipt.command["type"].string == "prompt" {
                var queue = (runtimeQueues[conversationID] ?? []).filter { $0.id != receipt.id }
                if ["queued", "dispatching", "accepted", "uncertain"].contains(receipt.state) { queue.append(receipt) }
                runtimeQueues[conversationID] = queue.sorted { $0.ordinal < $1.ordinal }
            }
        case "turn.failed", "turn.uncertain": if let message = event.payload["message"].string ?? event.payload["error"].string { error = message }
        case "diagnostic": break
        default: break
        }
        if !["message.delta", "message.part", "session.updated", "command.updated"].contains(event.type) {
            conversations[i].runtimeEvents = Array(((conversations[i].runtimeEvents ?? []) + [event]).suffix(200))
        }
        conversations[i].updatedAt = Date(); saveSoon()
    }
    func resumeQueue() {
        guard let id = selection, let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        if conversations[i].runtimeSessionID != nil { runtimeCommand(id, type: "resume_queue") }
        else { conversations[i].queuePaused = false; save(); drainNative(id) }
    }
    func steer() { guard let id = selection else { return }; submitHarness(id, interactiveAnswers: false, steer: true) }
    func removeNativeQueued(_ messageID: UUID) {
        guard let i = conversations.firstIndex(where: { $0.id == selection }) else { return }
        conversations[i].nativeQueue?.removeAll { $0.id == messageID }; save()
    }
    func editNativeQueued(_ message: NativeQueuedMessage, text: String) {
        guard let i = conversations.firstIndex(where: { $0.id == selection }), let q = conversations[i].nativeQueue?.firstIndex(where: { $0.id == message.id }) else { return }
        conversations[i].nativeQueue?[q] = NativeQueuedMessage(id: message.id, text: text, model: message.model, interactiveAnswers: message.interactiveAnswers); save()
    }
    func moveNativeQueued(_ messageID: UUID, up: Bool) {
        guard let i = conversations.firstIndex(where: { $0.id == selection }), var queue = conversations[i].nativeQueue, let index = queue.firstIndex(where: { $0.id == messageID }) else { return }
        let destination = index + (up ? -1 : 1); guard queue.indices.contains(destination) else { return }; queue.swapAt(index, destination); conversations[i].nativeQueue = queue; save()
    }
    func importRuntimeSession(_ session: DesktopHarnessSession, target: String) {
        if let existing = conversations.first(where: { $0.runtimeSessionID == session.id && ($0.executionTargetID ?? "local") == target }) {
            selection = existing.id; save(); attachRuntime(existing.id); return
        }
        var id = UUID(uuidString: session.id) ?? UUID()
        if conversations.contains(where: { $0.id == id }) { id = UUID() }
        var conversation = NativeChatConversation(); conversation.id = id; conversation.title = session.title
        conversation.model = session.model ?? ""; conversation.harnessID = session.harnessId; conversation.runtimeSessionID = session.id
        conversation.runtimeSession = session; conversation.executionTargetID = target; conversation.authMode = session.authMode; conversation.workspace = session.workspace
        conversations.insert(conversation, at: 0); selection = id; save(); attachRuntime(id)
    }
}
