import AppKit
import SwiftUI

@MainActor struct NativeHarnessConversationControls: View {
    @ObservedObject var store: NativeChatStore
    @State private var editing: DesktopHarnessReceipt?
    @State private var editingNative: NativeQueuedMessage?
    @State private var editText = ""
    private var conversation: NativeChatConversation? { store.current }
    private var queue: [DesktopHarnessReceipt] { guard let id = conversation?.id else { return [] }; return (store.runtimeQueues[id] ?? []).filter { $0.state == "queued" } }
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let conversation {
                if let session = conversation.runtimeSession { Text("\(session.harnessId)\(session.harnessVersion.map { " · " + $0 } ?? "") · \(conversation.executionTargetID == nil || conversation.executionTargetID == "local" ? "Ce Mac" : conversation.executionTargetID!) · \(session.model ?? "Modèle natif à confirmer")").font(.caption2).foregroundStyle(.secondary).lineLimit(1).textSelection(.enabled) }
                if conversation.harnessID != nil { NativeHarnessCommandSuggestions(store: store, conversationID: conversation.id) }
                if let attachments = conversation.draftAttachments, !attachments.isEmpty {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(attachments) { attachment in
                                HStack(spacing: 5) { Image(systemName: attachment.mimeType.hasPrefix("image/") ? "photo" : "doc"); Text(attachment.name).lineLimit(1); Button { store.removeAttachment(attachment.id) } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain) }.font(.caption).padding(7).background(Color.secondary.opacity(0.08), in: Capsule())
                            }
                        }
                    }
                }
                if let pending = conversation.pendingSubmissions, !pending.isEmpty {
                    HStack { Text("\(pending.count) envoi(s) conservé(s) sur ce Mac").font(.caption); Spacer(); Button("En brouillon") { store.restorePending(conversation.id) }; Button("Réessayer l’envoi") { store.retryPending(conversation.id) } }.foregroundStyle(.secondary)
                }
                ForEach(store.runtimeInteractions[conversation.id] ?? []) { interaction in NativeHarnessInteractionView(store: store, conversationID: conversation.id, interaction: interaction) }
                if !queue.isEmpty {
                    DisclosureGroup("File d’attente · \(queue.count)") {
                        ForEach(Array(queue.enumerated()), id: \.element.id) { index, receipt in
                            HStack {
                                Text(receipt.text).font(.caption).lineLimit(2); Spacer()
                                Button { reorder(index, -1) } label: { Image(systemName: "arrow.up") }.disabled(index == 0)
                                Button { reorder(index, 1) } label: { Image(systemName: "arrow.down") }.disabled(index == queue.count - 1)
                                Button { editing = receipt; editText = receipt.text } label: { Image(systemName: "pencil") }
                                Button { store.runtimeCommand(conversation.id, type: "queue_remove", value: .object(["commandId": .string(receipt.id)])) } label: { Image(systemName: "xmark") }
                            }.buttonStyle(.borderless)
                        }
                    }.font(.caption)
                }
                if let pending = conversation.nativeQueue, !pending.isEmpty {
                    DisclosureGroup("File d’attente · \(pending.count)") {
                        ForEach(pending) { item in
                            HStack {
                                Text(item.text).font(.caption).lineLimit(2); Spacer()
                                Button { store.moveNativeQueued(item.id, up: true) } label: { Image(systemName: "arrow.up") }
                                Button { store.moveNativeQueued(item.id, up: false) } label: { Image(systemName: "arrow.down") }
                                Button { editingNative = item; editText = item.text } label: { Image(systemName: "pencil") }
                                Button { store.removeNativeQueued(item.id) } label: { Image(systemName: "xmark") }
                            }.buttonStyle(.borderless)
                        }
                    }.font(.caption)
                }
                if conversation.runtimeSession?.queuePaused == true || conversation.queuePaused == true {
                    HStack { Label("File suspendue", systemImage: "pause.circle").font(.caption); Spacer(); Button("Reprendre") { store.resumeQueue() }.disabled(conversation.runtimeSession?.state == "uncertain") }
                }
            }
        }.padding(.horizontal, 22).padding(.top, 5)
        .sheet(isPresented: Binding(get: { editing != nil || editingNative != nil }, set: { if !$0 { editing = nil; editingNative = nil } })) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Modifier le message en attente").font(.headline)
                TextEditor(text: $editText).frame(minHeight: 140)
                HStack { Button("Annuler") { editing = nil; editingNative = nil }; Spacer(); Button("Enregistrer") { saveEdit() }.disabled(editText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }.padding(20).frame(width: 530)
        }
    }
    private func reorder(_ index: Int, _ delta: Int) {
        guard let id = conversation?.id else { return }; var ids = queue.map(\.id); ids.swapAt(index, index + delta)
        store.runtimeCommand(id, type: "queue_reorder", value: .object(["ids": .array(ids.map { .string($0) })]))
    }
    private func saveEdit() {
        if let receipt = editing, let id = conversation?.id {
            let preserved = receipt.command["parts"].array.filter { $0["type"].string != "text" }
            store.runtimeCommand(id, type: "queue_edit", value: .object(["commandId": .string(receipt.id), "parts": .array([.object(["type": .string("text"), "text": .string(editText)])] + preserved)]))
        }
        if let item = editingNative { store.editNativeQueued(item, text: editText) }
        editing = nil; editingNative = nil
    }
}

@MainActor private struct NativeHarnessCommandSuggestions: View {
    @ObservedObject var store: NativeChatStore
    let conversationID: UUID
    @State private var commands: [HarnessJSON] = []
    private var conversation: NativeChatConversation? { store.conversations.first { $0.id == conversationID } }
    private var prefix: String? {
        guard let draft = conversation?.draft, draft.hasPrefix("/"), !draft.contains(where: { $0.isWhitespace }) else { return nil }
        return String(draft.dropFirst()).lowercased()
    }
    var body: some View {
        Group {
            if let prefix {
                let matches = commands.filter { ($0["name"].string ?? "").lowercased().hasPrefix(prefix) }
                ForEach(Array(matches.prefix(6).enumerated()), id: \.offset) { _, command in
                    Button {
                        store.edit { $0.draft = "/" + (command["name"].string ?? "") + " " }
                    } label: {
                        HStack { Text("/" + (command["name"].string ?? "")); Text(command["description"].string ?? "").lineLimit(1).foregroundStyle(.secondary); Spacer() }.font(.caption)
                    }.buttonStyle(.borderless)
                }
            }
        }.task(id: conversation?.runtimeSessionID) {
            guard conversation?.runtimeSessionID != nil else { return }
            if let receipt = try? await store.command(conversationID, type: "inspect", value: .object(["subject": .string("commands")])), let result = receipt.result {
                commands = result.array.isEmpty ? result["commands"].array : result.array
            }
        }
    }
}

@MainActor struct NativeHarnessTimeline: View {
    let events: [DesktopHarnessEvent]
    var sessionID: String? = nil
    var target = "local"
    private var visible: [DesktopHarnessEvent] { Array(events.filter { ["tool", "plan", "compaction", "usage", "agent", "terminal.output", "notice", "retry", "reasoning", "artifact"].contains($0.type) || !$0.payload["artifacts"].array.isEmpty }.suffix(30)) }
    var body: some View {
        if !visible.isEmpty {
            DisclosureGroup("Activité du harness · \(visible.count)") {
                ForEach(visible) { event in
                    DisclosureGroup(event.type) {
                        if let sessionID { NativeHarnessAttachments(files: files(event.payload), sessionID: sessionID, target: target) }
                        Text(event.payload.display).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }.font(.caption).foregroundStyle(.secondary).padding(.vertical, 8)
        }
    }
    private func files(_ value: HarnessJSON) -> [DesktopHarnessAttachment] {
        var files = (try? value["artifacts"].decode([DesktopHarnessAttachment].self)) ?? []
        if let file = try? value["attachment"].decode(DesktopHarnessAttachment.self) { files.append(file) }
        return Dictionary(grouping: files, by: \.id).values.compactMap(\.first).sorted { $0.name < $1.name }
    }
}

@MainActor struct NativeHarnessAttachments: View {
    let files: [DesktopHarnessAttachment]
    let sessionID: String
    let target: String
    @State private var preview: NSImage?
    @State private var message: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(files) { file in
                HStack {
                    Button { Task { await open(file, save: false) } } label: { Label(file.name, systemImage: file.mimeType.hasPrefix("image/") ? "photo" : "doc") }.buttonStyle(.borderless)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)).font(.caption2).foregroundStyle(.secondary)
                    Button { Task { await open(file, save: true) } } label: { Image(systemName: "arrow.down.to.line") }.buttonStyle(.borderless).help("Enregistrer le fichier")
                }
            }
            if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
        }
        .sheet(isPresented: Binding(get: { preview != nil }, set: { if !$0 { preview = nil } })) {
            VStack { if let preview { Image(nsImage: preview).resizable().scaledToFit() }; Button("Fermer") { preview = nil } }.padding(15).frame(minWidth: 400, idealWidth: 640, minHeight: 300, idealHeight: 500)
        }
    }
    private func open(_ file: DesktopHarnessAttachment, save: Bool) async {
        do {
            let response = try await DesktopHarnessClient.shared.call("/sessions/\(sessionID)/attachments/\(file.id)", target: target)
            guard let base64 = response["base64"].string, let data = Data(base64Encoded: base64) else { throw DesktopHarnessError.invalidResponse }
            if !save, file.mimeType.hasPrefix("image/"), let image = NSImage(data: data) { preview = image; return }
            let panel = NSSavePanel(); panel.nameFieldStringValue = file.name
            if panel.runModal() == .OK, let url = panel.url { try data.write(to: url, options: .atomic) }
        } catch { message = error.localizedDescription }
    }
}
