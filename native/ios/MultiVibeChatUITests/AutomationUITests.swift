import XCTest

final class AutomationUITests: XCTestCase {
    func testAutomationListAndDetailsOnDevice() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-local-agent-ui-fixture", "-automation-ui-fixture"]
        app.launch()
        if !app.buttons["openAutomations"].waitForExistence(timeout: 5) {
            let back = app.navigationBars.buttons.firstMatch
            if back.exists { back.tap() }
        }
        let entry = app.buttons["openAutomations"]
        if entry.exists { entry.tap() }
        else {
            let link = app.staticTexts["Automatisations"].firstMatch
            XCTAssertTrue(link.waitForExistence(timeout: 5)); link.tap()
        }
        let item = app.staticTexts["Briefing du matin"].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10))
        let list = XCTAttachment(screenshot: app.screenshot()); list.name = "Automations list"; list.lifetime = .keepAlways; add(list)
        let schedule = app.buttons["scheduleAutomation"]
        XCTAssertTrue(schedule.waitForExistence(timeout: 5)); schedule.tap()
        XCTAssertTrue(app.textFields["automationTitle"].waitForExistence(timeout: 5))
        let editor = XCTAttachment(screenshot: app.screenshot()); editor.name = "Automation editor"; editor.lifetime = .keepAlways; add(editor)
        app.buttons["Annuler"].tap()
        XCTAssertTrue(item.waitForExistence(timeout: 5)); item.tap()
        XCTAssertTrue(app.staticTexts["Prépare mon briefing"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Reprendre"].exists)
        let detail = XCTAttachment(screenshot: app.screenshot()); detail.name = "Automation details"; detail.lifetime = .keepAlways; add(detail)
        let delete = app.buttons["Supprimer"].firstMatch
        XCTAssertTrue(delete.exists)
        delete.tap()
        XCTAssertTrue(app.staticTexts["La planification et son historique d’exécution seront supprimés."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Supprimer"].exists)
    }
}
