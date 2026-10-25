import SwiftUI

/// Approval surface for agent actions. The capability is part of the conversation,
/// so the UI only appears when the user needs to review or stop an active action.
@MainActor struct AgentAccessView: View {
    @ObservedObject var controller: ComputerUseController
    let conversation: UUID?
    let stop: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var ownsRun: Bool { controller.conversationID == conversation }
    var body: some View {
        Group {
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
            .padding(16).background(ChatPalette.surface, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(ChatPalette.accent.opacity(0.28), lineWidth: 1))
            .padding(.horizontal, 28).padding(.top, 8).frame(maxWidth: 820).frame(maxWidth: .infinity)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        } else if ownsRun, controller.running {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(controller.status).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Button("Reprendre la main", action: stop).keyboardShortcut(.escape, modifiers: [])
            }
            .padding(.horizontal, 14).frame(height: 38)
            .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 11))
            .padding(.horizontal, 28).padding(.top, 8).frame(maxWidth: 820).frame(maxWidth: .infinity)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
        }.animation(ChatPalette.motion(reduceMotion), value: controller.running)
    }
}
