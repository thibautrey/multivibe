import Foundation

struct ChatPresentedError: Equatable {
    let summary: String
    let details: String?
    init(_ raw: String) {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = value.lowercased()
        if lower.contains("streaming failed before delivery") || lower.contains("connection error") {
            summary = "La connexion au modèle a été interrompue. Réessayez si aucune réponse n’apparaît."
        } else if lower.contains("timed out") {
            summary = "La demande a pris trop de temps. Vous pouvez réessayer."
        } else if lower.contains("network connection was lost") {
            summary = "La connexion a été interrompue. Vos messages en attente sont conservés."
        } else if lower.contains("could not connect to the server") || lower.contains("connection refused") {
            summary = "Impossible de joindre le Host. Vérifiez sa connexion, puis réessayez."
        } else {
            let first = value.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? "Une erreur est survenue."
            summary = first.count > 240 ? String(first.prefix(237)) + "…" : first
        }
        details = value.isEmpty || value == summary ? nil : String(value.prefix(32_000))
    }
}

/// Presentation only: preserve native payloads and never infer successful execution.
enum HarnessPresentation {
    static func title(_ key: String) -> String {
        ["sessions": "Sessions", "history": "Historique", "fork": "Branches de conversation", "queue": "File d’attente",
         "steer": "Intervention en cours de travail", "interrupt": "Interruption", "streaming": "Réponse en direct",
         "modes": "Modes", "plans": "Plans", "instructions": "Instructions", "context": "Contexte",
         "compaction": "Compaction du contexte", "memory": "Mémoire", "skills": "Skills", "commands": "Commandes",
         "tools": "Outils", "mcp": "Connexions MCP", "plugins": "Extensions", "interactions": "Questions et approbations",
         "attachments": "Pièces jointes", "images": "Images", "audio": "Audio", "video": "Vidéo", "artifacts": "Fichiers produits",
         "terminals": "Terminaux", "workspace": "Dossier de travail", "git": "Git", "checkpoints": "Points de restauration",
         "models": "Modèles", "settings": "Réglages", "usage": "Consommation", "agents": "Sous-agents",
         "automations": "Automatisations", "hooks": "Hooks", "remote": "Exécution distante", "diagnostics": "Diagnostic"][key] ?? key
    }
    static func state(_ value: String) -> String {
        ["idle": "Prêt", "starting": "Préparation", "running": "Travail en cours", "waiting_user": "Votre réponse est attendue",
         "compacting": "Compaction du contexte", "interrupted": "Interrompu", "uncertain": "État à vérifier", "failed": "Échec"][value] ?? value
    }
    static func origin(_ value: String) -> String {
        ["native": "Fourni par le harness", "multivibe": "Fourni par MultiVibe", "unsupported": "Non pris en charge", "unknown": "À confirmer"][value] ?? value
    }
    static func activities(_ events: [DesktopHarnessEvent]) -> [HarnessActivity] {
        let kinds: Set<String> = ["tool", "plan", "compaction", "agent", "terminal.output", "notice", "retry", "reasoning", "artifact"]
        var rows: [HarnessActivity] = []
        var indices: [String: Int] = [:]
        for event in events where kinds.contains(event.type) || !event.payload["artifacts"].array.isEmpty {
            let shared = ["plan", "compaction", "usage", "reasoning"].contains(event.type)
            let key = "\(event.sessionId):\(event.turnId ?? "session"):\(event.type):\(event.itemId ?? (shared ? "summary" : String(event.seq)))"
            if let index = indices[key] { rows[index].updates.append(event) }
            else { indices[key] = rows.count; rows.append(.init(id: key, updates: [event])) }
        }
        return Array(rows.suffix(30))
    }
}

struct HarnessActivity: Identifiable {
    enum Status { case active, completed, failed, cancelled, neutral }
    let id: String
    var updates: [DesktopHarnessEvent]
    var event: DesktopHarnessEvent { updates.last! }
    var kind: String { event.type }
    private var payload: HarnessJSON { event.payload }
    private var item: HarnessJSON { payload["item"] == .null ? payload : payload["item"] }
    var title: String {
        switch kind {
        case "tool":
            // End/progress events often omit the name supplied at the start.
            for update in updates.reversed() {
                let p = update.payload; let i = p["item"] == .null ? p : p["item"]
                if let title = p["title"].string ?? i["title"].string ?? p["toolName"].string ?? i["name"].string ?? i["tool"].string { return title }
                if i["type"].string == "commandExecution" { return "Commande dans le terminal" }
                if i["type"].string == "fileChange" { return "Modification de fichiers" }
                if i["type"].string == "webSearch" { return "Recherche sur le Web" }
            }
            return "Appel d’outil"
        case "plan": return "Plan de travail"
        case "compaction": return "Compaction du contexte"
        case "usage": return "Consommation du modèle"
        case "agent": return item["description"].string ?? item["title"].string ?? "Sous-agent"
        case "terminal.output": return "Sortie du terminal"
        case "reasoning": return "Résumé du raisonnement"
        case "retry": return "Nouvelle tentative"
        case "artifact": return "Fichier produit"
        default: return payload["message"].string ?? "Information du harness"
        }
    }
    var icon: String {
        ["tool": "wrench.and.screwdriver", "plan": "checklist", "compaction": "arrow.down.right.and.arrow.up.left",
         "usage": "chart.bar", "agent": "person.2", "terminal.output": "terminal", "reasoning": "text.alignleft",
         "retry": "arrow.clockwise", "artifact": "doc", "notice": "info.circle"][kind] ?? "info.circle"
    }
    var status: Status {
        let state = (item["status"].string ?? item["state"]["status"].string ?? payload["status"].string ?? payload["state"].string ?? "")
        let phase = payload["phase"].string ?? payload["type"].string ?? ""
        if ["failed", "error"].contains(state) || payload["isError"] == .bool(true) || payload["is_error"] == .bool(true) { return .failed }
        if ["cancelled", "canceled", "interrupted"].contains(state) { return .cancelled }
        if ["completed", "complete", "success", "succeeded"].contains(state) || ["item/completed", "tool_execution_end"].contains(phase) || payload["subtype"].string == "compact_boundary" { return .completed }
        if ["started", "starting", "running", "pending", "in_progress"].contains(state) || ["item/started", "tool_execution_start", "tool_execution_update", "tool_use", "tool_progress"].contains(phase) { return .active }
        if ["usage", "notice", "artifact"].contains(kind) { return .neutral }
        return .neutral
    }
    var statusLabel: String {
        switch status { case .active: return "En cours"; case .completed: return "Terminé"; case .failed: return "Échec"; case .cancelled: return "Interrompu"; case .neutral: return "" }
    }
    var plan: [HarnessJSON] {
        let entries = payload["entries"].array
        return entries.isEmpty ? (payload["plan"].array.isEmpty ? item["steps"].array : payload["plan"].array) : entries
    }
    var readable: String? {
        if kind == "usage" {
            let usage = payload["usage"] != .null ? payload["usage"] : payload["tokenUsage"]["total"] != .null ? payload["tokenUsage"]["total"] : payload
            var lines: [String] = []
            for (label, keys) in [("Entrée", ["input_tokens", "inputTokens"]), ("Sortie", ["output_tokens", "outputTokens"]), ("Cache lu", ["cache_read_input_tokens", "cachedInputTokens"]), ("Total", ["total_tokens", "totalTokens"])] {
                if let value = keys.compactMap({ key -> Double? in if case .number(let number) = usage[key] { return number }; return nil }).first {
                    lines.append("\(label) : \(value.formatted(.number.precision(.fractionLength(0)))) tokens")
                }
            }
            if case .number(let cost) = payload["estimatedCostUsd"] { lines.append("Coût estimé : \(cost.formatted(.currency(code: "USD")))") }
            return lines.isEmpty ? nil : lines.joined(separator: "\n")
        }
        if kind == "reasoning" { return String(updates.compactMap { $0.payload["text"].string ?? $0.payload["delta"].string }.joined().suffix(16_000)) }
        if kind == "terminal.output" {
            if let output = payload["output"].string { return String(output.suffix(16_000)) }
            return String(updates.compactMap { $0.payload["delta"].string }.joined().suffix(16_000))
        }
        for value in [item["command"], item["text"], payload["summary"], item["output"], item["aggregatedOutput"], payload["message"], payload["error"]] {
            if let string = value.string, !string.isEmpty { return String(string.prefix(16_000)) }
        }
        let content = (payload["content"].array + payload["result"]["content"].array).compactMap { $0["text"].string }.joined(separator: "\n")
        return content.isEmpty ? nil : String(content.prefix(16_000))
    }
    var attachments: [DesktopHarnessAttachment] {
        var files: [DesktopHarnessAttachment] = []
        for update in updates {
            files += (try? update.payload["artifacts"].decode([DesktopHarnessAttachment].self)) ?? []
            if let file = try? update.payload["attachment"].decode(DesktopHarnessAttachment.self) { files.append(file) }
        }
        return Dictionary(grouping: files, by: \.id).values.compactMap(\.first).sorted { $0.name < $1.name }
    }
}

struct ChatConversationSection: Identifiable {
    let id: String
    let title: String
    let conversations: [NativeChatConversation]
    static func sections(_ conversations: [NativeChatConversation], now: Date = Date(), calendar: Calendar = .current) -> [Self] {
        let sorted = conversations.sorted { $0.updatedAt > $1.updatedAt }
        let day = calendar.startOfDay(for: now)
        let week = calendar.date(byAdding: .day, value: -7, to: day) ?? day
        let groups: [(String, String, (NativeChatConversation) -> Bool)] = [
            ("pinned", "Épinglées", { $0.pinned == true }),
            ("today", "Aujourd’hui", { $0.pinned != true && $0.updatedAt >= day }),
            ("week", "7 derniers jours", { $0.pinned != true && $0.updatedAt < day && $0.updatedAt >= week }),
            ("older", "Plus anciennes", { $0.pinned != true && $0.updatedAt < week })
        ]
        return groups.compactMap { id, title, predicate in
            let values = sorted.filter(predicate)
            return values.isEmpty ? nil : .init(id: id, title: title, conversations: values)
        }
    }
}

struct ChatHarnessConversationSection: Identifiable {
    let id: String
    let conversations: [NativeChatConversation]

    static func sections(_ conversations: [NativeChatConversation]) -> [Self] {
        var order: [String] = []
        var grouped: [String: [NativeChatConversation]] = [:]
        for conversation in conversations {
            let harnessID = conversation.harnessID.flatMap { $0.isEmpty ? nil : $0 } ?? "native"
            if grouped[harnessID] == nil { order.append(harnessID) }
            grouped[harnessID, default: []].append(conversation)
        }
        return order.map { .init(id: $0, conversations: grouped[$0] ?? []) }
    }
}
