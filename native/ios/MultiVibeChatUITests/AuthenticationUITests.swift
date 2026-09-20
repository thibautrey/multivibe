import XCTest

/// Run on a disposable simulator with no saved account. These tests never submit
/// credentials or request a recovery email. SSO tests open the first-party browser only.
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
        let login = app.buttons["openAuthentication"].firstMatch
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
        XCTAssertTrue(app.descendants(matching: .any)["localModelStatus"].exists)
        XCTAssertFalse(app.staticTexts["Connectez-vous pour envoyer un message."].exists)
        message.tap()
        message.typeText("Bonjour MultiVibe")
        app.buttons["openAuthentication"].firstMatch.tap()
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
        XCTAssertTrue(app.buttons["signInWithGoogle"].exists)
        XCTAssertTrue(app.buttons["signInWithGitHub"].exists)
        XCTAssertTrue(app.buttons["signInWithApple"].exists)
        let google = app.buttons["signInWithGoogle"]
        let github = app.buttons["signInWithGitHub"]
        XCTAssertEqual(google.label, "Continuer avec Google")
        XCTAssertEqual(github.label, "Continuer avec GitHub")
        XCTAssertLessThan(abs(google.frame.midY - github.frame.midY), 2)
        XCTAssertLessThanOrEqual(google.frame.maxX, github.frame.minX)
        for button in [google, github] {
            XCTAssertGreaterThanOrEqual(button.frame.height, 44)
            XCTAssertLessThanOrEqual(button.frame.height, 56)
        }
        XCTAssertTrue(app.buttons["Autre fournisseur SSO"].exists)
        app.buttons["Créer un compte"].tap()
        XCTAssertTrue(app.secureTextFields["Confirmer le mot de passe"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["submitAuthentication"].isEnabled)
        app.swipeUp()
        app.buttons["J’ai déjà un compte"].tap()
        XCTAssertTrue(app.buttons["submitAuthentication"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.secureTextFields["Confirmer le mot de passe"].exists)
    }

    func testGoogleTapPresentsSecureAuthenticationOrAssociationDiagnostic() {
        assertSSOTap(provider: "Google")
    }

    func testGitHubTapPresentsSecureAuthenticationOrAssociationDiagnostic() {
        assertSSOTap(provider: "GitHub")
    }

    func testAppleTapPresentsSecureAuthenticationOrAssociationDiagnostic() {
        assertSSOTap(provider: "Apple")
    }

    private func assertSSOTap(provider: String) {
        let app = launch()
        let consent = app.switches["J’accepte les conditions d’utilisation"]
        app.swipeUp()
        XCTAssertTrue(consent.waitForExistence(timeout: 5))
        if consent.value as? String != "1" { consent.tap() }
        let button = app.buttons["signInWith" + provider]
        XCTAssertTrue(button.isEnabled)
        button.tap()
        // Opening the first-party SSO window does not submit provider credentials.
        let browser = app.webViews.firstMatch
        let presented = browser.waitForExistence(timeout: 15)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = provider.lowercased() + "-after-tap"
        capture.lifetime = .keepAlways
        add(capture)
        // Unsigned simulators / an unconfigured AASA cannot open HTTPS SSO.
        // Accept only that precise diagnostic, never an arbitrary error or no-op.
        if !presented {
            let failure = app.staticTexts["nativeSSOError"]
            XCTAssertTrue(failure.exists, "SSO must not silently swallow a presentation failure")
            XCTAssertTrue(failure.label.contains("n’est pas associé à cette application"))
            XCTAssertTrue(failure.isHittable, "The configuration diagnostic must be visible beside SSO controls")
            XCTAssertTrue(button.isEnabled, "A failed attempt must allow retry")
        }
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

final class LocalInternetUITests: XCTestCase {
    func testLocalWebPermissionCanBeDeniedOnceWithoutSigningIn() throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("Requires a physical device with Apple Intelligence ready")
        #else
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(fr)", "-AppleLocale", "fr_FR"]
        app.launch()
        let newConversation = app.buttons["Nouvelle conversation"].firstMatch
        XCTAssertTrue(newConversation.waitForExistence(timeout: 10))
        newConversation.tap()
        let message = app.descendants(matching: .any).matching(identifier: "Message").firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        message.tap()
        message.typeText("Utilise maintenant local_workspace, action fetch_website, query https://example.com, lhs 0. Consulte cette page et résume son contenu.")
        app.buttons["Envoyer"].tap()
        let deny = app.buttons["denyConversationInternet"]
        XCTAssertTrue(deny.waitForExistence(timeout: 40), "The first network call must ask permission")
        XCTAssertFalse(app.textFields["Adresse e-mail"].exists)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "local-internet-consent"
        capture.lifetime = .keepAlways
        add(capture)
        deny.tap()
        XCTAssertTrue(deny.waitForNonExistence(timeout: 5))
        let stop = app.buttons["Arrêter"]
        XCTAssertTrue(stop.waitForNonExistence(timeout: 40))
        message.tap()
        message.typeText("Utilise encore fetch_website sur https://example.com.")
        app.buttons["Envoyer"].tap()
        XCTAssertTrue(stop.waitForNonExistence(timeout: 40))
        XCTAssertFalse(deny.exists, "A refusal must not trigger another prompt in this conversation")
        #endif
    }
}
