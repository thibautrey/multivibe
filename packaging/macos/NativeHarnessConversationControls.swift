import AppKit
import SwiftUI

@MainActor struct NativeHarnessConversationControls: View {
    @ObservedObject var store: NativeChatStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var editing: DesktopHarnessReceipt?
    @State private var editingNative: NativeQueuedMessage?
    @State private var editText = ""
    @State private var expanded = true
    private var conversation: NativeChatConversation? { store.current }
    private var queue: [DesktopHarnessReceipt] { guard let id = conversation?.id else { return [] }; return (store.runtimeQueues[id] ?? []).filter { $0.state == "queued" } }
    private var count: Int { queue.count + (conversation?.nativeQueue?.count ?? 0) }
    private var paused: Bool { conversation?.runtimeSession?.queuePaused == true || conversation?.queuePaused == true }
    private var showsQueue: Bool { count > 0 }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let conversation {
                if conversation.harnessID != nil { NativeHarnessCommandSuggestions(store: store, conversationID: conversation.id) }
                if let attachments = conversation.draftAttachments, !attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(attachments) { attachment in
                                HStack(spacing: 8) {
                                    Image(systemName: attachment.mimeType.hasPrefix("image/") ? "photo" : "doc.text").foregroundStyle(ChatPalette.accent)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(attachment.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file)).font(.system(size: 10)).foregroundStyle(.secondary)
                                    }
                                    ChatIconButton(title: "Retirer \(attachment.name)", icon: "xmark") { store.removeAttachment(attachment.id) }
                                }.padding(.leading, 11).padding(.trailing, 3).padding(.vertical, 5)
                                    .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 10))
                            }
                        }
                    }.transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                if let pending = conversation.pendingSubmissions, !pending.isEmpty {
                    VStack(alignment: .leading, spacing: 7) {
                        Label("\(pending.count) \(pending.count == 1 ? "message conservé" : "messages conservés") sur ce Mac", systemImage: "wifi.exclamationmark").font(.system(size: 12, weight: .medium))
                        HStack {
                            Text("L’envoi reste à confirmer.").font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button("En brouillon") { store.restorePending(conversation.id) }
                            Button("Réessayer") { store.retryPending(conversation.id) }
                        }
                    }.padding(12).background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
                }
                ForEach(store.runtimeInteractions[conversation.id] ?? []) { interaction in
                    NativeHarnessInteractionView(store: store, conversationID: conversation.id, interaction: interaction)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
                if showsQueue {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 8) {
                            Button { withAnimation(ChatPalette.motion(reduceMotion)) { expanded.toggle() } } label: {
                                HStack(spacing: 7) {
                                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(expanded ? 90 : 0))
                                    Text(paused ? "File suspendue" : "À suivre").font(.system(size: 12, weight: .medium))
                                    if count > 0 { Text("\(count)").font(.system(size: 10, weight: .semibold)).padding(.horizontal, 6).padding(.vertical, 2).background(ChatPalette.subtle, in: Capsule()) }
                                }.padding(.vertical, 6)
                            }.buttonStyle(.plain).accessibilityLabel("\(paused ? "File suspendue" : "File d’attente"), \(count) messages").accessibilityValue(expanded ? "Développée" : "Repliée")
                            Spacer()
                            if paused {
                                Button("Reprendre") { store.resumeQueue() }.buttonStyle(.borderless).font(.caption.weight(.medium)).disabled(conversation.runtimeSession?.state == "uncertain")
                            } else {
                                ChatIconButton(title: "Suspendre les prochains messages", icon: "pause") {
                                    if conversation.runtimeSessionID != nil { store.runtimeCommand(conversation.id, type: "pause_queue") }
                                    else { store.edit { $0.queuePaused = true } }
                                }
                            }
                        }
                        if expanded && count > 0 {
                            ScrollView {
                                VStack(spacing: 0) {
                                    ForEach(Array(queue.enumerated()), id: \.element.id) { index, receipt in
                                        queueRow(text: receipt.text, position: index, last: index == queue.count - 1,
                                            up: { reorder(index, -1) }, down: { reorder(index, 1) },
                                            edit: { editing = receipt; editText = receipt.text },
                                            remove: { store.runtimeCommand(conversation.id, type: "queue_remove", value: .object(["commandId": .string(receipt.id)])) })
                                    }
                                    ForEach(Array((conversation.nativeQueue ?? []).enumerated()), id: \.element.id) { index, item in
                                        queueRow(text: item.text, position: index, last: index == (conversation.nativeQueue?.count ?? 0) - 1,
                                            up: { store.moveNativeQueued(item.id, up: true) }, down: { store.moveNativeQueued(item.id, up: false) },
                                            edit: { editingNative = item; editText = item.text }, remove: { store.removeNativeQueued(item.id) })
                                    }
                                }
                            }.frame(height: CGFloat(min(count, 3)) * 43).transition(.opacity)
                        }
                    }.padding(.horizontal, 12).padding(.vertical, 5)
                        .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }.padding(.horizontal, 28).padding(.top, showsQueue ? 8 : 0)
        .animation(ChatPalette.motion(reduceMotion), value: count)
        .animation(ChatPalette.motion(reduceMotion), value: conversation?.draftAttachments?.count)
        .animation(ChatPalette.motion(reduceMotion), value: conversation.map { store.runtimeInteractions[$0.id]?.count ?? 0 } ?? 0)
        .sheet(isPresented: Binding(get: { editing != nil || editingNative != nil }, set: { if !$0 { editing = nil; editingNative = nil } })) {
            VStack(alignment: .leading, spacing: 16) {
                Text("Modifier le message en attente").font(.title3.weight(.semibold))
                Text("Il gardera sa place dans la file et ses pièces jointes.").font(.callout).foregroundStyle(.secondary)
                TextEditor(text: $editText).font(.body).padding(8).frame(minHeight: 140).background(ChatPalette.canvas, in: RoundedRectangle(cornerRadius: 10))
                HStack {
                    Button("Annuler") { editing = nil; editingNative = nil }.keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("Enregistrer") { saveEdit() }.buttonStyle(.borderedProminent).disabled(editText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.padding(24).frame(width: 510).tint(ChatPalette.accent)
        }
    }
    private func queueRow(text: String, position: Int, last: Bool, up: @escaping () -> Void, down: @escaping () -> Void, edit: @escaping () -> Void, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 5) {
            Text("\(position + 1)").font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary).frame(width: 16)
            Text(text.isEmpty ? "Pièce jointe" : text).font(.system(size: 12)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            ChatIconButton(title: "Monter le message", icon: "arrow.up", action: up).disabled(position == 0)
            ChatIconButton(title: "Descendre le message", icon: "arrow.down", action: down).disabled(last)
            ChatIconButton(title: "Modifier le message", icon: "pencil", action: edit)
            ChatIconButton(title: "Retirer de la file", icon: "xmark", action: remove)
        }.frame(height: 43)
    }
    private func reorder(_ index: Int, _ delta: Int) {
        guard let id = conversation?.id, queue.indices.contains(index + delta) else { return }; var ids = queue.map(\.id); ids.swapAt(index, index + delta)
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
    var running = false
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var activities: [HarnessActivity] { HarnessPresentation.activities(events) }
    var body: some View {
        if !activities.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Button { withAnimation(ChatPalette.motion(reduceMotion)) { expanded.toggle() } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(expanded ? 90 : 0))
                        Text("Activité").font(.system(size: 12, weight: .medium))
                        Text("\(activities.count)").font(.system(size: 11)).foregroundStyle(.secondary)
                        Spacer()
                        if running { ProgressView().controlSize(.mini); Text("En cours").font(.caption).foregroundStyle(.secondary) }
                    }.padding(.vertical, 3).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Activité, \(activities.count) éléments").accessibilityValue(expanded ? "Développée" : "Repliée")
                if expanded {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(activities) { activity in HarnessActivityRow(activity: activity, sessionID: sessionID, target: target, running: running) }
                    }.transition(.opacity)
                }
            }.padding(14).background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 12))
                .onAppear { if running { expanded = true } }
        }
    }
}

@MainActor private struct HarnessActivityRow: View {
    let activity: HarnessActivity
    let sessionID: String?
    let target: String
    let running: Bool
    private var tint: Color { activity.status == .failed ? .red : activity.status == .completed ? ChatPalette.accent : .secondary }
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
                if !activity.plan.isEmpty {
                    ForEach(Array(activity.plan.enumerated()), id: \.offset) { _, step in
                        Label(step["content"].string ?? step["step"].string ?? step["text"].string ?? "Étape", systemImage: step["status"].string == "completed" ? "checkmark.circle.fill" : "circle")
                            .font(.callout).foregroundStyle(step["status"].string == "completed" ? ChatPalette.accent : Color.primary)
                    }
                }
                if let text = activity.readable, !text.isEmpty {
                    Text(text).font(activity.kind == "terminal.output" ? .system(.caption, design: .monospaced) : .callout).textSelection(.enabled).lineSpacing(4).frame(maxWidth: .infinity, alignment: .leading)
                }
                if let sessionID { NativeHarnessAttachments(files: activity.attachments, sessionID: sessionID, target: target) }
                DisclosureGroup("Données techniques") {
                    ScrollView { Text(String(activity.event.payload.display.prefix(32_000))).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 220)
                }.font(.system(size: 11)).foregroundStyle(.secondary)
            }.padding(.leading, 22).padding(.vertical, 8)
        } label: {
            HStack(spacing: 9) {
                Image(systemName: activity.icon).frame(width: 17).foregroundStyle(tint)
                Text(activity.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                Spacer(minLength: 6)
                if activity.status == .active && running { ProgressView().controlSize(.mini) }
                Text(activity.status == .active && !running ? "" : activity.statusLabel).font(.system(size: 10)).foregroundStyle(tint)
            }
        }.font(.caption).tint(.secondary)
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
