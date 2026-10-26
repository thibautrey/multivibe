import AppKit

extension MultiVibeMenuBarApp {
    func application(_ application: NSApplication, open urls: [URL]) {
        if urls.count == 1, let url = urls.first, url.scheme == "multivibe", url.host == "compose",
           url.user == nil, url.password == nil, url.port == nil, url.path.isEmpty, url.query == nil,
           let text = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment,
           !text.isEmpty, text.count <= 32_000 {
            Task { @MainActor in self.showAssistant(text: text) }
            return
        }
        if urls.count == 1, let url = urls.first,
           url.scheme == "multivibe", url.host == "ask", url.user == nil,
           url.password == nil, url.port == nil, url.path.isEmpty,
           url.query == nil, url.fragment == nil {
            Task { @MainActor in self.showAssistant() }
            return
        }
    }
}
