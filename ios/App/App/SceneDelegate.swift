import UIKit
import Capacitor

/// Owns Capacitor plugins, orientation policy, and native safe-area delivery.
final class AppBridgeViewController: CAPBridgeViewController {
    private var appOrientationMask: UIInterfaceOrientationMask = .portrait
    private var preferredAppOrientation: UIInterfaceOrientation = .portrait
    private var viewportGeometrySyncScheduled = false
    private var settledViewportGeometryWorkItem: DispatchWorkItem?

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        appOrientationMask
    }

    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        preferredAppOrientation
    }

    /// Registers repository-owned native plugins after Capacitor is ready.
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PanoramaCapturePlugin())
        bridge?.registerPluginInstance(CardboardOrientationPlugin())
        bridge?.registerPluginInstance(CardboardPanoramaPlugin())
        bridge?.registerPluginInstance(CapsuleRecapPlugin())
        bridge?.registerPluginInstance(NativeWebAuthPlugin())
    }

    /// Publishes the first settled safe-area geometry after presentation.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        synchronizeViewportGeometry()
    }

    /// Republishes native geometry whenever UIKit changes safe-area insets.
    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        synchronizeViewportGeometry()
    }

    /// Waits for rotation layout to finish before publishing its new viewport.
    override func viewWillTransition(
        to size: CGSize,
        with coordinator: UIViewControllerTransitionCoordinator
    ) {
        super.viewWillTransition(to: size, with: coordinator)

        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            self?.synchronizeViewportGeometry()
        }
    }

    /// Selects the one landscape handedness used by Cardboard calibration.
    func requestCardboardLandscape() {
        updateAppOrientation(
            // Google Cardboard's iOS presentation is calibrated for one fixed
            // landscape handedness. Allowing the phone to flip 180 degrees in
            // the headset makes the tracker and optical mesh disagree.
            mask: .landscapeRight,
            preferred: .landscapeRight
        )
    }

    /// Restores the portrait orientation expected by all non-VR routes.
    func restoreAppPortraitOrientation() {
        updateAppOrientation(mask: .portrait, preferred: .portrait)
    }

    /// Applies a controller mask and requests matching scene geometry.
    private func updateAppOrientation(
        mask: UIInterfaceOrientationMask,
        preferred: UIInterfaceOrientation
    ) {
        dispatchPrecondition(condition: .onQueue(.main))

        appOrientationMask = mask
        preferredAppOrientation = preferred

        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
        } else {
            UIDevice.current.setValue(preferred.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }

        guard let windowScene = viewIfLoaded?.window?.windowScene else {
            synchronizeViewportGeometry()
            return
        }

        if #available(iOS 16.0, *) {
            let preferences = UIWindowScene.GeometryPreferences.iOS(
                interfaceOrientations: mask
            )
            windowScene.requestGeometryUpdate(preferences) { [weak self] _ in
                // A hardware rotation may already be in progress. UIKit will
                // apply the supported-orientation mask on the next update.
                self?.setNeedsUpdateOfSupportedInterfaceOrientations()
            }
        }

        synchronizeViewportGeometry()
    }

    /// Coalesces immediate layout changes and publishes one settled follow-up.
    private func synchronizeViewportGeometry() {
        dispatchPrecondition(condition: .onQueue(.main))

        if !viewportGeometrySyncScheduled {
            viewportGeometrySyncScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.viewportGeometrySyncScheduled = false
                self.publishViewportGeometry()
            }
        }

        settledViewportGeometryWorkItem?.cancel()
        let settledWorkItem = DispatchWorkItem { [weak self] in
            self?.publishViewportGeometry()
        }
        settledViewportGeometryWorkItem = settledWorkItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + 0.1,
            execute: settledWorkItem
        )
    }

    /// Sends native safe-area and viewport measurements to the persistent WebView.
    private func publishViewportGeometry() {
        dispatchPrecondition(condition: .onQueue(.main))

        view.setNeedsLayout()
        view.layoutIfNeeded()

        let insets = view.safeAreaInsets
        let bounds = view.bounds
        let payload: [String: Any] = [
            "safeAreaInsets": [
                "top": insets.top,
                "right": insets.right,
                "bottom": insets.bottom,
                "left": insets.left
            ],
            "viewport": [
                "width": bounds.width,
                "height": bounds.height
            ]
        ]

        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            return
        }

        let script = """
        window.dispatchEvent(new CustomEvent('kinsphere:native-viewport-geometry', {
          detail: \(json)
        }));
        window.dispatchEvent(new Event('resize'));
        """
        webView?.evaluateJavaScript(script)
    }
}

/// Creates the app window and forwards universal-link callbacks to Capacitor.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// Installs the custom bridge controller for the connecting scene.
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AppBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// Forwards custom-scheme callbacks to Capacitor's registered handlers.
    func scene(_ scene: UIScene, openURLContexts urlContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: urlContexts)
    }

    /// Forwards universal links and handoff activities to Capacitor.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
