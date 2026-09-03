import AuthenticationServices
import Capacitor
import Security
import UIKit

/// Presents Clerk's web authentication flow and stores its client token in the
/// device-only keychain. All session state is owned by one plugin instance so a
/// second sign-in cannot replace a callback that is already in flight.
@objc(NativeWebAuthPlugin)
public final class NativeWebAuthPlugin: CAPPlugin, CAPBridgedPlugin,
    ASWebAuthenticationPresentationContextProviding {
    public let identifier = "NativeWebAuthPlugin"
    public let jsName = "NativeWebAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readClientToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeClientToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteClientToken", returnType: CAPPluginReturnPromise)
    ]

    private static let callbackURLString = "com.simerfamily.kinsphere://callback"
    private static let callbackScheme = "com.simerfamily.kinsphere"
    private static let callbackHost = "callback"
    private static let clientTokenAccount = "__clerk_client_jwt"
    private static let clientTokenService =
        "\(Bundle.main.bundleIdentifier ?? "com.simerfamily.kinsphere").clerk-native-client"

    private var authenticationSession: ASWebAuthenticationSession?
    private var pendingCall: CAPPluginCall?
    private var presentationWindow: UIWindow?

    /// Validates the browser and callback URLs before opening an iOS-managed
    /// authentication session. Only HTTPS providers may enter the native flow.
    @objc func authenticate(_ call: CAPPluginCall) {
        guard let authURLString = call.getString("url"),
              let authComponents = URLComponents(string: authURLString),
              authComponents.scheme?.lowercased() == "https",
              let authHost = authComponents.host,
              !authHost.isEmpty,
              authComponents.user == nil,
              authComponents.password == nil,
              let authURL = authComponents.url else {
            call.reject(
                "The authentication URL must be a valid HTTPS URL.",
                "INVALID_AUTH_URL"
            )
            return
        }

        guard call.getString("callbackUrl") == Self.callbackURLString else {
            call.reject(
                "The authentication callback URL is not supported.",
                "INVALID_CALLBACK_URL"
            )
            return
        }

        let prefersEphemeralSession = call.getBool("ephemeral") ?? false

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.authenticationSession == nil else {
                call.reject(
                    "An authentication session is already in progress.",
                    "AUTH_IN_PROGRESS"
                )
                return
            }
            guard let window = self.bridge?.viewController?.viewIfLoaded?.window else {
                call.reject(
                    "The authentication screen could not be presented.",
                    "PRESENTATION_UNAVAILABLE"
                )
                return
            }

            let completion: ASWebAuthenticationSession.CompletionHandler = {
                [weak self] callbackURL, error in
                DispatchQueue.main.async {
                    self?.finishAuthentication(
                        callbackURL: callbackURL,
                        error: error
                    )
                }
            }

            let session: ASWebAuthenticationSession
            if #available(iOS 17.4, *) {
                session = ASWebAuthenticationSession(
                    url: authURL,
                    callback: .customScheme(Self.callbackScheme),
                    completionHandler: completion
                )
            } else {
                session = ASWebAuthenticationSession(
                    url: authURL,
                    callbackURLScheme: Self.callbackScheme,
                    completionHandler: completion
                )
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = prefersEphemeralSession
            self.presentationWindow = window
            self.pendingCall = call
            self.authenticationSession = session

            guard session.start() else {
                let pendingCall = self.clearAuthenticationState()
                pendingCall?.reject(
                    "The authentication session could not be started.",
                    "AUTH_START_FAILED"
                )
                return
            }
        }
    }

    /// Cancels the active browser session, if one exists.
    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let session = self.authenticationSession else {
                call.resolve(["cancelled": false])
                return
            }

            session.cancel()
            call.resolve(["cancelled": true])
        }
    }

    /// Reads the persisted Clerk client token without exposing other keychain
    /// records to JavaScript.
    @objc func readClientToken(_ call: CAPPluginCall) {
        var query = clientTokenQuery()
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }

        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty else {
            call.reject(
                "The secure sign-in session could not be read.",
                "KEYCHAIN_READ_FAILED"
            )
            return
        }

        call.resolve(["value": value])
    }

    /// Updates or creates the device-local Clerk client token.
    @objc func writeClientToken(_ call: CAPPluginCall) {
        guard let value = call.getString("value"),
              !value.isEmpty,
              let data = value.data(using: .utf8) else {
            call.reject(
                "A valid sign-in session is required.",
                "INVALID_CLIENT_TOKEN"
            )
            return
        }

        let query = clientTokenQuery()
        let updateStatus = SecItemUpdate(
            query as CFDictionary,
            [kSecValueData: data] as CFDictionary
        )

        if updateStatus == errSecSuccess {
            call.resolve()
            return
        }

        guard updateStatus == errSecItemNotFound else {
            call.reject(
                "The secure sign-in session could not be updated.",
                "KEYCHAIN_WRITE_FAILED"
            )
            return
        }

        var item = query
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(item as CFDictionary, nil)

        guard addStatus == errSecSuccess else {
            call.reject(
                "The secure sign-in session could not be saved.",
                "KEYCHAIN_WRITE_FAILED"
            )
            return
        }

        call.resolve()
    }

    /// Removes the persisted Clerk client token. Deleting a missing item is a
    /// successful, idempotent operation.
    @objc func deleteClientToken(_ call: CAPPluginCall) {
        let status = SecItemDelete(clientTokenQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject(
                "The secure sign-in session could not be removed.",
                "KEYCHAIN_DELETE_FAILED"
            )
            return
        }

        call.resolve()
    }

    /// Supplies the foreground window that owns the native authentication sheet.
    public func presentationAnchor(
        for session: ASWebAuthenticationSession
    ) -> ASPresentationAnchor {
        // authenticate(_:) normally establishes this value immediately before
        // start(). The active-window fallback keeps an unexpected lifecycle race
        // from crashing the application while iOS asks for its presentation host.
        if let presentationWindow {
            return presentationWindow
        }

        if let activeWindow = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) {
            return activeWindow
        }

        assertionFailure("Native web authentication has no presentation window.")
        return ASPresentationAnchor(frame: .zero)
    }

    /// Resolves the pending Capacitor call once and clears native session state
    /// before invoking JavaScript, preventing re-entrant completions.
    private func finishAuthentication(callbackURL: URL?, error: Error?) {
        dispatchPrecondition(condition: .onQueue(.main))

        let call = clearAuthenticationState()
        guard let call else { return }

        if let error {
            let nsError = error as NSError
            if nsError.domain == ASWebAuthenticationSessionError.errorDomain,
               nsError.code == ASWebAuthenticationSessionError.Code.canceledLogin.rawValue {
                call.reject(
                    "Authentication was cancelled.",
                    "AUTH_CANCELLED",
                    error
                )
            } else {
                call.reject(
                    "Authentication could not be completed.",
                    "AUTH_FAILED",
                    error
                )
            }
            return
        }

        guard let callbackURL,
              isExpectedCallbackURL(callbackURL) else {
            call.reject(
                "The authentication service returned an invalid callback URL.",
                "INVALID_CALLBACK_URL"
            )
            return
        }

        // Return the complete URL unchanged so Clerk can verify its state and nonce.
        call.resolve(["callbackUrl": callbackURL.absoluteString])
    }

    /// Accepts only the app-owned callback origin, with no alternate authority or
    /// path that could bypass Clerk's state and nonce verification.
    private func isExpectedCallbackURL(_ url: URL) -> Bool {
        guard let components = URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
        ) else {
            return false
        }

        return components.scheme?.lowercased() == Self.callbackScheme
            && components.host?.lowercased() == Self.callbackHost
            && components.path.isEmpty
            && components.user == nil
            && components.password == nil
            && components.port == nil
    }

    /// Builds the narrow keychain selector shared by read, update, and delete.
    private func clientTokenQuery() -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: Self.clientTokenService,
            kSecAttrAccount: Self.clientTokenAccount
        ]
    }

    /// Releases all per-request state and returns the call that must be completed.
    @discardableResult
    private func clearAuthenticationState() -> CAPPluginCall? {
        dispatchPrecondition(condition: .onQueue(.main))

        let call = pendingCall
        pendingCall = nil
        authenticationSession = nil
        presentationWindow = nil
        return call
    }
}
