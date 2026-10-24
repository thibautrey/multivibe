import AppKit
import Combine
import Foundation
import SwiftUI

private typealias CEFEventCallback = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?, UnsafePointer<CChar>?) -> Void
private typealias CEFResultCallback = @convention(c) (UnsafeMutableRawPointer?, Int32, UnsafePointer<CChar>?) -> Void
@_silgen_name("mvcef_initialize") private func mvcef_initialize(_ helper: UnsafePointer<CChar>, _ cache: UnsafePointer<CChar>) -> Bool
@_silgen_name("mvcef_is_initialized") private func mvcef_is_initialized() -> Bool
@_silgen_name("mvcef_do_message_loop_work") private func mvcef_do_message_loop_work()
@_silgen_name("mvcef_shutdown") private func mvcef_shutdown()
@_silgen_name("mvcef_browser_create") private func mvcef_browser_create(_ parent: UnsafeMutableRawPointer?, _ callback: CEFEventCallback?, _ context: UnsafeMutableRawPointer?) -> UnsafeMutableRawPointer?
@_silgen_name("mvcef_browser_destroy") private func mvcef_browser_destroy(_ browser: UnsafeMutableRawPointer?)
@_silgen_name("mvcef_browser_navigate") private func mvcef_browser_navigate(_ browser: UnsafeMutableRawPointer?, _ url: UnsafePointer<CChar>)
@_silgen_name("mvcef_browser_back") private func mvcef_browser_back(_ browser: UnsafeMutableRawPointer?)
@_silgen_name("mvcef_browser_forward") private func mvcef_browser_forward(_ browser: UnsafeMutableRawPointer?)
@_silgen_name("mvcef_browser_reload") private func mvcef_browser_reload(_ browser: UnsafeMutableRawPointer?, _ noCache: Bool)
@_silgen_name("mvcef_browser_stop") private func mvcef_browser_stop(_ browser: UnsafeMutableRawPointer?)
@_silgen_name("mvcef_browser_focus") private func mvcef_browser_focus(_ browser: UnsafeMutableRawPointer?, _ focus: Bool)
@_silgen_name("mvcef_browser_set_allowed_origins") private func mvcef_browser_set_allowed_origins(_ browser: UnsafeMutableRawPointer?, _ origins: UnsafePointer<CChar>)
@_silgen_name("mvcef_browser_execute") private func mvcef_browser_execute(_ browser: UnsafeMutableRawPointer?, _ method: UnsafePointer<CChar>, _ params: UnsafePointer<CChar>, _ callback: CEFResultCallback?, _ context: UnsafeMutableRawPointer?) -> Bool

@MainActor enum ChromiumRuntime {
    private(set) static var error: String?
    private static var pump: Timer?
    static func start(bundle: Bundle = .main, root: URL? = nil) -> Bool {
        if mvcef_is_initialized() { return true }
        guard let frameworks = bundle.privateFrameworksURL else { error = "Le runtime Chromium est absent du bundle."; return false }
        let helper = frameworks.appendingPathComponent("MultiVibe Chromium Helper.app/Contents/MacOS/MultiVibe Chromium Helper")
        guard FileManager.default.isExecutableFile(atPath: helper.path),
              FileManager.default.fileExists(atPath: frameworks.appendingPathComponent("Chromium Embedded Framework.framework/Chromium Embedded Framework").path) else {
            error = "Le runtime Chromium intégré est incomplet."; return false
        }
        let configuredRoot = ProcessInfo.processInfo.environment["MULTIVIBE_CHROMIUM_PROFILE_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        let requestedCache = root ?? configuredRoot ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("MultiVibe/Chromium", isDirectory: true)
        do { try FileManager.default.createDirectory(at: requestedCache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        catch { self.error = "Le profil Chromium ne peut pas être créé : \(error.localizedDescription)"; return false }
        let cache = requestedCache.resolvingSymlinksInPath()
        let ok = helper.path.withCString { helperValue in cache.path.withCString { cacheValue in mvcef_initialize(helperValue, cacheValue) } }
        if ok {
            let timer = Timer(timeInterval: 0.01, repeats: true) { _ in mvcef_do_message_loop_work() }
            RunLoop.main.add(timer, forMode: .common); pump = timer
        } else { error = "Chromium n’a pas pu démarrer." }
        return ok
    }
    static func stop() { pump?.invalidate(); pump = nil; if mvcef_is_initialized() { mvcef_shutdown() } }
}

private final class ChromiumCDPBox: @unchecked Sendable {
    let continuation: CheckedContinuation<[String: Any], Error>
    init(_ continuation: CheckedContinuation<[String: Any], Error>) { self.continuation = continuation }
}

private final class ChromiumContainerView: NSView {
    var didAttachToWindow: (() -> Void)?
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { didAttachToWindow?() }
    }
}

@MainActor final class ChromiumBrowser: ObservableObject {
    @Published var isVisible = false
    @Published private(set) var url = ""
    @Published private(set) var title = "Navigateur"
    @Published private(set) var loading = false
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var runtimeError: String?
    @Published private(set) var blockedURL: String?
    let container: NSView
    private(set) var allowedOrigins: Set<String> = []
    var automating = false
    var onClose: (() -> Void)?
    private var handle: UnsafeMutableRawPointer?
    private var ready = false
    private var pendingURL: String?
    private var readyWaiters: [CheckedContinuation<Void, Error>] = []
    private var loadWaiters: [CheckedContinuation<Void, Error>] = []
    private var observationID: String?
    private var observedURL: String?
    private var executionContext: Int?
    private var observedAt = Date.distantPast
    init() {
        let view = ChromiumContainerView(frame: .zero)
        container = view
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
        view.didAttachToWindow = { [weak self] in self?.attach() }
    }
    deinit { if let handle { mvcef_browser_destroy(handle) } }
    func close() {
        if let handle { mvcef_browser_destroy(handle); self.handle = nil }
        ready = false; loading = false
        let error = ComputerUseFailure("Le panneau Chromium a été fermé.")
        failReady(error); loadWaiters.forEach { $0.resume(throwing: error) }; loadWaiters.removeAll()
    }
    func attach() {
        guard handle == nil else { return }
        // CEF requires a parent that already belongs to an NSWindow. Creating
        // against a detached SwiftUI representable can leave a live but black
        // browser in the full chat layout.
        guard container.window != nil else { return }
        guard ChromiumRuntime.start() else { runtimeError = ChromiumRuntime.error; failReady(ComputerUseFailure(runtimeError ?? "Chromium indisponible.")); return }
        let context = Unmanaged.passUnretained(self).toOpaque()
        handle = mvcef_browser_create(Unmanaged.passUnretained(container).toOpaque(), chromiumEvent, context)
        if handle == nil { runtimeError = "Le panneau Chromium n’a pas pu être créé."; failReady(ComputerUseFailure(runtimeError!)) }
    }
    func reset() {
        observationID = nil; observedURL = nil; executionContext = nil; allowedOrigins = []; syncOrigins()
        stopLoading()
    }
    func show() { isVisible = true }
    func hide() { isVisible = false; if automating { onClose?() } }
    func contains(event: NSEvent) -> Bool {
        guard let window = container.window, event.window === window else { return false }
        let point = container.convert(event.locationInWindow, from: nil)
        return container.bounds.contains(point)
    }
    func allow(origin: String) { allowedOrigins.insert(origin); syncOrigins() }
    private func syncOrigins() {
        guard let handle else { return }
        allowedOrigins.sorted().joined(separator: "\n").withCString { mvcef_browser_set_allowed_origins(handle, $0) }
    }
    func userNavigate(_ input: String) {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let destination: String
        if let candidate = URL(string: trimmed), candidate.scheme != nil { destination = trimmed }
        else if trimmed.contains(".") && !trimmed.contains(" ") { destination = "https://" + trimmed }
        else { destination = "https://www.google.com/search?q=" + (trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? trimmed) }
        guard let origin = try? ComputerUsePolicy.origin(destination) else { runtimeError = "Adresse invalide."; return }
        allow(origin: origin); show(); navigate(destination)
    }
    func navigate(_ destination: String) {
        show(); observationID = nil; observedURL = nil; executionContext = nil
        guard ready, let handle else { pendingURL = destination; return }
        destination.withCString { mvcef_browser_navigate(handle, $0) }
    }
    func back() { observationID = nil; if let handle { mvcef_browser_back(handle) } }
    func forward() { observationID = nil; if let handle { mvcef_browser_forward(handle) } }
    func reload(noCache: Bool = false) { observationID = nil; if let handle { mvcef_browser_reload(handle, noCache) } }
    func stopLoading() { if let handle { mvcef_browser_stop(handle) } }
    func focus() { if let handle { mvcef_browser_focus(handle, true) } }
    private func ensureReady() async throws {
        show()
        if let runtimeError { throw ComputerUseFailure(runtimeError) }
        if ready, handle != nil { return }
        try await withCheckedThrowingContinuation { readyWaiters.append($0) }
    }
    private func settle() async throws {
        try await ensureReady()
        if loading {
            try await withCheckedThrowingContinuation { loadWaiters.append($0) }
        }
        try Task.checkCancellation()
        try await Task.sleep(nanoseconds: 180_000_000)
    }
    private func cdp(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
        try await ensureReady(); try Task.checkCancellation()
        guard JSONSerialization.isValidJSONObject(params), let data = try? JSONSerialization.data(withJSONObject: params), let json = String(data: data, encoding: .utf8), let handle else { throw ComputerUseFailure("Commande Chromium invalide.") }
        return try await withCheckedThrowingContinuation { continuation in
            let box = Unmanaged.passRetained(ChromiumCDPBox(continuation))
            let submitted = method.withCString { methodValue in json.withCString { paramsValue in mvcef_browser_execute(handle, methodValue, paramsValue, chromiumResult, box.toOpaque()) } }
            if !submitted {
                box.release(); continuation.resume(throwing: ComputerUseFailure("Chromium n’a pas accepté la commande \(method)."))
            }
        }
    }
    private func evaluate(_ expression: String, context: Int? = nil) async throws -> Any? {
        var params: [String: Any] = ["expression": expression, "returnByValue": true, "awaitPromise": true]
        if let context { params["contextId"] = context }
        let result = try await cdp("Runtime.evaluate", params)
        if let exception = result["exceptionDetails"] { throw ComputerUseFailure("La page a refusé l’observation : \(exception)") }
        return (result["result"] as? [String: Any])?["value"]
    }
    private func isolatedContext() async throws -> Int {
        let tree = try await cdp("Page.getFrameTree")
        guard let frameTree = tree["frameTree"] as? [String: Any], let frame = frameTree["frame"] as? [String: Any], let frameID = frame["id"] as? String else { throw ComputerUseFailure("Cadre Chromium principal introuvable.") }
        let world = try await cdp("Page.createIsolatedWorld", ["frameId": frameID, "worldName": "MultiVibe", "grantUniversalAccess": false])
        guard let context = world["executionContextId"] as? Int else { throw ComputerUseFailure("Contexte Chromium isolé indisponible.") }
        return context
    }
    func observe() async throws -> ComputerUseObservation {
        try await settle()
        guard !url.isEmpty, url != "about:blank" else { return .init(id: UUID().uuidString, target: "browser", text: "Navigateur prêt. Utilisez navigate avec une URL HTTP(S).", image: nil, imageURL: nil) }
        let context = try await isolatedContext(), id = UUID().uuidString
        let snapshot = try await evaluate(Self.snapshotScript.replacingOccurrences(of: "__TOKEN__", with: Self.js(id)), context: context) as? String ?? ""
        _ = try await evaluate(Self.maskScript, context: context)
        let screenshot: [String: Any]
        do { screenshot = try await cdp("Page.captureScreenshot", ["format": "jpeg", "quality": 65, "fromSurface": true, "captureBeyondViewport": false]) }
        catch { _ = try? await evaluate(Self.unmaskScript, context: context); throw error }
        _ = try? await evaluate(Self.unmaskScript, context: context)
        guard let base64 = screenshot["data"] as? String, let data = Data(base64Encoded: base64), data.count <= 3_000_000, let image = NSImage(data: data) else { throw ComputerUseFailure("Capture Chromium invalide.") }
        observationID = id; observedURL = url; executionContext = context; observedAt = Date()
        return .init(id: id, target: "browser", text: "Observation: \(id)\nURL: \(url)\n\(snapshot)\(blockedURL.map { "\nNavigation bloquée : \($0)" } ?? "")", image: image, imageURL: "data:image/jpeg;base64," + base64)
    }
    func perform(_ command: ComputerUseCommand) async throws {
        try command.validate(); try await settle()
        if command.action == "navigate" {
            let origin = try ComputerUsePolicy.origin(command.url ?? "")
            guard allowedOrigins.contains(origin) else { throw ComputerUseFailure("Site non autorisé.") }
            navigate(command.url ?? ""); try await settle(); return
        }
        if command.action == "back" { back(); try await settle(); return }
        guard command.observation == observationID, observedURL == url, let context = executionContext,
              Date().timeIntervalSince(observedAt) < 120 else { throw ComputerUseFailure("Observation Chromium périmée. Observez de nouveau.") }
        observationID = nil
        let raw = try JSONEncoder().encode(command)
        let object = try JSONSerialization.jsonObject(with: raw)
        guard let objectData = try? JSONSerialization.data(withJSONObject: object), let objectJSON = String(data: objectData, encoding: .utf8) else { throw ComputerUseFailure("Action Chromium invalide.") }
        let preflight = try await evaluate(Self.preflightScript.replacingOccurrences(of: "__COMMAND__", with: objectJSON), context: context) as? [String: Any]
        if let error = preflight?["error"] as? String { throw ComputerUseFailure(error) }
        if command.action == "type" {
            _ = try await evaluate("globalThis.mvTarget.focus(); if(globalThis.mvTarget.select) globalThis.mvTarget.select();", context: context)
            _ = try await cdp("Input.insertText", ["text": command.text ?? ""])
        } else if ["click", "double_click"].contains(command.action) {
            guard let x = preflight?["x"] as? Double, let y = preflight?["y"] as? Double else { throw ComputerUseFailure("Point Chromium inaccessible.") }
            let count = command.action == "double_click" ? 2 : 1
            _ = try await cdp("Input.dispatchMouseEvent", ["type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": count])
            _ = try await cdp("Input.dispatchMouseEvent", ["type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": count])
        } else if command.action == "scroll" {
            let amount = Double(command.amount ?? 500), direction = command.direction ?? "down"
            let dx = direction == "left" ? -amount : direction == "right" ? amount : 0
            let dy = direction == "up" ? -amount : direction == "down" ? amount : 0
            _ = try await cdp("Input.dispatchMouseEvent", ["type": "mouseWheel", "x": 20, "y": 20, "deltaX": dx, "deltaY": dy])
        } else if command.action == "drag" {
            for (type, x, y, buttons) in [("mousePressed", command.x!, command.y!, 1), ("mouseMoved", command.toX!, command.toY!, 1), ("mouseReleased", command.toX!, command.toY!, 0)] {
                _ = try await cdp("Input.dispatchMouseEvent", ["type": type, "x": x, "y": y, "button": "left", "buttons": buttons])
            }
        } else if command.action == "key" {
            let keys: [String: (String, Int)] = ["return":("Enter",13),"tab":("Tab",9),"escape":("Escape",27),"backspace":("Backspace",8),"delete":("Delete",46),"up":("ArrowUp",38),"down":("ArrowDown",40),"left":("ArrowLeft",37),"right":("ArrowRight",39),"home":("Home",36),"end":("End",35),"pageup":("PageUp",33),"pagedown":("PageDown",34),"select_all":("a",65),"copy":("c",67),"paste":("v",86),"undo":("z",90),"redo":("z",90)]
            guard let key = command.key, let value = keys[key] else { throw ComputerUseFailure("Touche Chromium invalide.") }
            let modifiers = ["select_all","copy","paste","undo","redo"].contains(key) ? (key == "redo" ? 10 : 2) : 0
            for type in ["keyDown", "keyUp"] { _ = try await cdp("Input.dispatchKeyEvent", ["type": type, "key": value.0, "windowsVirtualKeyCode": value.1, "nativeVirtualKeyCode": value.1, "modifiers": modifiers]) }
        }
        try await settle()
    }
    fileprivate func event(_ name: String, json: String) {
        let data = Data(json.utf8), value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        switch name {
        case "ready":
            ready = true; syncOrigins()
            if let pendingURL { self.pendingURL = nil; navigate(pendingURL) }
            readyWaiters.forEach { $0.resume() }; readyWaiters.removeAll()
        case "closed": ready = false
        case "loading":
            loading = value["loading"] as? Bool ?? false; canGoBack = value["back"] as? Bool ?? false; canGoForward = value["forward"] as? Bool ?? false
            if !loading { loadWaiters.forEach { $0.resume() }; loadWaiters.removeAll() }
        case "url": if let state = value["value"] as? String { url = state; observationID = nil }
        case "title": title = value["value"] as? String ?? "Navigateur"
        case "blocked": blockedURL = value["value"] as? String; runtimeError = "Navigation bloquée."
        case "error": runtimeError = value["message"] as? String ?? "Erreur Chromium."
        default: break
        }
    }
    private func failReady(_ error: Error) { readyWaiters.forEach { $0.resume(throwing: error) }; readyWaiters.removeAll() }
    private static func js(_ value: String) -> String { String(data: try! JSONEncoder().encode(value), encoding: .utf8)! }
    private static let snapshotScript = #"""
    (()=>{const token=__TOKEN__;const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none'};const secret=e=>e.matches('input[type=password],input[autocomplete*=password],input[autocomplete=one-time-code],input[autocomplete^=cc-]');const nodes=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=checkbox],[role=tab],[contenteditable=true],summary')).filter(visible).filter(e=>!secret(e)).slice(0,250);globalThis.mvObservation={token,nodes};const items=nodes.map((e,i)=>{const r=e.getBoundingClientRect();return{id:i+1,role:e.getAttribute('role')||e.tagName.toLowerCase(),label:(e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.innerText||e.labels?.[0]?.innerText||'').slice(0,200),value:(e.value||'').slice(0,300),disabled:!!e.disabled,rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]}});const clone=document.body?.cloneNode(true);clone?.querySelectorAll('script,style,noscript,input,textarea,[contenteditable]').forEach(e=>e.remove());return JSON.stringify({engine:'Chromium',title:document.title,viewport:[innerWidth,innerHeight],coordinateSpace:'CSS pixels relative to viewport',text:(clone?.innerText||clone?.textContent||'').slice(0,14000),elements:items,frames:document.querySelectorAll('iframe').length})})()
    """#
    private static let maskScript = #"(()=>{globalThis.mvMasks=[];for(const e of document.querySelectorAll('input[type=password],input[autocomplete*=password],input[autocomplete=one-time-code],input[autocomplete^=cc-]')){const r=e.getBoundingClientRect(),m=document.createElement('div');Object.assign(m.style,{position:'fixed',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',background:'#777',zIndex:'2147483647',pointerEvents:'none'});document.documentElement.append(m);globalThis.mvMasks.push(m)}return true})()"#
    private static let unmaskScript = #"(()=>{globalThis.mvMasks?.forEach(e=>e.remove());globalThis.mvMasks=[];return true})()"#
    private static let preflightScript = #"""
    (()=>{const c=__COMMAND__,o=globalThis.mvObservation;if(!o||o.token!==c.observation)return{error:'Observation périmée.'};globalThis.mvObservation=null;let e=c.element?o.nodes[c.element-1]:((c.x!=null&&c.y!=null)?document.elementFromPoint(c.x,c.y):document.activeElement);if(c.element&&(!e||!e.isConnected))return{error:'Élément périmé.'};if(e?.closest('input[type=password],input[autocomplete*=password],input[autocomplete=one-time-code],input[autocomplete^=cc-]'))return{error:'Champ sécurisé : intervention humaine requise.'};if(e?.disabled)return{error:'Élément désactivé.'};globalThis.mvTarget=e;if(['click','double_click'].includes(c.action)){if(!e)return{error:'Point hors de la page.'};const r=e.getBoundingClientRect(),x=c.element?r.x+r.width/2:c.x,y=c.element?r.y+r.height/2:c.y,hit=document.elementFromPoint(x,y);if(hit!==e&&!e.contains(hit))return{error:'Élément masqué.'};return{x,y}}if(c.action==='type'){if(!e||e.tagName==='INPUT'&&e.type==='file')return{error:'Champ non modifiable.'};return{ok:true}}return{ok:true}})()
    """#
}

private let chromiumEvent: CEFEventCallback = { context, event, json in
    guard let context, let event else { return }
    let browser = Unmanaged<ChromiumBrowser>.fromOpaque(context).takeUnretainedValue()
    let name = String(cString: event), value = json.map(String.init(cString:)) ?? "{}"
    Task { @MainActor in browser.event(name, json: value) }
}
private let chromiumResult: CEFResultCallback = { context, ok, json in
    guard let context else { return }
    let box = Unmanaged<ChromiumCDPBox>.fromOpaque(context).takeRetainedValue()
    let value = json.map(String.init(cString:)) ?? "{}"
    if ok != 0, let data = value.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { box.continuation.resume(returning: object) }
    else { box.continuation.resume(throwing: ComputerUseFailure("Chromium a refusé la commande : \(value.prefix(500))")) }
}

@MainActor struct ChromiumBrowserView: NSViewRepresentable {
    @ObservedObject var browser: ChromiumBrowser
    func makeNSView(context: Context) -> NSView {
        DispatchQueue.main.async { browser.attach() }
        return browser.container
    }
    func updateNSView(_ nsView: NSView, context: Context) { DispatchQueue.main.async { browser.attach() } }
}

@MainActor struct ChromiumBrowserPanel: View {
    @ObservedObject var browser: ChromiumBrowser
    @State private var address = ""
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { browser.back() } label: { Image(systemName: "chevron.left") }.disabled(!browser.canGoBack)
                Button { browser.forward() } label: { Image(systemName: "chevron.right") }.disabled(!browser.canGoForward)
                Button { browser.loading ? browser.stopLoading() : browser.reload() } label: { Image(systemName: browser.loading ? "xmark" : "arrow.clockwise") }
                HStack(spacing: 6) {
                    Image(systemName: browser.url.hasPrefix("https://") ? "lock.fill" : "globe").font(.caption).foregroundStyle(.secondary)
                    TextField("Rechercher ou saisir une adresse", text: $address).textFieldStyle(.plain).onSubmit { browser.userNavigate(address) }
                }.padding(.horizontal, 10).frame(height: 30).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                Button { browser.hide() } label: { Image(systemName: "xmark") }.help("Fermer le panneau")
            }.buttonStyle(.borderless).padding(9)
            Divider()
            if let error = browser.runtimeError {
                VStack(spacing: 10) { Image(systemName: "exclamationmark.triangle").font(.largeTitle); Text("Navigateur indisponible").font(.headline); Text(error).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ChromiumBrowserView(browser: browser)
            }
        }
        .frame(minWidth: 390, idealWidth: 560)
        .onAppear { address = browser.url; browser.focus() }
        .onChange(of: browser.url) { address = $0 }
    }
}
