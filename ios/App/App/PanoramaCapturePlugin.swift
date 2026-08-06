import ARKit
import AVFoundation
import Capacitor
import UIKit

enum PanoramaCaptureOutcome {
    case success([String: Any])
    case cancelled
    case failure(message: String, code: String)
}

struct PanoramaCaptureOptions {
    enum Mode: String {
        case quick
        case standard
        case detailed

        var displayName: String {
            switch self {
            case .quick: return "Quick"
            case .standard: return "Standard"
            case .detailed: return "Detailed"
            }
        }
    }

    let mode: Mode
    let outputWidth: Int
    let jpegQuality: Double
    let alignmentRadians: Float
    let steadyDuration: TimeInterval

    init(call: CAPPluginCall) {
        mode = Mode(rawValue: call.getString("mode") ?? "standard") ?? .standard

        let requestedWidth = call.getInt("outputWidth") ?? 0
        outputWidth = requestedWidth > 0 ? min(max(requestedWidth, 640), 4_096) : 0

        jpegQuality = min(max(call.getDouble("jpegQuality") ?? 0.92, 0.5), 1.0)

        let alignmentDegrees = min(max(call.getDouble("alignmentDegrees") ?? 4.5, 2.0), 12.0)
        alignmentRadians = Float(alignmentDegrees * .pi / 180.0)

        let steadyMilliseconds = min(max(call.getDouble("steadyDurationMs") ?? 650.0, 300.0), 2_000.0)
        steadyDuration = steadyMilliseconds / 1_000.0
    }
}

@objc(PanoramaCapturePlugin)
public class PanoramaCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PanoramaCapturePlugin"
    public let jsName = "PanoramaCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardCapture", returnType: CAPPluginReturnPromise)
    ]

    private var activeController: PanoramaCaptureViewController?

    @objc func startCapture(_ call: CAPPluginCall) {
        let options = PanoramaCaptureOptions(call: call)

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.activeController == nil else {
                call.reject("A panorama capture is already in progress.", "CAPTURE_IN_PROGRESS")
                return
            }
            guard ARWorldTrackingConfiguration.isSupported else {
                call.reject("Guided panorama capture requires an ARKit-capable iPhone or iPad.", "NOT_SUPPORTED")
                return
            }

            self.ensureCameraPermission { [weak self] granted in
                guard let self else { return }
                guard granted else {
                    call.reject("Camera access is required to capture a panorama.", "PERMISSION_DENIED")
                    return
                }
                self.presentCapture(options: options, call: call)
            }
        }
    }

    @objc func discardCapture(_ call: CAPPluginCall) {
        guard let directoryValue = call.getString("directoryUrl"),
              let candidateURL = validatedCaptureDirectory(from: directoryValue) else {
            call.reject(
                "directoryUrl must identify a KinSphere panorama capture directory.",
                "INVALID_DIRECTORY"
            )
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.activeController?
                .captureDirectoryURL
                .standardizedFileURL
                .resolvingSymlinksInPath() == candidateURL {
                call.reject(
                    "The active panorama capture cannot be discarded.",
                    "CAPTURE_IN_PROGRESS"
                )
                return
            }

            DispatchQueue.global(qos: .utility).async {
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(
                    atPath: candidateURL.path,
                    isDirectory: &isDirectory
                ) else {
                    call.resolve(["discarded": false])
                    return
                }
                guard isDirectory.boolValue else {
                    call.reject(
                        "The capture path is not a directory.",
                        "INVALID_DIRECTORY"
                    )
                    return
                }

                do {
                    try FileManager.default.removeItem(at: candidateURL)
                    call.resolve(["discarded": true])
                } catch {
                    call.reject(
                        "The temporary panorama frames could not be removed.",
                        "DISCARD_FAILED",
                        error
                    )
                }
            }
        }
    }

    private func ensureCameraPermission(completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            completion(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    completion(granted)
                }
            }
        case .denied, .restricted:
            completion(false)
        @unknown default:
            completion(false)
        }
    }

    private func presentCapture(options: PanoramaCaptureOptions, call: CAPPluginCall) {
        dispatchPrecondition(condition: .onQueue(.main))

        guard activeController == nil else {
            call.reject("A panorama capture is already in progress.", "CAPTURE_IN_PROGRESS")
            return
        }
        guard let presenter = topPresenter(from: bridge?.viewController), presenter.viewIfLoaded?.window != nil else {
            call.reject("The panorama capture screen could not be presented.", "PRESENTATION_FAILED")
            return
        }

        let controller: PanoramaCaptureViewController
        do {
            controller = try PanoramaCaptureViewController(options: options)
        } catch {
            call.reject("The capture directory could not be created.", "CAPTURE_FAILED", error)
            return
        }

        controller.onCompletion = { [weak self, weak controller] outcome in
            guard let self, let controller else { return }
            self.finishCapture(controller: controller, outcome: outcome, call: call)
        }

        activeController = controller
        presenter.present(controller, animated: true)
    }

    private func finishCapture(
        controller: PanoramaCaptureViewController,
        outcome: PanoramaCaptureOutcome,
        call: CAPPluginCall
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard activeController === controller else { return }

        controller.dismiss(animated: true) { [weak self] in
            self?.activeController = nil

            switch outcome {
            case .success(let result):
                call.resolve(result)
            case .cancelled:
                call.reject("Panorama capture was cancelled.", "CAPTURE_CANCELLED")
            case .failure(let message, let code):
                call.reject(message, code)
            }
        }
    }

    private func topPresenter(from root: UIViewController?) -> UIViewController? {
        guard let root else { return nil }

        if let presented = root.presentedViewController, !presented.isBeingDismissed {
            return topPresenter(from: presented)
        }
        if let navigation = root as? UINavigationController {
            return topPresenter(from: navigation.visibleViewController ?? navigation)
        }
        if let tabs = root as? UITabBarController {
            return topPresenter(from: tabs.selectedViewController ?? tabs)
        }
        return root
    }

    private func validatedCaptureDirectory(from value: String) -> URL? {
        let candidate: URL
        if let parsedURL = URL(string: value),
           parsedURL.isFileURL,
           parsedURL.host == nil || parsedURL.host?.isEmpty == true || parsedURL.host == "localhost" {
            candidate = parsedURL
        } else {
            return nil
        }

        guard !candidate.pathComponents.contains("."),
              !candidate.pathComponents.contains("..") else {
            return nil
        }

        let unresolvingRoot = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PanoramaCaptures", isDirectory: true)
            .standardizedFileURL
        let standardizedCandidate = candidate.standardizedFileURL
        guard standardizedCandidate.deletingLastPathComponent().path == unresolvingRoot.path,
              UUID(uuidString: standardizedCandidate.lastPathComponent) != nil else {
            return nil
        }

        let cacheRoot = unresolvingRoot.resolvingSymlinksInPath()
        let resolvedCandidate = standardizedCandidate.resolvingSymlinksInPath()
        guard resolvedCandidate.deletingLastPathComponent().path == cacheRoot.path,
              resolvedCandidate.lastPathComponent == standardizedCandidate.lastPathComponent else {
            return nil
        }
        return resolvedCandidate
    }
}
