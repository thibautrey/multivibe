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
                    HStack { Text("\(pending.count) envoi(s) conservé(s) sur ce Mac").font(.caption); Spacer(); Button("Réessayer l’envoi") { store.retryPending(conversation.id) } }.foregroundStyle(.secondary)
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

@MainActor struct NativeHarnessTimeline: View {
    let events: [DesktopHarnessEvent]
    private var visible: [DesktopHarnessEvent] { Array(events.filter { ["tool", "plan", "compaction", "usage", "agent", "terminal.output", "notice", "retry", "reasoning", "artifact"].contains($0.type) }.suffix(30)) }
    var body: some View {
        if !visible.isEmpty {
            DisclosureGroup("Activité du harness · \(visible.count)") {
                ForEach(visible) { event in
                    DisclosureGroup(event.type) { Text(event.payload.display).font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                }
            }.font(.caption).foregroundStyle(.secondary).padding(.vertical, 8)
        }
    }
}
