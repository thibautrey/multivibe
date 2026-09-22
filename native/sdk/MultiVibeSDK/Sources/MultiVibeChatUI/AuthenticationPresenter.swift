import MultiVibeSDK
#if canImport(UIKit)
import AuthenticationServices
import UIKit
@MainActor public final class MultiVibeAuthenticationPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private weak var window: UIWindow?
    public init(window:UIWindow?) {self.window = window}
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {window ?? UIWindow()}
    public func signIn(client:MultiVibeClient) async throws {
        let authorization = try client.beginAuthorization()
        if await UIApplication.shared.open(authorization.url(broker:true),options:[.universalLinksOnly:true]) {return}
        try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Void,Error>) in
            let callback = ASWebAuthenticationSession.Callback.https(host:client.configuration.redirectURI.host ?? "",path:client.configuration.redirectURI.path)
            let auth = ASWebAuthenticationSession(url:authorization.url(broker:false),callback:callback) { url,error in
                Task { @MainActor in
                    if let url {do {try await client.handleOpenURL(url); continuation.resume()} catch {continuation.resume(throwing:error)}}
                    else {continuation.resume(throwing:error ?? MultiVibeError.cancelled)}
                }
            }
            auth.presentationContextProvider = self; auth.prefersEphemeralWebBrowserSession = false; session = auth
            if !auth.start() {session = nil; continuation.resume(throwing:MultiVibeError.authenticationRequired)}
        }
    }
}
#endif
