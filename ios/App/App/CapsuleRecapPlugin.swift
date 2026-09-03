import AVFoundation
import Capacitor
import CoreMedia
import CoreVideo
import ImageIO
import UIKit

/// Native recap limits shared by validation, staging, and video encoding.
private enum CapsuleRecapConstants {
    static let width = 1_080
    static let height = 1_920
    static let frameRate: Int32 = 30
    static let framesPerImage = 6
    static let millisecondsPerImage = 200
    static let maximumImageCount = 150
    static let maximumDataURLBytes = 36 * 1_024 * 1_024
    static let maximumDecodedPixels = 80_000_000
    static let maximumStagedLongEdge: CGFloat = 2_048
}

/// Stable native failures translated into user-safe Capacitor errors.
private enum CapsuleRecapError: LocalizedError {
    case invalidDataURL
    case imageTooLarge
    case imageDecodeFailed
    case imageEncodeFailed
    case invalidImagePaths
    case stagedImageMissing
    case writerCreationFailed
    case writerStartFailed(String)
    case pixelBufferCreationFailed
    case pixelContextCreationFailed
    case sampleBufferCreationFailed
    case frameAppendFailed(String)
    case writerFinishFailed(String)
    case invalidRecapFile

    /// Converts internal media failures into stable user-facing copy.
    var errorDescription: String? {
        switch self {
        case .invalidDataURL:
            return "Choose a valid image for the capsule recap."
        case .imageTooLarge:
            return "This image is too large to prepare safely on this device."
        case .imageDecodeFailed:
            return "This capsule image could not be decoded."
        case .imageEncodeFailed:
            return "This capsule image could not be prepared."
        case .invalidImagePaths:
            return "Add between one and 150 staged images to create a recap."
        case .stagedImageMissing:
            return "A staged capsule image is no longer available."
        case .writerCreationFailed:
            return "The capsule recap video could not be created."
        case .writerStartFailed(let detail):
            return "The capsule recap encoder could not start. \(detail)"
        case .pixelBufferCreationFailed:
            return "The capsule recap could not allocate a video frame."
        case .pixelContextCreationFailed:
            return "The capsule recap could not draw a video frame."
        case .sampleBufferCreationFailed:
            return "The capsule recap could not prepare a video frame."
        case .frameAppendFailed(let detail):
            return "The capsule recap could not encode a video frame. \(detail)"
        case .writerFinishFailed(let detail):
            return "The capsule recap video could not be finished. \(detail)"
        case .invalidRecapFile:
            return "The capsule recap video is no longer available."
        }
    }
}

/// Stages sanitized stills, renders the deterministic recap, and presents the
/// native share sheet without exposing arbitrary device paths to JavaScript.
@objc(CapsuleRecapPlugin)
public final class CapsuleRecapPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CapsuleRecapPlugin"
    public let jsName = "CapsuleRecap"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "stageImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "renderRecap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareRecap", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardArtifacts", returnType: CAPPluginReturnPromise)
    ]

    private let workQueue = DispatchQueue(
        label: "com.simerfamily.kinsphere.capsule-recap",
        qos: .userInitiated
    )
    private let stateLock = NSLock()
    private var renderInProgress = false
    private weak var activeShareController: UIActivityViewController?

    /// Decodes one bounded data URL and writes a normalized JPEG to the private
    /// staging directory. The selected original is never persisted by this API.
    @objc func stageImage(_ call: CAPPluginCall) {
        guard let dataURL = call.getString("dataUrl") else {
            call.reject(
                CapsuleRecapError.invalidDataURL.localizedDescription,
                "INVALID_IMAGE_DATA"
            )
            return
        }

        workQueue.async { [weak self] in
            guard let self else { return }
            do {
                let stagedURL = try self.stageImageDataURL(dataURL)
                call.resolve(["path": stagedURL.absoluteString])
            } catch {
                call.reject(
                    error.localizedDescription,
                    "IMAGE_STAGING_FAILED",
                    error
                )
            }
        }
    }

    /// Creates one H.264 recap from validated staged files. Rendering is
    /// serialized because concurrent 1080×1920 encoders can exhaust phone memory.
    @objc func renderRecap(_ call: CAPPluginCall) {
        guard let imagePaths = call.getArray("imagePaths", String.self),
              imagePaths.count >= 1,
              imagePaths.count <= CapsuleRecapConstants.maximumImageCount else {
            call.reject(
                CapsuleRecapError.invalidImagePaths.localizedDescription,
                "INVALID_IMAGE_PATHS"
            )
            return
        }

        stateLock.lock()
        guard !renderInProgress else {
            stateLock.unlock()
            call.reject(
                "A capsule recap is already being created.",
                "RENDER_IN_PROGRESS"
            )
            return
        }
        renderInProgress = true
        stateLock.unlock()

        workQueue.async { [weak self] in
            guard let self else { return }
            defer {
                self.stateLock.lock()
                self.renderInProgress = false
                self.stateLock.unlock()
            }

            do {
                let stagedURLs = try imagePaths.map(self.validatedStagedImageURL)
                defer {
                    for stagedURL in Set(stagedURLs) {
                        try? FileManager.default.removeItem(at: stagedURL)
                    }
                }
                let outputURL = try self.renderVideo(from: stagedURLs)

                call.resolve([
                    "fileUri": outputURL.absoluteString,
                    "width": CapsuleRecapConstants.width,
                    "height": CapsuleRecapConstants.height,
                    "frameRate": Int(CapsuleRecapConstants.frameRate),
                    "framesPerImage": CapsuleRecapConstants.framesPerImage,
                    "durationMs": stagedURLs.count * CapsuleRecapConstants.millisecondsPerImage,
                    "imageCount": stagedURLs.count
                ])
            } catch {
                call.reject(
                    error.localizedDescription,
                    "RECAP_RENDER_FAILED",
                    error
                )
            }
        }
    }

    /// Shares only a UUID-named MP4 created inside Bubble's recap directory.
    @objc func shareRecap(_ call: CAPPluginCall) {
        guard let fileURI = call.getString("fileUri") else {
            call.reject(
                CapsuleRecapError.invalidRecapFile.localizedDescription,
                "INVALID_RECAP_FILE"
            )
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.activeShareController == nil else {
                call.reject("The share sheet is already open.", "SHARE_IN_PROGRESS")
                return
            }

            do {
                let fileURL = try self.validatedRecapFileURL(fileURI)
                guard let presenter = self.topPresenter(from: self.bridge?.viewController),
                      presenter.viewIfLoaded?.window != nil else {
                    call.reject(
                        "The share sheet could not be presented.",
                        "PRESENTATION_FAILED"
                    )
                    return
                }

                let controller = UIActivityViewController(
                    activityItems: [fileURL],
                    applicationActivities: nil
                )
                controller.popoverPresentationController?.sourceView = presenter.view
                controller.popoverPresentationController?.sourceRect = CGRect(
                    x: presenter.view.bounds.midX,
                    y: presenter.view.bounds.midY,
                    width: 1,
                    height: 1
                )
                controller.popoverPresentationController?.permittedArrowDirections = []
                controller.completionWithItemsHandler = {
                    [weak self] activityType, completed, _, error in
                    self?.activeShareController = nil
                    try? FileManager.default.removeItem(at: fileURL)
                    if let error {
                        call.reject(
                            "The capsule recap could not be shared.",
                            "SHARE_FAILED",
                            error
                        )
                        return
                    }

                    var result: [String: Any] = ["completed": completed]
                    if let activityType {
                        result["activityType"] = activityType.rawValue
                    }
                    call.resolve(result)
                }

                self.activeShareController = controller
                presenter.present(controller, animated: true)
            } catch {
                call.reject(
                    error.localizedDescription,
                    "INVALID_RECAP_FILE",
                    error
                )
            }
        }
    }

    /// Best-effort, idempotent cleanup for artifacts created by this plugin.
    @objc func discardArtifacts(_ call: CAPPluginCall) {
        guard let fileURIs = call.getArray("fileUris", String.self),
              fileURIs.count <= CapsuleRecapConstants.maximumImageCount + 1 else {
            call.reject("The capsule recap cleanup request is invalid.", "INVALID_ARTIFACTS")
            return
        }

        workQueue.async { [weak self] in
            guard let self else { return }
            var removedCount = 0
            for value in Set(fileURIs) {
                guard let artifactURL = self.removableArtifactURL(value) else { continue }
                if FileManager.default.fileExists(atPath: artifactURL.path) {
                    do {
                        try FileManager.default.removeItem(at: artifactURL)
                        removedCount += 1
                    } catch {
                        // Cleanup is best effort and can be retried safely.
                    }
                }
            }
            call.resolve(["removedCount": removedCount])
        }
    }

    /// Validates, decodes, downsizes, re-encodes, and atomically stores one still.
    private func stageImageDataURL(_ dataURL: String) throws -> URL {
        guard dataURL.utf8.count <= CapsuleRecapConstants.maximumDataURLBytes else {
            throw CapsuleRecapError.imageTooLarge
        }
        guard let comma = dataURL.firstIndex(of: ",") else {
            throw CapsuleRecapError.invalidDataURL
        }

        let header = String(dataURL[..<comma]).lowercased()
        guard header.hasPrefix("data:image/"), header.hasSuffix(";base64") else {
            throw CapsuleRecapError.invalidDataURL
        }

        let encoded = String(dataURL[dataURL.index(after: comma)...])
        guard let sourceData = Data(base64Encoded: encoded), !sourceData.isEmpty else {
            throw CapsuleRecapError.invalidDataURL
        }
        try validateImageDimensions(in: sourceData)
        guard let sourceImage = UIImage(data: sourceData) else {
            throw CapsuleRecapError.imageDecodeFailed
        }

        let normalizedImage = normalizedStagedImage(sourceImage)
        guard let jpegData = normalizedImage.jpegData(compressionQuality: 0.9) else {
            throw CapsuleRecapError.imageEncodeFailed
        }

        let stagingRoot = try ensureDirectory(named: "CapsuleRecapStaging")
        let outputURL = stagingRoot
            .appendingPathComponent(UUID().uuidString.lowercased())
            .appendingPathExtension("jpg")
        try jpegData.write(to: outputURL, options: [.atomic])
        return outputURL
    }

    /// Rejects malformed or decompression-bomb dimensions before UIKit decodes pixels.
    private func validateImageDimensions(in data: Data) throws {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                as? [CFString: Any],
              let widthNumber = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let heightNumber = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
            throw CapsuleRecapError.imageDecodeFailed
        }

        let width = widthNumber.intValue
        let height = heightNumber.intValue
        guard width > 0,
              height > 0,
              width <= CapsuleRecapConstants.maximumDecodedPixels / height else {
            throw CapsuleRecapError.imageTooLarge
        }
    }

    /// Applies image orientation and bounds the long edge in one fresh opaque
    /// render, which also strips source metadata before staging.
    private func normalizedStagedImage(_ image: UIImage) -> UIImage {
        let sourceSize = image.size
        let longEdge = max(sourceSize.width, sourceSize.height)
        let scale = longEdge > CapsuleRecapConstants.maximumStagedLongEdge
            ? CapsuleRecapConstants.maximumStagedLongEdge / longEdge
            : 1
        let outputSize = CGSize(
            width: max(1, (sourceSize.width * scale).rounded()),
            height: max(1, (sourceSize.height * scale).rounded())
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: outputSize, format: format).image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: outputSize))
            image.draw(in: CGRect(origin: .zero, size: outputSize))
        }
    }

    /// Encodes every still for exactly six frames at 30 fps (0.2 seconds).
    private func renderVideo(from imageURLs: [URL]) throws -> URL {
        let outputRoot = try ensureDirectory(named: "CapsuleRecaps")
        let outputURL = outputRoot
            .appendingPathComponent(UUID().uuidString.lowercased())
            .appendingPathExtension("mp4")

        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        } catch {
            throw CapsuleRecapError.writerCreationFailed
        }

        let compression: [String: Any] = [
            AVVideoAverageBitRateKey: 6_000_000,
            AVVideoExpectedSourceFrameRateKey: Int(CapsuleRecapConstants.frameRate),
            AVVideoMaxKeyFrameIntervalKey: Int(CapsuleRecapConstants.frameRate),
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
        ]
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: CapsuleRecapConstants.width,
            AVVideoHeightKey: CapsuleRecapConstants.height,
            AVVideoCompressionPropertiesKey: compression
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        guard writer.canAdd(input) else {
            throw CapsuleRecapError.writerCreationFailed
        }
        writer.add(input)

        guard writer.startWriting() else {
            let detail = writer.error?.localizedDescription ?? "Unknown encoder error."
            try? FileManager.default.removeItem(at: outputURL)
            throw CapsuleRecapError.writerStartFailed(detail)
        }
        writer.startSession(atSourceTime: .zero)

        do {
            var frameIndex: Int64 = 0
            for imageURL in imageURLs {
                guard let image = UIImage(contentsOfFile: imageURL.path),
                      let cgImage = image.cgImage else {
                    throw CapsuleRecapError.imageDecodeFailed
                }

                let pixelBuffer = try makePixelBuffer(containing: cgImage)
                var formatDescription: CMVideoFormatDescription?
                guard CMVideoFormatDescriptionCreateForImageBuffer(
                    allocator: kCFAllocatorDefault,
                    imageBuffer: pixelBuffer,
                    formatDescriptionOut: &formatDescription
                ) == noErr,
                      let formatDescription else {
                    throw CapsuleRecapError.sampleBufferCreationFailed
                }

                for _ in 0..<CapsuleRecapConstants.framesPerImage {
                    try waitUntilReady(input: input, writer: writer)
                    var timing = CMSampleTimingInfo(
                        duration: CMTime(value: 1, timescale: CapsuleRecapConstants.frameRate),
                        presentationTimeStamp: CMTime(
                            value: frameIndex,
                            timescale: CapsuleRecapConstants.frameRate
                        ),
                        decodeTimeStamp: .invalid
                    )
                    var sampleBuffer: CMSampleBuffer?
                    guard CMSampleBufferCreateReadyWithImageBuffer(
                        allocator: kCFAllocatorDefault,
                        imageBuffer: pixelBuffer,
                        formatDescription: formatDescription,
                        sampleTiming: &timing,
                        sampleBufferOut: &sampleBuffer
                    ) == noErr,
                          let sampleBuffer,
                          input.append(sampleBuffer) else {
                        let detail = writer.error?.localizedDescription ?? "Unknown frame error."
                        throw CapsuleRecapError.frameAppendFailed(detail)
                    }
                    frameIndex += 1
                }
            }

            input.markAsFinished()
            let completion = DispatchSemaphore(value: 0)
            writer.finishWriting {
                completion.signal()
            }
            guard completion.wait(timeout: .now() + 30) == .success else {
                throw CapsuleRecapError.writerFinishFailed(
                    "The encoder did not finish within 30 seconds."
                )
            }

            guard writer.status == .completed else {
                let detail = writer.error?.localizedDescription ?? "Unknown finalization error."
                throw CapsuleRecapError.writerFinishFailed(detail)
            }
            return outputURL
        } catch {
            input.markAsFinished()
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: outputURL)
            throw error
        }
    }

    /// Waits for encoder backpressure to clear, but never spins indefinitely if
    /// AVFoundation stops making progress without publishing a failure state.
    private func waitUntilReady(
        input: AVAssetWriterInput,
        writer: AVAssetWriter
    ) throws {
        let timeout = ProcessInfo.processInfo.systemUptime + 10
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed || writer.status == .cancelled {
                let detail = writer.error?.localizedDescription ?? "The encoder stopped."
                throw CapsuleRecapError.frameAppendFailed(detail)
            }
            if ProcessInfo.processInfo.systemUptime >= timeout {
                throw CapsuleRecapError.frameAppendFailed(
                    "The encoder did not accept another frame within 10 seconds."
                )
            }
            Thread.sleep(forTimeInterval: 0.002)
        }
    }

    /// Aspect-fills one still into an sRGB video frame without stretching it.
    private func makePixelBuffer(containing image: CGImage) throws -> CVPixelBuffer {
        let attributes: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:]
        ]
        var optionalBuffer: CVPixelBuffer?
        let result = CVPixelBufferCreate(
            kCFAllocatorDefault,
            CapsuleRecapConstants.width,
            CapsuleRecapConstants.height,
            kCVPixelFormatType_32BGRA,
            attributes as CFDictionary,
            &optionalBuffer
        )
        guard result == kCVReturnSuccess, let pixelBuffer = optionalBuffer else {
            throw CapsuleRecapError.pixelBufferCreationFailed
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: baseAddress,
                width: CapsuleRecapConstants.width,
                height: CapsuleRecapConstants.height,
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue |
                    CGBitmapInfo.byteOrder32Little.rawValue
              ) else {
            throw CapsuleRecapError.pixelContextCreationFailed
        }

        let outputWidth = CGFloat(CapsuleRecapConstants.width)
        let outputHeight = CGFloat(CapsuleRecapConstants.height)
        let imageWidth = CGFloat(image.width)
        let imageHeight = CGFloat(image.height)
        let fillScale = max(outputWidth / imageWidth, outputHeight / imageHeight)
        let drawWidth = imageWidth * fillScale
        let drawHeight = imageHeight * fillScale
        let drawRect = CGRect(
            x: (outputWidth - drawWidth) / 2,
            y: (outputHeight - drawHeight) / 2,
            width: drawWidth,
            height: drawHeight
        )

        context.setFillColor(UIColor.black.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))
        context.interpolationQuality = .high
        context.draw(image, in: drawRect)
        return pixelBuffer
    }

    /// Creates and canonicalizes one plugin-owned temporary directory.
    private func ensureDirectory(named name: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory.standardizedFileURL.resolvingSymlinksInPath()
    }

    /// Accepts only UUID JPEGs inside the staging directory.
    private func validatedStagedImageURL(_ value: String) throws -> URL {
        let root = try ensureDirectory(named: "CapsuleRecapStaging")
        guard let candidate = localFileURL(from: value),
              candidate.pathExtension.lowercased() == "jpg",
              candidate.deletingLastPathComponent().path == root.path,
              UUID(uuidString: candidate.deletingPathExtension().lastPathComponent) != nil else {
            throw CapsuleRecapError.invalidImagePaths
        }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(
            atPath: candidate.path,
            isDirectory: &isDirectory
        ), !isDirectory.boolValue else {
            throw CapsuleRecapError.stagedImageMissing
        }
        return candidate
    }

    /// Accepts only UUID MP4s inside the rendered-recap directory.
    private func validatedRecapFileURL(_ value: String) throws -> URL {
        let root = try ensureDirectory(named: "CapsuleRecaps")
        guard let candidate = localFileURL(from: value),
              candidate.pathExtension.lowercased() == "mp4",
              candidate.deletingLastPathComponent().path == root.path,
              UUID(uuidString: candidate.deletingPathExtension().lastPathComponent) != nil else {
            throw CapsuleRecapError.invalidRecapFile
        }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(
            atPath: candidate.path,
            isDirectory: &isDirectory
        ), !isDirectory.boolValue else {
            throw CapsuleRecapError.invalidRecapFile
        }
        return candidate
    }

    /// Converts a bridge path to a canonical local URL; remote schemes are denied.
    private func localFileURL(from value: String) -> URL? {
        let candidate: URL
        if let parsedURL = URL(string: value), parsedURL.isFileURL {
            candidate = parsedURL
        } else if value.hasPrefix("/") {
            candidate = URL(fileURLWithPath: value)
        } else {
            return nil
        }
        return candidate.standardizedFileURL.resolvingSymlinksInPath()
    }

    /// Limits cleanup to recognized UUID artifacts in plugin-owned directories.
    private func removableArtifactURL(_ value: String) -> URL? {
        guard let candidate = localFileURL(from: value),
              UUID(uuidString: candidate.deletingPathExtension().lastPathComponent) != nil else {
            return nil
        }
        let directoryName: String
        switch candidate.pathExtension.lowercased() {
        case "jpg":
            directoryName = "CapsuleRecapStaging"
        case "mp4":
            directoryName = "CapsuleRecaps"
        default:
            return nil
        }
        guard let root = try? ensureDirectory(named: directoryName),
              candidate.deletingLastPathComponent().path == root.path else {
            return nil
        }
        return candidate
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
}
