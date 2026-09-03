import UIKit
import Capacitor

@main
/// Configures the UIKit scene that hosts the app's single Capacitor bridge.
final class AppDelegate: UIResponder, UIApplicationDelegate {
    /// Creates the single Capacitor scene used by the installed iOS app.
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(
            name: "Default Configuration",
            sessionRole: connectingSceneSession.role
        )
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}
