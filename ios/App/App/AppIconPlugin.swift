import Capacitor
import UIKit

/// Alternate icons are only requested by an explicit appearance selection.
@objc(AppIconPlugin)
public final class AppIconPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppIconPlugin"
    public let jsName = "AppIcon"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setTheme", returnType: CAPPluginReturnPromise)
    ]

    @objc func setTheme(_ call: CAPPluginCall) {
        guard let theme = call.getString("theme"), ["plum", "forest", "midnight"].contains(theme) else {
            call.reject("Unsupported appearance theme.", "INVALID_THEME")
            return
        }
        let iconName: String? = theme == "plum" ? nil : (theme == "forest" ? "AppIconForest" : "AppIconMidnight")
        DispatchQueue.main.async {
            let application = UIApplication.shared
            guard application.supportsAlternateIcons else {
                call.resolve(["status": "unsupported", "theme": theme])
                return
            }
            guard application.alternateIconName != iconName else {
                call.resolve(["status": "unchanged", "theme": theme])
                return
            }
            // Use Apple's public API, including its normal system confirmation.
            application.setAlternateIconName(iconName) { error in
                if let error = error {
                    call.reject("The app icon could not change. Your theme is still saved.", "ICON_UPDATE_FAILED", error)
                } else {
                    call.resolve(["status": "updated", "theme": theme])
                }
            }
        }
    }
}
