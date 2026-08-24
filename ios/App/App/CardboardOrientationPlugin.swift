import Capacitor
import UIKit

@objc(CardboardOrientationPlugin)
public final class CardboardOrientationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CardboardOrientationPlugin"
    public let jsName = "CardboardOrientation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestLandscape", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restoreAppOrientation", returnType: CAPPluginReturnPromise)
    ]

    @objc func requestLandscape(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let controller = self?.bridge?.viewController as? AppBridgeViewController else {
                call.reject(
                    "The Bubble app view is not available.",
                    "ORIENTATION_CONTROLLER_UNAVAILABLE"
                )
                return
            }

            controller.requestCardboardLandscape()
            call.resolve(["orientation": "landscape"])
        }
    }

    @objc func restoreAppOrientation(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let controller = self?.bridge?.viewController as? AppBridgeViewController else {
                call.reject(
                    "The Bubble app view is not available.",
                    "ORIENTATION_CONTROLLER_UNAVAILABLE"
                )
                return
            }

            controller.restoreAppPortraitOrientation()
            call.resolve(["orientation": "portrait"])
        }
    }
}
