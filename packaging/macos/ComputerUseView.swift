import AppKit
import SwiftUI

@MainActor struct ComputerUsePanel: View {
    @ObservedObject var controller: ComputerUseController
    let conversation: UUID?
    let savedEvents: [ComputerUseEvent]
    let stop: () -> Void
    @State private var settings = false
    @State private var expanded = true
    private var ownsRun: Bool { controller.conversationID == conversation }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "cursorarrow.motionlines").foregroundStyle(.secondary)
                Text("Computer use").font(.callout.weight(.semibold))
                if controller.running && ownsRun { ProgressView().controlSize(.small) }
                Text(ownsRun ? controller.status : "Navigateur et applications autorisées").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Button { controller.browser.show() } label: { Image(systemName: "globe") }.help("Afficher le navigateur intégré")
                Button { settings = true } label: { Image(systemName: "slider.horizontal.3") }.help("Permissions et applications")
                if controller.running && ownsRun {
                    Button("Reprendre la main", action: stop).keyboardShortcut(.escape, modifiers: [])
                }
                Button { expanded.toggle() } label: { Image(systemName: expanded ? "chevron.down" : "chevron.up") }.help("Afficher ou réduire l’activité")
            }.buttonStyle(.borderless)
            if let approval = controller.approval, ownsRun {
                VStack(alignment: .leading, spacing: 8) {
                    Label(approval.title, systemImage: "hand.raised").font(.callout.weight(.semibold))
                    ScrollView { Text(approval.detail).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 110)
                    HStack {
                        Button("Refuser") { controller.resolveApproval(0) }
                        Spacer()
                        if approval.canRemember { Button("Toujours autoriser cette app") { controller.resolveApproval(2) } }
                        Button("Autoriser") { controller.resolveApproval(1) }.buttonStyle(.borderedProminent)
                    }
                }.padding(12).background(Color.accentColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
            } else if expanded {
                HStack(alignment: .top, spacing: 14) {
                    if let image = controller.preview, ownsRun {
                        Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: 250, maxHeight: 135)
                            .clipShape(RoundedRectangle(cornerRadius: 7)).accessibilityLabel("Dernière capture de la cible")
                    }
                    let activity = ownsRun ? controller.events : savedEvents
                    if activity.isEmpty {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Décrivez la tâche et la cible dans votre message.").font(.callout)
                            Text("Le modèle observe, agit puis vérifie. Chaque application et chaque site nécessitent votre accord. Les actions sont confirmées par défaut.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 5)
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 6) {
                                ForEach(activity.suffix(30).reversed()) { event in
                                    HStack(alignment: .top, spacing: 6) {
                                        Image(systemName: event.succeeded ? "checkmark.circle" : "exclamationmark.circle").foregroundStyle(event.succeeded ? Color.secondary : Color.orange)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(event.detail).lineLimit(2)
                                            Text(event.target == "browser" ? "Navigateur intégré" : event.target).foregroundStyle(.tertiary).lineLimit(1)
                                        }
                                        Spacer()
                                        Text(event.date, style: .time).foregroundStyle(.tertiary)
                                    }.font(.caption)
                                }
                            }
                        }.frame(maxHeight: 135)
                    }
                }
            }
        }.padding(12).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 22).padding(.top, 8)
            .sheet(isPresented: $settings) { settingsView }
    }
    private var settingsView: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("Computer use").font(.title2.weight(.semibold)); Spacer(); Button("Fermer") { settings = false }.keyboardShortcut(.cancelAction) }
            Text("Les captures et le contenu observé sont transmis au modèle sélectionné. Les captures restent en mémoire pendant la tâche ; le journal local conserve les actions, sans le texte saisi.").font(.callout).foregroundStyle(.secondary)
            GroupBox("Navigateur intégré") {
                HStack { Text("WebKit isolé · chaque site est autorisé séparément pour la tâche").font(.caption); Spacer(); Button("Ouvrir") { controller.browser.show() } }.padding(5)
            }
            GroupBox("Applications macOS") {
                VStack(alignment: .leading, spacing: 10) {
                    HStack { Label(controller.accessibilityGranted ? "Accessibilité autorisée" : "Accessibilité requise", systemImage: controller.accessibilityGranted ? "checkmark.circle" : "hand.raised"); Spacer(); Button("Autoriser") { controller.requestAccessibility() } }
                    HStack { Label(controller.screenGranted ? "Capture autorisée" : "Capture d’écran requise", systemImage: controller.screenGranted ? "checkmark.circle" : "rectangle.dashed"); Spacer(); Button("Autoriser") { controller.requestScreen() } }
                    Text("Ouvrez l’app cible avant de la demander. Les terminaux, gestionnaires de secrets, assistants et réglages système sont protégés.").font(.caption).foregroundStyle(.secondary)
                    if !controller.allowedApps.isEmpty {
                        Divider()
                        ForEach(controller.allowedApps.sorted(), id: \.self) { app in
                            HStack { Text(app).font(.caption); Spacer(); Button("Révoquer") { controller.revoke(app) } }
                        }
                    }
                }.font(.callout).padding(5)
            }
            Toggle("Confirmer chaque action", isOn: $controller.confirmActions)
            Text(controller.confirmActions ? "Chaque clic, saisie et navigation attend votre validation." : "Vous autorisez les interactions de cette tâche dans les cibles approuvées. L’option revient à la confirmation après la tâche. Restez présent pour toute opération sensible.").font(.caption).foregroundStyle(.secondary)
            Text("Reprendre la main arrête la tâche. Une saisie ou un clic physique dans la cible interrompt aussi le contrôle automatique.").font(.caption).foregroundStyle(.secondary)
        }.padding(24).frame(width: 560)
    }
}
