import AppKit
import SwiftUI
import UserNotifications

extension MultiVibeMenuBarApp: UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.notification.request.identifier == "instance-pairing" {
            DispatchQueue.main.async { self.pairingWindow?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        }
        completionHandler()
    }
    func pollInstancePairing() {
        guard !pollingPairing, !isMenuPreview,
              var request = authorizedRequest(path: "/admin/instance-relay/v1", method: "GET") else { return }
        request.timeoutInterval = 10
        pollingPairing = true
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }; self.pollingPairing = false
                guard let data, (response as? HTTPURLResponse)?.statusCode == 200,
                      let status = try? JSONDecoder().decode(HarnessJSON.self, from: data) else { return }
                let requests = status["requests"].array
                let fresh = requests.filter { !self.announcedPairings.contains($0["id"].string ?? "") }
                self.announcedPairings = Set(requests.compactMap { $0["id"].string })
                guard !fresh.isEmpty else { return }
                if self.pairingWindow == nil {
                    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 480), styleMask: [.titled, .closable], backing: .buffered, defer: false)
                    window.title = "Connecter un iPhone"; window.isReleasedWhenClosed = false
                    window.contentView = NSHostingView(rootView: NativeInstancePairingView(close: { [weak window] in window?.close() }))
                    window.center(); self.pairingWindow = window
                }
                self.pairingWindow?.makeKeyAndOrderFront(nil)
                NSApp.requestUserAttention(.informationalRequest)
                let center = UNUserNotificationCenter.current()
                center.getNotificationSettings { settings in
                    guard settings.authorizationStatus == .authorized else { return }
                    let content = UNMutableNotificationContent()
                    content.title = "Un iPhone souhaite se connecter"
                    content.body = "Ouvrez MultiVibe sur ce Mac pour autoriser ou refuser l’appareil."
                    center.add(UNNotificationRequest(identifier: "instance-pairing", content: content, trigger: nil))
                }
            }
        }.resume()
    }
}
