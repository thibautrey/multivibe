import AppKit
import WebKit

/// A separate, visible web surface. Page code cannot access the automation world's node handles.
@MainActor final class ComputerUseBrowser: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    var automating = false
    var onClose: (() -> Void)?
    let webView: WKWebView
    private(set) var allowedOrigins: Set<String> = []
    private(set) var blockedURL: String?
    private var observationID: String?
    private var observedURL: URL?
    private var observedAt = Date.distantPast
    private var window: NSWindow?
    private var navigationError: String?
    override init() {
        let configuration = WKWebViewConfiguration()
        // Browsing state is isolated from the dashboard and the user's other browsers, and never exported.
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 740), configuration: configuration)
        super.init()
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
    }
    func reset() { observationID = nil; allowedOrigins = []; webView.stopLoading() }
    func allow(origin: String) { allowedOrigins.insert(origin) }
    func show() {
        if window == nil {
            let created = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 740), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            created.title = "MultiVibe · Navigateur computer use"; created.contentView = webView
            created.isReleasedWhenClosed = false; created.minSize = NSSize(width: 640, height: 440); created.center(); created.delegate = self; window = created
        }
        window?.makeKeyAndOrderFront(nil)
    }
    func windowWillClose(_ notification: Notification) { onClose?() }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              let origin = try? ComputerUsePolicy.origin(url.absoluteString), (!automating || allowedOrigins.contains(origin)),
              navigationAction.targetFrame != nil else {
            blockedURL = navigationAction.request.url?.absoluteString
            decisionHandler(.cancel); return
        }
        // Invalidate even same-document navigations: handles belong to one observed page.
        if navigationAction.targetFrame?.isMainFrame == true { observationID = nil }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationError = error.localizedDescription }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationError = error.localizedDescription }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { observationID = nil; navigationError = "Le processus WebKit a été interrompu." }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        blockedURL = navigationAction.request.url?.absoluteString; return nil
    }
    // Dialogs and file selection remain user-owned; never accept a site's request automatically.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) { navigationError = "Dialogue du site : \(String(message.prefix(500)))"; completionHandler() }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) { navigationError = "Confirmation du site refusée : \(String(message.prefix(500)))"; completionHandler(false) }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) { navigationError = "Saisie du site requise : \(String(prompt.prefix(500)))"; completionHandler(nil) }
    private func settle() async throws {
        let deadline = Date().addingTimeInterval(20)
        while webView.isLoading {
            try Task.checkCancellation()
            guard Date() < deadline else { webView.stopLoading(); throw ComputerUseFailure("Chargement du site expiré. Observez son état avant de réessayer.") }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        try Task.checkCancellation()
        try await Task.sleep(nanoseconds: 180_000_000)
    }
    private func js(_ script: String, arguments: [String: Any] = [:]) async throws -> Any? {
        try Task.checkCancellation()
        return try await webView.callAsyncJavaScript(script, arguments: arguments, in: nil, contentWorld: .defaultClient)
    }
    func observe() async throws -> ComputerUseObservation {
        show(); try await settle()
        guard let url = webView.url, let origin = try? ComputerUsePolicy.origin(url.absoluteString), allowedOrigins.contains(origin) else {
            return .init(id: UUID().uuidString, target: "browser", text: "Navigateur prêt. Utilisez navigate avec une URL HTTP(S) pour commencer.\(blockedURL.map { "\nNavigation bloquée : \($0)" } ?? "")", image: nil, imageURL: nil)
        }
        let id = UUID().uuidString
        let value = try await js(Self.snapshotScript, arguments: ["token": id]) as? String ?? ""
        let configuration = WKSnapshotConfiguration(); configuration.snapshotWidth = 1200
        _ = try await js("globalThis.mvMasks=[];for(const e of document.querySelectorAll('input[type=password],input[autocomplete*=password],input[autocomplete=one-time-code],input[autocomplete^=cc-]')){const r=e.getBoundingClientRect(),m=document.createElement('div');Object.assign(m.style,{position:'fixed',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px',background:'#777',zIndex:'2147483647',pointerEvents:'none'});document.documentElement.append(m);globalThis.mvMasks.push(m);}")
        let image: NSImage
        do {
            image = try await webView.takeSnapshot(configuration: configuration)
        } catch {
            _ = try? await webView.callAsyncJavaScript("globalThis.mvMasks?.forEach(e=>e.remove());globalThis.mvMasks=[];", arguments: [:], in: nil, contentWorld: .defaultClient)
            throw error
        }
        _ = try? await webView.callAsyncJavaScript("globalThis.mvMasks?.forEach(e=>e.remove());globalThis.mvMasks=[];", arguments: [:], in: nil, contentWorld: .defaultClient)
        try Task.checkCancellation()
        guard webView.url == url, !webView.isLoading else { throw ComputerUseFailure("La page a changé pendant l’observation. Observez de nouveau.") }
        let preview = computerUseImage(image)
        observationID = id; observedURL = url; observedAt = Date()
        let text = "Observation: \(id)\nURL: \(url.absoluteString)\n\(value)\(blockedURL.map { "\nNavigation bloquée (autorisation nécessaire via navigate): \($0)" } ?? "")\(navigationError.map { "\nÉtat du site: \($0)" } ?? "")"
        return .init(id: id, target: "browser", text: text, image: preview?.0, imageURL: preview?.1)
    }
    func perform(_ command: ComputerUseCommand) async throws {
        try command.validate(); show()
        if command.action == "navigate" {
            let origin = try ComputerUsePolicy.origin(command.url ?? "")
            guard allowedOrigins.contains(origin), let url = URL(string: command.url ?? "") else { throw ComputerUseFailure("Site non autorisé.") }
            observationID = nil; blockedURL = nil; navigationError = nil
            webView.load(URLRequest(url: url)); try await settle()
            return
        }
        guard observationID != nil, command.observation == observationID, webView.url == observedURL,
              !webView.isLoading, Date().timeIntervalSince(observedAt) < 120 else { throw ComputerUseFailure("Observation du navigateur périmée. Observez avant d’agir.") }
        observationID = nil
        if command.action == "back" {
            guard webView.canGoBack else { throw ComputerUseFailure("Aucune page précédente.") }
            webView.goBack()
        } else if ["click", "double_click"].contains(command.action) {
            try await nativeClick(command)
        } else if command.action == "key" {
            try await nativeKey(command.key ?? "")
        } else if command.action == "drag" {
            try await nativeDrag(command)
        } else {
            let data = try JSONEncoder().encode(command)
            let object = try JSONSerialization.jsonObject(with: data)
            let result = try await js(Self.actionScript, arguments: ["command": object]) as? String
            if let result, result != "ok" { throw ComputerUseFailure(result) }
        }
        try await settle()
    }
    private func nativeClick(_ command: ComputerUseCommand) async throws {
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(command))
        let result = try await js("""
        const c=command,o=globalThis.mvObservation;if(!o||o.token!==c.observation)return {error:'Observation périmée.'};
        globalThis.mvObservation=null;
        const e=c.element?o.nodes[c.element-1]:document.elementFromPoint(c.x,c.y);
        if(!e||!e.isConnected||e.disabled)return {error:'Élément indisponible.'};
        if(e.closest('input[type=password],input[autocomplete*=password],input[autocomplete=one-time-code],input[autocomplete^=cc-]'))return {error:'Champ sécurisé : intervention humaine requise.'};
        const r=e.getBoundingClientRect(),x=c.element?r.x+r.width/2:c.x,y=c.element?r.y+r.height/2:c.y;
        if(x<0||y<0||x>=innerWidth||y>=innerHeight)return {error:'Point hors de la page.'};
        const hit=document.elementFromPoint(x,y);if(hit!==e&&!e.contains(hit))return {error:'Élément masqué. Observez de nouveau.'};
        return {x,y};
        """, arguments: ["command": object]) as? [String: Any]
        if let error = result?["error"] as? String { throw ComputerUseFailure(error) }
        guard let x = result?["x"] as? Double, let y = result?["y"] as? Double,
              let window = webView.window else { throw ComputerUseFailure("Point inaccessible.") }
        window.makeKeyAndOrderFront(nil)
        let location = webView.convert(NSPoint(x: x, y: (webView.isFlipped ? y : webView.bounds.height - y)), to: nil)
        for count in 1...(command.action == "double_click" ? 2 : 1) {
            try Task.checkCancellation()
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                guard let event = NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: count, clickCount: count, pressure: type == .leftMouseDown ? 1 : 0) else { throw ComputerUseFailure("Clic indisponible.") }
                event.cgEvent?.setIntegerValueField(.eventSourceUserData, value: ComputerUseMacDriver.eventMarker)
                let point = webView.convert(location, from: nil)
                let hit = webView.hitTest(point) ?? webView
                if type == .leftMouseDown { hit.mouseDown(with: event) } else { hit.mouseUp(with: event) }
            }
        }
        try await Task.sleep(nanoseconds: 150_000_000)
    }
    private func nativeKey(_ key: String) async throws {
        let isSecure = try await js("return !!document.activeElement?.closest('input[type=password],input[autocomplete*=password],input[autocomplete=one-time-code],input[autocomplete^=cc-]');") as? Bool ?? true
        guard !isSecure else { throw ComputerUseFailure("Champ sécurisé : intervention humaine requise.") }
        let codes: [String: UInt16] = ["return":36,"tab":48,"escape":53,"backspace":51,"delete":117,"up":126,"down":125,"left":123,"right":124,"home":115,"end":119,"pageup":116,"pagedown":121,"select_all":0,"copy":8,"paste":9,"undo":6,"redo":6]
        let characters = ["return":"\r", "tab":"\t", "escape":"\u{1b}", "backspace":"\u{7f}", "delete":"\u{f728}", "up":"\u{f700}", "down":"\u{f701}", "left":"\u{f702}", "right":"\u{f703}", "home":"\u{f729}", "end":"\u{f72b}", "pageup":"\u{f72c}", "pagedown":"\u{f72d}", "select_all":"a", "copy":"c", "paste":"v", "undo":"z", "redo":"z"]
        guard let code = codes[key], let character = characters[key], let window = webView.window else { throw ComputerUseFailure("Touche indisponible.") }
        let flags: NSEvent.ModifierFlags = ["select_all", "copy", "paste", "undo", "redo"].contains(key) ? (key == "redo" ? [.command, .shift] : .command) : []
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            try Task.checkCancellation()
            guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: character, charactersIgnoringModifiers: character, isARepeat: false, keyCode: code) else { throw ComputerUseFailure("Événement clavier indisponible.") }
            event.cgEvent?.setIntegerValueField(.eventSourceUserData, value: ComputerUseMacDriver.eventMarker)
            window.sendEvent(event)
        }
        try await Task.sleep(nanoseconds: 150_000_000)
    }
    private func nativeDrag(_ command: ComputerUseCommand) async throws {
        guard let x = command.x, let y = command.y, let toX = command.toX, let toY = command.toY,
              x < webView.bounds.width, toX < webView.bounds.width, y < webView.bounds.height, toY < webView.bounds.height,
              let window = webView.window else { throw ComputerUseFailure("Glisser hors de la fenêtre du navigateur.") }
        let start = webView.convert(NSPoint(x: x, y: (webView.isFlipped ? y : webView.bounds.height - y)), to: nil)
        let end = webView.convert(NSPoint(x: toX, y: (webView.isFlipped ? toY : webView.bounds.height - toY)), to: nil)
        func event(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent? {
            let e = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)
            e?.cgEvent?.setIntegerValueField(.eventSourceUserData, value: ComputerUseMacDriver.eventMarker); return e
        }
        if let down = event(.leftMouseDown, start) { window.sendEvent(down) }
        defer { if let up = event(.leftMouseUp, end) { window.sendEvent(up) } }
        for step in 1...12 {
            try Task.checkCancellation()
            let fraction = Double(step) / 12
            if let drag = event(.leftMouseDragged, NSPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)) { window.sendEvent(drag) }
            try await Task.sleep(nanoseconds: 15_000_000)
        }
    }
    // Only fixed scripts run in the isolated world. The model can supply data, never JavaScript.
    private static let snapshotScript = #"""
    const visible = e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none'; };
    const secret = e => e.matches('input[type=password],input[autocomplete*=password],input[autocomplete=one-time-code],input[autocomplete^=cc-]');
    const nodes=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=checkbox],[role=tab],[contenteditable=true],summary')).filter(visible).filter(e=>!secret(e)).slice(0,250);
    globalThis.mvObservation={token,nodes};
    const items=nodes.map((e,i)=>{const r=e.getBoundingClientRect();return {id:i+1,role:e.getAttribute('role')||e.tagName.toLowerCase(),label:(e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.innerText||e.labels?.[0]?.innerText||'').slice(0,200),value:(e.value||'').slice(0,300),disabled:!!e.disabled,rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]};});
    // Clone the DOM to redact editable values from the text observation without mutating the live page.
    const clone=document.body?.cloneNode(true); clone?.querySelectorAll('script,style,noscript,input,textarea,[contenteditable]').forEach(e=>e.remove());
    return JSON.stringify({title:document.title,viewport:[innerWidth,innerHeight],coordinateSpace:'CSS pixels relative to viewport; use element IDs when possible',text:(clone?.innerText||clone?.textContent||'').slice(0,14000),elements:items,frames:document.querySelectorAll('iframe').length});
    """#
    private static let actionScript = #"""
    const c=command,o=globalThis.mvObservation;
    if(!o||o.token!==c.observation)return 'Observation périmée.';
    globalThis.mvObservation=null;
    let e=c.element?o.nodes[c.element-1]:((c.x!=null&&c.y!=null)?document.elementFromPoint(c.x,c.y):document.activeElement);
    if(c.element&&(!e||!e.isConnected))return 'Élément périmé.';
    if(e?.closest('input[type=password],input[autocomplete*=password],input[autocomplete=one-time-code],input[autocomplete^=cc-]'))return 'Champ sécurisé : intervention humaine requise.';
    if(e?.disabled)return 'Élément désactivé.';
    if(['click','double_click'].includes(c.action)){
      if(!e)return 'Point hors de la page.';
      e.focus(); e.click();if(c.action==='double_click'){e.click();e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));}
    } else if(c.action==='type') {
      if(!e||e.tagName==='INPUT'&&e.type==='file')return 'Champ non modifiable.';
      e.focus();if(e.isContentEditable){e.textContent=c.text;}
      else {const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(!setter)return 'Champ non modifiable.';setter.call(e,c.text);}
      e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:c.text}));e.dispatchEvent(new Event('change',{bubbles:true}));
    } else if(c.action==='key') {
      const keys={return:'Enter',tab:'Tab',escape:'Escape',backspace:'Backspace',delete:'Delete',up:'ArrowUp',down:'ArrowDown',left:'ArrowLeft',right:'ArrowRight',home:'Home',end:'End',pageup:'PageUp',pagedown:'PageDown'};
      if(c.key==='select_all'){if(e?.select)e.select();else if(e?.isContentEditable){const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);}else return 'Champ non sélectionnable.';}
      else if(['copy','paste','undo','redo'].includes(c.key))return 'Utilisez les contrôles natifs du navigateur pour le presse-papiers et annuler.';
      else if(c.key==='tab'){const focusable=o.nodes.filter(n=>!n.disabled&&n.tabIndex>=0);focusable[(focusable.indexOf(e)+1)%focusable.length]?.focus();}
      else if(c.key==='return'&&e?.form){e.form.requestSubmit();}
      else {e?.dispatchEvent(new KeyboardEvent('keydown',{key:keys[c.key],bubbles:true}));e?.dispatchEvent(new KeyboardEvent('keyup',{key:keys[c.key],bubbles:true}));}
    } else if(c.action==='scroll'){
      const n=c.amount||500,vertical=['up','down'].includes(c.direction),delta=['up','left'].includes(c.direction)?-n:n;
      const box=e?.closest('[role=listbox],[role=dialog]')||e;let p=box;while(p&&p!==document.body&&!(vertical?p.scrollHeight>p.clientHeight&&['auto','scroll'].includes(getComputedStyle(p).overflowY):p.scrollWidth>p.clientWidth&&['auto','scroll'].includes(getComputedStyle(p).overflowX)))p=p.parentElement;
      (p||window).scrollBy({left:vertical?0:delta,top:vertical?delta:0,behavior:'instant'});
    } else if(c.action==='drag')return 'Le glisser-déposer du navigateur nécessite une application native autorisée.';
    else return 'Action navigateur inconnue.';
    return 'ok';
    """#
}
