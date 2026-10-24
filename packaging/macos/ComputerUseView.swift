import SwiftUI

/// Approval surface for agent actions. The capability is part of the conversation,
/// so the UI only appears when the user needs to review or stop an active action.
@MainActor struct AgentAccessView: View {
    @ObservedObject var controller: ComputerUseController
    let conversation: UUID?
    let stop: () -> Void
    private var ownsRun: Bool { controller.conversationID == conversation }
    var body: some View {
        if ownsRun, let approval = controller.approval {
            VStack(alignment: .leading, spacing: 8) {
                Label(approval.title, systemImage: "hand.raised").font(.callout.weight(.semibold))
                ScrollView { Text(approval.detail).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 110)
                HStack {
                    Button("Refuser") { controller.resolveApproval(0) }
                    Spacer()
                    if approval.canRemember { Button("Toujours autoriser") { controller.resolveApproval(2) } }
                    Button("Autoriser") { controller.resolveApproval(1) }.buttonStyle(.borderedProminent)
                }
            }
            .padding(12).background(Color.accentColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 22).padding(.top, 8)
        } else if ownsRun, controller.running {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(controller.status).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Button("Reprendre la main", action: stop).keyboardShortcut(.escape, modifiers: [])
            }
            .padding(.horizontal, 22).padding(.top, 8)
        }
    }
}
