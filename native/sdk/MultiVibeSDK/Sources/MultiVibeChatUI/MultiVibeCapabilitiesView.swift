import SwiftUI
import MultiVibeSDK

/// Optional controls shared by integrating applications. These grants authorize
/// host tools only; they never grant access to account history or recovery keys.
@MainActor public struct MultiVibeCapabilitiesView: View {
    @ObservedObject private var capabilities: MultiVibeAgentCapabilities
    @State private var error: String?
    public init(capabilities: MultiVibeAgentCapabilities) { self.capabilities = capabilities }
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Fonctions de l’application").font(.headline)
            ForEach(capabilities.manifest.skills) { skill in
                let permitted = Set(skill.permissions).isSubset(of: capabilities.permissions)
                Toggle(skill.name, isOn: Binding(get: { capabilities.selectedSkills.contains(skill.id) }, set: { value in
                    perform { try capabilities.setSkill(skill.id, enabled: value) }
                })).disabled(!permitted)
                if !permitted { Text("Autorisez les fonctions requises ci-dessous pour utiliser cette compétence.").font(.caption).foregroundStyle(.secondary) }
                DisclosureGroup("Voir les instructions") { Text(skill.instructions).font(.caption) }
            }
            let permissions = Set(capabilities.manifest.tools.map(\.permission) + capabilities.manifest.skills.flatMap(\.permissions)).sorted()
            ForEach(permissions, id: \.self) { permission in
                Toggle(isOn: Binding(get: { capabilities.permissions.contains(permission) }, set: { value in
                    perform { try capabilities.setPermission(permission, allowed: value) }
                })) {
                    VStack(alignment: .leading) {
                        Text(permission)
                        ForEach(capabilities.manifest.tools.filter { $0.permission == permission }, id: \.name) { tool in
                            Text(tool.description).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red).accessibilityLabel("Erreur : " + error) }
        }
    }
    private func perform(_ action: () throws -> Void) {
        do { try action(); error = nil } catch { self.error = error.localizedDescription }
    }
}
