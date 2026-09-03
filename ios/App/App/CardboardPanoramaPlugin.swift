import Capacitor
import ImageIO
import UIKit

/// Stable bridge failures surfaced to the React layer without native details.
private enum CardboardPanoramaBridgeError: LocalizedError {
    case missingImage
    case invalidBase64
    case emptyImage
    case compressedImageTooLarge
    case invalidImage
    case imageDimensionsTooLarge
    case unavailablePresenter
    case presenterTransitioning
    case presentationInProgress

    /// Maps native staging failures to stable user-facing copy.
    var errorDescription: String? {
        switch self {
        case .missingImage:
            return "The panorama image is missing."
        case .invalidBase64:
            return "The panorama data is not valid base64."
        case .emptyImage:
            return "The panorama image is empty."
        case .compressedImageTooLarge:
            return "This panorama is too large for the native VR handoff."
        case .invalidImage:
            return "This panorama image could not be decoded."
        case .imageDimensionsTooLarge:
            return "This panorama is too large to render safely on this device."
        case .unavailablePresenter:
            return "The Bubble app view is not available."
        case .presenterTransitioning:
            return "The Bubble app view is still changing. Please try VR again."
        case .presentationInProgress:
            return "A Cardboard panorama is already open."
        }
    }

    /// Maps related native failures to the JavaScript bridge's public codes.
    var code: String {
        switch self {
        case .missingImage: return "PANORAMA_MISSING"
        case .invalidBase64, .emptyImage, .invalidImage: return "PANORAMA_INVALID"
        case .compressedImageTooLarge, .imageDimensionsTooLarge: return "PANORAMA_TOO_LARGE"
        case .unavailablePresenter, .presenterTransitioning:
            return "CARDBOARD_ACTIVITY_UNAVAILABLE"
        case .presentationInProgress: return "CARDBOARD_PRESENTATION_IN_PROGRESS"
        }
    }
}

/// Validated, bounded input for one native Cardboard presentation.
private struct CardboardPanoramaRequest {
    let encodedImage: String
    let mimeType: String
    let title: String
    let initialYaw: Float
    let initialPitch: Float

    /// Parses untrusted Capacitor values before any allocation or presentation.
    init(call: CAPPluginCall) throws {
        guard let encodedImage = call.getString("dataBase64"), !encodedImage.isEmpty else {
            throw CardboardPanoramaBridgeError.missingImage
        }
        guard encodedImage.utf8.count <= CardboardPanoramaPlugin.maximumBase64Characters else {
            throw CardboardPanoramaBridgeError.compressedImageTooLarge
        }

        self.encodedImage = encodedImage
        mimeType = call.getString("mimeType") ?? "image/jpeg"

        let requestedTitle = (call.getString("title") ?? "Family moment")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        title = String((requestedTitle.isEmpty ? "Family moment" : requestedTitle).prefix(120))

        let yaw = call.getDouble("initialYaw") ?? 0
        let pitch = call.getDouble("initialPitch") ?? 0
        initialYaw = yaw.isFinite ? Float(yaw.truncatingRemainder(dividingBy: 360)) : 0
        initialPitch = pitch.isFinite ? Float(min(max(pitch, -85), 85)) : 0
    }
}

/**
 Stages a panorama from Capacitor and presents the native iOS Cardboard viewer.

 The JavaScript contract deliberately matches Android's CardboardPanorama plugin:
 `open({ dataBase64, mimeType, title, initialYaw, initialPitch })` resolves with
 `{ launched: true }` after the full-screen controller is presented.
 */
@objc(CardboardPanoramaPlugin)
public final class CardboardPanoramaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CardboardPanoramaPlugin"
    public let jsName = "CardboardPanorama"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    // 48 MiB of base64 represents at most 36 MiB of compressed image data.
    static let maximumBase64Characters = 48 * 1_024 * 1_024
    private static let maximumCompressedBytes = 36 * 1_024 * 1_024
    private static let maximumTextureEdge = 8_192
    private static let maximumDecodedPixels = 33_554_432
    private static let downsampleQuality = 0.92
    private static let staleArtifactAge: TimeInterval = 24 * 60 * 60

    private let stagingQueue = DispatchQueue(
        label: "com.simerfamily.kinsphere.cardboard-panorama",
        qos: .userInitiated
    )
    private var activeController: CardboardPanoramaViewController?

    /// Stages one panorama off-main, then presents exactly one native viewer.
    @objc public func open(_ call: CAPPluginCall) {
        let request: CardboardPanoramaRequest
        do {
            request = try CardboardPanoramaRequest(call: call)
        } catch let error as CardboardPanoramaBridgeError {
            call.reject(error.localizedDescription, error.code)
            return
        } catch {
            call.reject("The panorama request is invalid.", "PANORAMA_INVALID", error)
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.activeController == nil else {
                let error = CardboardPanoramaBridgeError.presentationInProgress
                call.reject(error.localizedDescription, error.code)
                return
            }

            self.stagingQueue.async { [weak self] in
                guard let self else { return }
                do {
                    let stagedURL = try self.stagePanorama(request)
                    DispatchQueue.main.async { [weak self] in
                        guard let self else {
                            Self.removeArtifact(at: stagedURL)
                            return
                        }
                        self.presentViewer(
                            stagedURL: stagedURL,
                            request: request,
                            call: call
                        )
                    }
                } catch let error as CardboardPanoramaBridgeError {
                    call.reject(error.localizedDescription, error.code)
                } catch {
                    call.reject(
                        "The panorama could not be prepared for VR.",
                        "PANORAMA_STAGE_FAILED",
                        error
                    )
                }
            }
        }
    }

    /// Decodes and bounds the image before atomically writing a protected cache file.
    private func stagePanorama(_ request: CardboardPanoramaRequest) throws -> URL {
        try autoreleasepool {
            guard let data = Data(base64Encoded: request.encodedImage) else {
                throw CardboardPanoramaBridgeError.invalidBase64
            }
            guard !data.isEmpty else {
                throw CardboardPanoramaBridgeError.emptyImage
            }
            guard data.count <= Self.maximumCompressedBytes else {
                throw CardboardPanoramaBridgeError.compressedImageTooLarge
            }

            let dimensions = try imageDimensions(in: data)
            let requiresDownsample = dimensions.width > Self.maximumTextureEdge ||
                dimensions.height > Self.maximumTextureEdge ||
                dimensions.width > Self.maximumDecodedPixels / dimensions.height
            let stagedData = requiresDownsample
                ? try downsampledJPEG(data, dimensions: dimensions)
                : data
            let directory = try stagingDirectory()
            removeStaleArtifacts(in: directory)

            let destination = directory
                .appendingPathComponent("panorama-\(UUID().uuidString)")
                .appendingPathExtension(
                    requiresDownsample ? "jpg" : fileExtension(for: request.mimeType)
                )
            do {
                try stagedData.write(to: destination, options: [.atomic])
                var resourceValues = URLResourceValues()
                resourceValues.isExcludedFromBackup = true
                var mutableDestination = destination
                try? mutableDestination.setResourceValues(resourceValues)
                try? FileManager.default.setAttributes(
                    [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                    ofItemAtPath: destination.path
                )
                return destination
            } catch {
                Self.removeArtifact(at: destination)
                throw error
            }
        }
    }

    /// Reads image dimensions without eagerly decoding its full pixel buffer.
    private func imageDimensions(in data: Data) throws -> (width: Int, height: Int) {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                as? [CFString: Any],
              let widthNumber = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let heightNumber = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
            throw CardboardPanoramaBridgeError.invalidImage
        }

        let width = widthNumber.intValue
        let height = heightNumber.intValue
        guard width > 0, height > 0 else {
            throw CardboardPanoramaBridgeError.invalidImage
        }
        return (width, height)
    }

    /// Constrains both texture edge and total pixels in one metadata-free JPEG.
    private func downsampledJPEG(
        _ data: Data,
        dimensions: (width: Int, height: Int)
    ) throws -> Data {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            throw CardboardPanoramaBridgeError.invalidImage
        }

        let longestEdge = max(dimensions.width, dimensions.height)
        let pixelCount = Double(dimensions.width) * Double(dimensions.height)
        let edgeScale = min(1, Double(Self.maximumTextureEdge) / Double(longestEdge))
        let pixelScale = min(1, sqrt(Double(Self.maximumDecodedPixels) / pixelCount))
        let targetEdge = max(1, Int(floor(Double(longestEdge) * min(edgeScale, pixelScale))))
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: targetEdge,
            kCGImageSourceShouldCacheImmediately: false
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            options as CFDictionary
        ) else {
            throw CardboardPanoramaBridgeError.imageDimensionsTooLarge
        }

        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            "public.jpeg" as CFString,
            1,
            nil
        ) else {
            throw CardboardPanoramaBridgeError.imageDimensionsTooLarge
        }
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: Self.downsampleQuality]
                as CFDictionary
        )
        guard CGImageDestinationFinalize(destination), output.length > 0 else {
            throw CardboardPanoramaBridgeError.imageDimensionsTooLarge
        }
        return output as Data
    }

    /// Creates the private, backup-excluded Cardboard staging directory.
    private func stagingDirectory() throws -> URL {
        let directory = FileManager.default.urls(
            for: .cachesDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("cardboard-panoramas", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var mutableDirectory = directory
        try? mutableDirectory.setResourceValues(resourceValues)
        return directory
    }

    /// Removes abandoned regular files after a bounded retention window.
    private func removeStaleArtifacts(in directory: URL) {
        let cutoff = Date().addingTimeInterval(-Self.staleArtifactAge)
        let keys: Set<URLResourceKey> = [.contentModificationDateKey, .isRegularFileKey]
        guard let children = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ) else {
            return
        }

        for child in children {
            guard let values = try? child.resourceValues(forKeys: keys),
                  values.isRegularFile == true,
                  let modifiedAt = values.contentModificationDate,
                  modifiedAt < cutoff else {
                continue
            }
            Self.removeArtifact(at: child)
        }
    }

    /// Claims presentation ownership, rotates the app, and releases every staged
    /// artifact through the controller's dismissal callbacks.
    private func presentViewer(
        stagedURL: URL,
        request: CardboardPanoramaRequest,
        call: CAPPluginCall
    ) {
        dispatchPrecondition(condition: .onQueue(.main))

        guard activeController == nil else {
            Self.removeArtifact(at: stagedURL)
            let error = CardboardPanoramaBridgeError.presentationInProgress
            call.reject(error.localizedDescription, error.code)
            return
        }
        guard let presenter = topPresenter(from: bridge?.viewController),
              presenter.viewIfLoaded?.window != nil else {
            Self.removeArtifact(at: stagedURL)
            let error = CardboardPanoramaBridgeError.unavailablePresenter
            call.reject(error.localizedDescription, error.code)
            return
        }
        guard !presenter.isBeingPresented,
              !presenter.isBeingDismissed,
              presenter.transitionCoordinator == nil else {
            Self.removeArtifact(at: stagedURL)
            let error = CardboardPanoramaBridgeError.presenterTransitioning
            call.reject(error.localizedDescription, error.code)
            return
        }

        let controller: CardboardPanoramaViewController
        do {
            controller = try CardboardPanoramaViewController(
                panoramaURL: stagedURL,
                title: request.title,
                initialYawDegrees: request.initialYaw,
                initialPitchDegrees: request.initialPitch
            )
        } catch {
            Self.removeArtifact(at: stagedURL)
            call.reject(
                "This phone could not start the native Cardboard renderer.",
                "CARDBOARD_LAUNCH_FAILED",
                error
            )
            return
        }

        controller.onWillDismiss = { [weak self] in
            guard let self else { return }
            (self.bridge?.viewController as? AppBridgeViewController)?
                .restoreAppPortraitOrientation()
        }
        controller.onDismiss = { [weak self, weak controller] in
            Self.removeArtifact(at: stagedURL)
            (self?.bridge?.viewController as? AppBridgeViewController)?
                .restoreAppPortraitOrientation()
            guard let self, self.activeController === controller else { return }
            self.activeController = nil
        }
        controller.modalPresentationStyle = .fullScreen
        controller.isModalInPresentation = true
        activeController = controller
        (bridge?.viewController as? AppBridgeViewController)?
            .requestCardboardLandscape()
        presenter.present(controller, animated: true) {
            call.resolve(["launched": true])
        }
    }

    /// Finds the visible presenter through modal, navigation, and tab containers.
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

    /// Maps supported image MIME hints to a non-executable cache suffix.
    private func fileExtension(for mimeType: String) -> String {
        let normalized = mimeType.lowercased()
        if normalized.contains("png") { return "png" }
        if normalized.contains("webp") { return "webp" }
        if normalized.contains("heic") || normalized.contains("heif") { return "heic" }
        return "jpg"
    }

    /// Best-effort cleanup shared by every presentation outcome.
    private static func removeArtifact(at url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}
