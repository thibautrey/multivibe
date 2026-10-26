import XCTest
import SwiftUI
@testable import MultiVibeChat

final class RelayUsageTests: XCTestCase {
    let account = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    func allowance(_ overrides: [String: Any] = [:]) -> [String: Any] {
        ["periodStart": "2026-10-01", "periodEnd": "2026-11-01", "included": 250, "used": 37, "reserved": 2, "remaining": 211, "unlimited": false].merging(overrides) { _, new in new }
    }
    func fixture(started: Int = 37, unknown: Int = 0) -> [String: Any] {
        let daily: [[String: Any]] = (20...26).map { day in
            ["date": "2026-10-\(day)", "started": day == 26 ? started : 0, "pending": 0, "released": 0, "unclassified": day == 26 ? unknown : 0]
        }
        let groups: [[String: Any]] = started == 0 ? [] : [["id": "model", "name": "MultiVibe Host", "started": started]]
        return ["accountId": account, "from": "2026-10-20T00:00:00.000Z", "to": "2026-10-26T12:00:00.000Z", "days": 7,
            "allowance": allowance(), "summary": ["started": started, "pending": 0, "released": 0, "unclassified": unknown],
            "daily": daily, "models": groups, "machines": groups]
    }
    func decode(_ object: [String: Any]) throws -> RelayUsage { try JSONDecoder().decode(RelayUsage.self, from: JSONSerialization.data(withJSONObject: object)) }
    func testQuotaSubtractsReservationsAndPreservesUnlimited() throws {
        func read(_ object: [String: Any]) throws -> RelayAllowance { try JSONDecoder().decode(RelayAllowance.self, from: JSONSerialization.data(withJSONObject: object)) }
        XCTAssertEqual(try read(allowance()).remainingLabel, "211")
        let unlimited = try read(allowance(["remaining": NSNull(), "unlimited": true]))
        XCTAssertNil(unlimited.remaining); XCTAssertEqual(unlimited.remainingLabel, "Illimités")
        for changes: [String: Any] in [["remaining": NSNull()], ["remaining": 250], ["used": -1], ["reserved": 300], ["unlimited": true], ["periodEnd": "2026-02-30"], ["periodEnd": "2026-09-01"]] {
            XCTAssertThrowsError(try read(allowance(changes)))
        }
    }
    func testUsageRequiresMatchingAccountPeriodAndReconciledTotals() throws {
        let value = try decode(fixture())
        XCTAssertNoThrow(try value.validate(accountID: account, days: 7))
        XCTAssertThrowsError(try value.validate(accountID: "another-account", days: 7))
        XCTAssertThrowsError(try value.validate(accountID: account, days: 30))
        var invalid = fixture(); invalid["models"] = []
        XCTAssertThrowsError(try decode(invalid).validate(accountID: account, days: 7))
        invalid = fixture(); invalid["summary"] = ["started": 38, "pending": 0, "released": 0, "unclassified": 0]
        XCTAssertThrowsError(try decode(invalid).validate(accountID: account, days: 7))
    }
    func testEmptyAndIncompleteHistoryAreSeparate() throws {
        let value = try decode(fixture(started: 0, unknown: 24))
        XCTAssertNoThrow(try value.validate(accountID: account, days: 7))
        XCTAssertEqual(value.summary.started, 0); XCTAssertEqual(value.summary.unclassified, 24)
        XCTAssertTrue(value.models.isEmpty)
    }
    func testDailyBucketsRejectDuplicateAndInvalidDates() throws {
        var value = fixture(), daily = try XCTUnwrap(value["daily"] as? [[String: Any]])
        daily[0]["date"] = "2026-10-26"; value["daily"] = daily
        XCTAssertThrowsError(try decode(value).validate(accountID: account, days: 7))
        daily[0]["date"] = "2026-02-30"; value["daily"] = daily
        XCTAssertThrowsError(try decode(value).validate(accountID: account, days: 7))
    }
    func testRequestsStayOnTheFirstPartyBearerEndpoint() throws {
        let quota = try RelayUsageAPI.request(token: "synthetic-session")
        XCTAssertEqual(quota.url?.absoluteString, "https://app.multivibe.cloud/relay/v1/allowance")
        let usage = try RelayUsageAPI.request(days: 90, token: "synthetic-session")
        XCTAssertEqual(usage.url?.absoluteString, "https://app.multivibe.cloud/relay/v1/usage?days=90")
        XCTAssertEqual(usage.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-session")
        XCTAssertNil(usage.httpBody); XCTAssertNil(usage.value(forHTTPHeaderField: "Cookie"))
        XCTAssertThrowsError(try RelayUsageAPI.request(days: 365, token: "synthetic-session"))
    }
    @MainActor func testDashboardRendersQuotaChartsAndEmptyState() throws {
        for (name, value, dark, size) in [
            ("relay-light", fixture(), false, DynamicTypeSize.large),
            ("relay-dark", fixture(), true, .large),
            ("relay-large-text", fixture(), false, .accessibility2),
            ("relay-empty", fixture(started: 0, unknown: 24), false, .large),
            ("relay-unlimited", fixture().merging(["allowance": allowance(["unlimited": true, "remaining": NSNull()])]) { _, new in new }, false, .large)
        ] {
            let renderer = ImageRenderer(content: RelayUsageDashboard(usage: try decode(value))
                .padding(20).frame(width: 390).background(MultiVibeTheme.softAccent)
                .environment(\.colorScheme, dark ? .dark : .light).environment(\.dynamicTypeSize, size))
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.uiImage)
            XCTAssertGreaterThan(image.size.height, 300)
            let attachment = XCTAttachment(image: image); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
    }
}
