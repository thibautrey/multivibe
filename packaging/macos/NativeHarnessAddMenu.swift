import SwiftUI

@MainActor struct NativeHarnessAddMenu: View {
    let harnessName: String
    let catalog: DesktopHarnessFeatureCatalog?
    let loading: Bool
    let error: String?
    @Binding var query: String
    let addFiles: () -> Void
    let retry: () -> Void
    let select: (DesktopHarnessFeatureItem) -> Void

    private let sections = ["actions", "modes", "commands", "skills", "plugins", "agents", "tools", "mcp", "hooks", "capabilities"]
    private var filtered: [DesktopHarnessFeatureItem] {
        let terms = query.split(whereSeparator: { $0.isWhitespace })
        return (catalog?.items ?? []).filter { item in
            terms.allSatisfy { term in [item.name, item.description ?? "", sectionTitle(item.section)].contains { $0.localizedCaseInsensitiveContains(term) } }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Add", text: $query).textFieldStyle(.plain).font(.system(size: 16))
                if loading { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 13).frame(height: 40)
            .background(ChatPalette.subtle, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 5) {
                    addRow(title: "Files and folders", detail: "Attach context to this conversation", icon: "paperclip", action: addFiles)
                    if let error {
                        Button(action: retry) {
                            Label { VStack(alignment: .leading) { Text("Reload harness features"); Text(error).font(.caption).foregroundStyle(.secondary).lineLimit(2) } } icon: { Image(systemName: "arrow.clockwise") }
                        }.buttonStyle(.plain).padding(.vertical, 8)
                    }
                    ForEach(sections, id: \.self) { section in
                        let values = filtered.filter { $0.section == section }
                        if !values.isEmpty {
                            if section != "actions" { Text(sectionTitle(section)).font(.caption.weight(.medium)).foregroundStyle(.secondary).padding(.top, 12).padding(.horizontal, 8) }
                            ForEach(values) { item in
                                addRow(title: itemTitle(item), detail: item.description, icon: icon(item), action: { select(item) })
                            }
                        }
                    }
                    if !loading, error == nil, query.isEmpty, filtered.isEmpty {
                        Text("\(harnessName) does not report additional actions for this conversation.")
                            .font(.callout).foregroundStyle(.secondary).padding(12)
                    } else if !loading, !query.isEmpty, filtered.isEmpty {
                        Text("No feature matches your search.").font(.callout).foregroundStyle(.secondary).padding(12)
                    }
                }
            }.frame(maxHeight: 520)
        }
        .padding(14).frame(width: 510)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Add features from \(harnessName)")
    }
    private func addRow(title: String, detail: String?, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.system(size: 16, weight: .medium)).foregroundStyle(ChatPalette.accent).frame(width: 24)
                Text(title).font(.system(size: 15)).foregroundStyle(.primary).lineLimit(1)
                if let detail, !detail.isEmpty { Text(detail).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1) }
                Spacer(minLength: 0)
            }.padding(.horizontal, 10).frame(height: 42)
                .contentShape(RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
            .background(Color.clear, in: RoundedRectangle(cornerRadius: 10))
            .accessibilityLabel(detail.map { "\(title), \($0)" } ?? title)
    }
    private func itemTitle(_ item: DesktopHarnessFeatureItem) -> String {
        item.section == "capabilities" ? HarnessPresentation.title(item.name) : item.name
    }
    private func sectionTitle(_ section: String) -> String {
        switch section {
        case "modes": return "Modes"
        case "commands": return "Commands"
        case "skills": return "Skills"
        case "plugins": return "Plugins"
        case "agents": return "Agents"
        case "tools": return "Tools"
        case "mcp": return "MCP servers"
        case "hooks": return "Hooks"
        case "capabilities": return "Capabilities"
        default: return "Add"
        }
    }
    private func icon(_ item: DesktopHarnessFeatureItem) -> String {
        switch item.action {
        case "goal": return "scope"
        case "compact": return "arrow.triangle.2.circlepath"
        case "configure": return "lightbulb"
        default: break
        }
        switch item.section {
        case "commands": return "terminal"
        case "skills": return "circle.hexagongrid"
        case "plugins", "mcp": return "puzzlepiece.extension"
        case "agents": return "person.2"
        case "tools": return "hammer"
        case "hooks": return "point.3.connected.trianglepath.dotted"
        default: return "checkmark.circle"
        }
    }
}
