import XCTest

/// Run on a disposable simulator with no saved account. These tests never submit
/// credentials, open an external SSO session, or request a recovery email.
@MainActor
final class AuthenticationUITests: XCTestCase {
    private func launch(dark: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(fr)", "-AppleLocale", "fr_FR"]
        // Set simulator appearance externally with simctl ui before the dark-only run.
        // AppleInterfaceStyle launch arguments do not reliably override UIKit traits.
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "Message").firstMatch.waitForExistence(timeout: 15))
        let login = app.buttons["openAuthentication"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: login)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
        login.tap()
        XCTAssertTrue(app.textFields["Adresse e-mail"].waitForExistence(timeout: 15))
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = dark ? "login-dark" : "login-light"
        capture.lifetime = .keepAlways
        add(capture)
        return app
    }

    func testGuestChatOpensFirstAndRetainsDraftAfterDismissingLogin() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(fr)", "-AppleLocale", "fr_FR"]
        app.launch()
        let message = app.descendants(matching: .any).matching(identifier: "Message").firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 15))
        XCTAssertFalse(app.textFields["Adresse e-mail"].exists)
        XCTAssertFalse(app.buttons["guestSend"].isEnabled)
        message.tap()
        message.typeText("Bonjour MultiVibe")
        app.buttons["guestSend"].tap()
        XCTAssertTrue(app.textFields["Adresse e-mail"].waitForExistence(timeout: 5))
        app.buttons["Fermer la connexion"].tap()
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertEqual(message.value as? String, "Bonjour MultiVibe")
    }

    func testDarkLoginKeepsNativeSecureFieldsAndDismissal() {
        let app = launch(dark: true)
        XCTAssertTrue(app.secureTextFields["Mot de passe"].exists)
        XCTAssertFalse(app.buttons["submitAuthentication"].isEnabled)
        app.buttons["Fermer la connexion"].tap()
        XCTAssertTrue(app.buttons["openAuthentication"].waitForExistence(timeout: 5))
    }

    func testEmptyLoginAndSignupRemainDisabled() {
        let app = launch()
        XCTAssertTrue(app.secureTextFields["Mot de passe"].exists)
        XCTAssertFalse(app.buttons["submitAuthentication"].isEnabled)
        XCTAssertTrue(app.buttons["Continuer avec le SSO"].exists)
        app.buttons["Créer un compte"].tap()
        XCTAssertTrue(app.secureTextFields["Confirmer le mot de passe"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["submitAuthentication"].isEnabled)
        app.swipeUp()
        app.buttons["J’ai déjà un compte"].tap()
        XCTAssertTrue(app.buttons["submitAuthentication"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.secureTextFields["Confirmer le mot de passe"].exists)
    }

    func testRecoveryUsesNativeSheetWithoutSubmitting() {
        let app = launch()
        app.buttons["Mot de passe oublié ?"].tap()
        XCTAssertTrue(app.buttons["Envoyer le lien"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Envoyer le lien"].isEnabled)
        XCTAssertTrue(app.secureTextFields["Lien de réinitialisation"].exists)
        XCTAssertFalse(app.buttons["Changer mon mot de passe"].isEnabled)
        app.buttons["Terminé"].tap()
        XCTAssertTrue(app.buttons["submitAuthentication"].waitForExistence(timeout: 5))
    }
}
