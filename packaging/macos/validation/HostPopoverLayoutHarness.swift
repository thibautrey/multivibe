import AppKit
import Foundation

@main
struct HostPopoverLayoutHarness {
    static func decode(_ json: String) -> MenuBarSummary {
        try! JSONDecoder().decode(MenuBarSummary.self, from: Data(json.utf8))
    }

    static func text(in view: NSView) -> [String] {
        let own = (view as? NSTextField).map { [$0.stringValue] } ?? []
        return own + view.subviews.flatMap(text)
    }

    static func render(_ summary: MenuBarSummary) -> HostPopoverController {
        let controller = HostPopoverController()
        controller.loadView()
        controller.view.frame = NSRect(
            origin: .zero,
            size: NSSize(width: MenuBarLayoutMetrics.width, height: MenuBarLayoutMetrics.height)
        )
        controller.render(
            summary: summary,
            status: "Ready",
            operational: true,
            updateStatus: nil,
            updateBusy: false,
            startAtLogin: true
        )
        controller.view.layoutSubtreeIfNeeded()
        return controller
    }

    static func snapshot(_ controller: HostPopoverController, name: String, directory: String?) {
        guard let directory else { return }
        let url = URL(fileURLWithPath: directory, isDirectory: true)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let bounds = controller.view.bounds
        guard let bitmap = controller.view.bitmapImageRepForCachingDisplay(in: bounds) else { return }
        controller.view.cacheDisplay(in: bounds, to: bitmap)
        let data = bitmap.representation(using: .png, properties: [:])!
        try! data.write(to: url.appendingPathComponent(name + ".png"))
    }

    static func main() {
        _ = NSApplication.shared
        let screenshotDirectory = CommandLine.arguments.dropFirst().first

        let creditProvider = try! JSONDecoder().decode(ProviderQuota.self, from: Data(#"{"id":"openai","displayName":"OpenAI","accounts":[],"windows":[{"label":"5h","remainingPercent":0,"accountCount":2}],"balance":{"remaining":32.5,"unit":"credits","accountCount":2},"preferBalance":true}"#.utf8))
        precondition(providerQuotaText(creditProvider) == "32.50 credits")
        let quotaProvider = try! JSONDecoder().decode(ProviderQuota.self, from: Data(#"{"id":"openai","displayName":"OpenAI","accounts":[],"windows":[{"label":"5h","remainingPercent":25,"accountCount":2}],"balance":{"remaining":32.5,"unit":"credits","accountCount":2}}"#.utf8))
        precondition(providerQuotaText(quotaProvider) == "5h:25%")


        let unavailable = decode(#"""
        {
          "operational": true,
          "providers": [{
            "id": "zai",
            "displayName": "z.ai",
            "accounts": [{
              "displayName": "z.ai · contact@pleiades.solutions",
              "enabled": true,
              "status": "ready",
              "usageStatus": "unsupported"
            }],
            "windows": []
          }],
          "accounts": [],
          "quota": {"fiveHourAccountCount": 0, "weeklyAccountCount": 0},
          "extensionWidgets": [{
            "id": "context",
            "extensionId": "token-monitor",
            "title": "Context Monitor",
            "subtitle": "Extension widget",
            "systemImage": "gauge.with.dots.needle.50percent",
            "presentation": "progress",
            "label": "Current context",
            "value": "42%",
            "detail": "42k of 100k tokens",
            "badge": "Live",
            "progressPercent": 42
          }],
          "earnings": {"available": false, "currency": null, "today": null, "week": null, "month": null, "lifetime": null}
        }
        """#)
        let unavailableController = render(unavailable)
        let unavailableText = text(in: unavailableController.view)
        precondition(unavailableController.contentStack.spacing == MenuBarSpacing.large)
        precondition(unavailableController.contentStack.edgeInsets.left == MenuBarLayoutMetrics.contentInset)
        precondition(unavailableController.contentStack.edgeInsets.right == MenuBarLayoutMetrics.contentInset)
        precondition(unavailableText.contains("Quota unavailable"))
        precondition(unavailableText.contains("Context Monitor"))
        precondition(unavailableText.contains("Current context"))
        precondition(unavailableText.contains("42%"))
        precondition(!unavailableText.contains("CAPACITY"))
        precondition(!unavailableText.contains("ACCOUNTS · 1"))
        precondition(unavailableController.extensionSection.arrangedSubviews.count == 2)
        snapshot(unavailableController, name: "quota-unavailable", directory: screenshotDirectory)

        let capacity = decode(#"""
        {
          "operational": true,
          "providers": [{
            "id": "openai",
            "displayName": "OpenAI",
            "accounts": [{
              "displayName": "thibautrey81@gmail.com",
              "enabled": true,
              "status": "ready",
              "usageStatus": "available",
              "weekly": {"label": "Weekly", "remainingPercent": 95, "resetAt": 1800000000000}
            }],
            "windows": [{"label": "Weekly", "remainingPercent": 95, "accountCount": 1}]
          }],
          "accounts": [],
          "quota": {"fiveHourAccountCount": 0, "weeklyAccountCount": 1, "weeklyRemainingPercent": 95},
          "earnings": {"available": false, "currency": null, "today": null, "week": null, "month": null, "lifetime": null}
        }
        """#)
        let capacityController = render(capacity)
        let capacityText = text(in: capacityController.view)
        precondition(capacityText.contains("Weekly capacity"))
        precondition(capacityText.contains("95%"))
        precondition(!capacityController.contentStack.arrangedSubviews.contains { $0 === capacityController.extensionSection })
        snapshot(capacityController, name: "weekly-capacity", directory: screenshotDirectory)

        let account = #"{"displayName":"OpenAI-compatible account","enabled":true,"status":"ready","usageStatus":"pending"}"#
        let multiple = decode("""
        {
          "operational": true,
          "providers": [{
            "id": "openai-compatible",
            "displayName": "OpenAI-compatible",
            "accounts": [\(account), \(account), \(account), \(account)],
            "windows": []
          }],
          "accounts": [],
          "quota": {"fiveHourAccountCount": 0, "weeklyAccountCount": 0},
          "earnings": {"available": false, "currency": null, "today": null, "week": null, "month": null, "lifetime": null}
        }
        """)
        let multipleController = render(multiple)
        let multipleText = text(in: multipleController.view)
        precondition(multipleText.contains("Accounts ready"))
        precondition(multipleText.contains("4/4"))
        precondition(multipleText.contains("ACCOUNTS"))
        precondition(!multipleText.contains("CAPACITY"))
        snapshot(multipleController, name: "multiple-accounts", directory: screenshotDirectory)

        print("PASS macOS menu popover layout and extension widgets")
    }
}
