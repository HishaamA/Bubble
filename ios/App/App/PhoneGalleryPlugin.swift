import Capacitor
import CryptoKit
import Photos
import PhotosUI
import UIKit

/// Read-only PhotoKit references for Journal. Originals remain in Photos;
/// normalized JPEG previews exist in memory only and never include GPS/EXIF.
@objc(PhoneGalleryPlugin)
public final class PhoneGalleryPlugin: CAPPlugin, CAPBridgedPlugin, PHPhotoLibraryChangeObserver {
    public let identifier = "PhoneGalleryPlugin"
    public let jsName = "PhoneGallery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLibraryRevision", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readPhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    private let workQueue = DispatchQueue(label: "com.simerfamily.kinsphere.phone-gallery", qos: .userInitiated)
    private lazy var imageManager = PHImageManager()
    // Metadata only, scoped to the process. Each rescan replaces the index;
    // PhotoKit changes invalidate its revision without reordering old offsets.
    // Each individual fetch still asks PhotoKit for current access.
    private var orderedIdentifiers: [String]?
    private var indexFetchResult: PHFetchResult<PHAsset>?
    private var revisionFetchResult: PHFetchResult<PHAsset>?
    private var indexAuthorization: PHAuthorizationStatus?
    private var indexRevision: UInt64?
    private let libraryRevision = PhoneGalleryRevision()
    private var observingLibrary = false // Accessed on the worker only.
    private var permissionRequestActive = false // Accessed on the main queue only.

    deinit {
        if observingLibrary { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    }

    public func photoLibraryDidChange(_ changeInstance: PHChange) {
        // Mark immediately on PhotoKit's callback queue, including changes that
        // occur during a currently executing page. Keep the old ID order frozen;
        // rebuilding it at a nonzero offset could silently skip existing photos.
        libraryRevision.changed()
    }

    @objc func getPermission(_ call: CAPPluginCall) {
        call.resolve(["status": Self.permissionStatus()])
    }

    /// Metadata-only and stable across launches; never requests photo pixels or iCloud data.
    @objc func getLibraryRevision(_ call: CAPPluginCall) {
        workQueue.async { [weak self] in
            guard let self else { return }
            autoreleasepool {
                guard Self.canRead else {
                    call.reject("Photo access changed. Review your gallery permission.", "PERMISSION_DENIED")
                    return
                }
                self.observeLibraryIfNeeded()
                let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
                let observedRevision = self.libraryRevision.current
                let deadline = ProcessInfo.processInfo.systemUptime + 30
                // Exactly the same fetch predicate as listPhotos, including
                // PhotoKit's current limited-library selection and image filter.
                let assets = Self.visibleImages()
                guard assets.count <= 200_000 else {
                    call.reject("The photo library change check is too large. Choose a smaller photo selection.", "GALLERY_UNAVAILABLE")
                    return
                }
                self.revisionFetchResult = assets
                var rows: [(id: String, digest: SHA256.Digest)] = []
                rows.reserveCapacity(assets.count)
                var expired = false
                assets.enumerateObjects { asset, _, stop in
                    if ProcessInfo.processInfo.systemUptime >= deadline {
                        expired = true
                        stop.pointee = true
                        return
                    }
                    guard asset.pixelWidth > 0, asset.pixelHeight > 0 else { return }
                    autoreleasepool {
                        let resource = PHAssetResource.assetResources(for: asset).first { $0.type == .photo || $0.type == .fullSizePhoto }
                        var row = PhoneGalleryFingerprint()
                        row.add(asset.localIdentifier)
                        // Exact timestamp bits avoid locale/formatter variation
                        // while preserving sub-second edits reported by Photos.
                        row.add(asset.creationDate.map { String($0.timeIntervalSince1970.bitPattern) })
                        row.add(asset.modificationDate.map { String($0.timeIntervalSince1970.bitPattern) })
                        row.add(String(asset.pixelWidth))
                        row.add(String(asset.pixelHeight))
                        row.add(resource?.originalFilename)
                        row.add(String(asset.mediaSubtypes.rawValue))
                        rows.append((asset.localIdentifier, row.finalize()))
                    }
                }
                // PhotoKit's default fetch order is unspecified. Sort only IDs
                // and fixed-size row hashes, not a second array of photo assets.
                rows.sort { $0.id < $1.id }
                var fingerprint = PhoneGalleryFingerprint()
                fingerprint.add("bubble-gallery:ios:v1")
                fingerprint.add(String(status.rawValue))
                fingerprint.add(String(rows.count))
                for row in rows {
                    fingerprint.add(row.id)
                    fingerprint.add(row.digest)
                }
                guard !expired, ProcessInfo.processInfo.systemUptime < deadline else {
                    call.reject("The photo library change check could not finish. Try again shortly.", "GALLERY_UNAVAILABLE")
                    return
                }
                guard Self.canRead else {
                    self.revisionFetchResult = nil
                    call.reject("Photo access changed. Review your gallery permission.", "PERMISSION_DENIED")
                    return
                }
                guard self.libraryRevision.current == observedRevision,
                      PHPhotoLibrary.authorizationStatus(for: .readWrite) == status else {
                    call.reject("The photo library changed while refreshing. Refresh photos again.", "LIBRARY_CHANGED")
                    return
                }
                let hex = fingerprint.finalize().map { String(format: "%02x", $0) }.joined()
                call.resolve(["revision": "ios-v1:" + hex])
            }
        }
    }

    /// Explicit opt-in only. A limited-access user can revisit their selection.
    @objc func requestPermission(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard !self.permissionRequestActive else {
                call.reject("A photo permission request is already open.", "PERMISSION_REQUEST_ACTIVE")
                return
            }
            let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            if status == .limited {
                guard let controller = self.bridge?.viewController, controller.presentedViewController == nil else {
                    call.reject("Close the current sheet before changing photo access.", "PERMISSION_REQUEST_ACTIVE")
                    return
                }
                self.permissionRequestActive = true
                PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: controller) { [weak self] _ in
                    DispatchQueue.main.async {
                        self?.permissionRequestActive = false
                        self?.libraryRevision.changed()
                        call.resolve(["status": Self.permissionStatus()])
                    }
                }
            } else if status == .notDetermined {
                self.permissionRequestActive = true
                PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] _ in
                    DispatchQueue.main.async {
                        self?.permissionRequestActive = false
                        self?.libraryRevision.changed()
                        call.resolve(["status": Self.permissionStatus()])
                    }
                }
            } else {
                // Denied/restricted never creates a loop of system prompts.
                call.resolve(["status": Self.permissionStatus()])
            }
        }
    }

    @objc func listPhotos(_ call: CAPPluginCall) {
        let offset = max(0, call.getInt("offset") ?? 0)
        let limit = min(200, max(1, call.getInt("limit") ?? 100))
        workQueue.async { [weak self] in
            guard let self else { return }
            autoreleasepool {
                guard Self.canRead else {
                    self.orderedIdentifiers = nil
                    self.indexFetchResult = nil
                    call.reject("Photo access changed. Review your gallery permission.", "PERMISSION_DENIED")
                    return
                }
                self.observeLibraryIfNeeded()
                let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
                let pageRevision = self.libraryRevision.current
                if offset == 0 {
                    // Sorting a metadata index once avoids repeatedly retaining
                    // whole-library image data or relying on unsupported PhotoKit
                    // sort keys. Equal capture dates have a stable ID tie-break.
                    let assets = Self.visibleImages()
                    // Retain the metadata fetch result so PhotoKit keeps sending
                    // change notifications throughout the paged enumeration.
                    self.indexFetchResult = assets
                    var entries: [(id: String, date: TimeInterval)] = []
                    entries.reserveCapacity(assets.count)
                    assets.enumerateObjects { asset, _, _ in
                        entries.append((asset.localIdentifier, (asset.creationDate ?? asset.modificationDate ?? .distantPast).timeIntervalSince1970))
                    }
                    entries.sort { $0.date == $1.date ? $0.id > $1.id : $0.date > $1.date }
                    self.orderedIdentifiers = entries.map { $0.id }
                    self.indexAuthorization = status
                    self.indexRevision = pageRevision
                } else if self.orderedIdentifiers == nil || self.indexAuthorization != status || self.indexRevision != pageRevision {
                    call.reject("The photo library changed while refreshing. Refresh photos again.", "LIBRARY_CHANGED")
                    return
                }
                let ids = self.orderedIdentifiers ?? []
                let start = min(offset, ids.count)
                let end = start + min(limit, ids.count - start)
                let pageIDs = Array(ids[start..<end])
                // Re-fetch only visible page assets so a revoked limited-library
                // selection cannot leak metadata retained in the previous index.
                let assets = PHAsset.fetchAssets(withLocalIdentifiers: pageIDs, options: nil)
                var byID: [String: PHAsset] = [:]
                assets.enumerateObjects { asset, _, _ in
                    if asset.mediaType == .image { byID[asset.localIdentifier] = asset }
                }
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let photos: [[String: Any]] = pageIDs.compactMap { id in
                    guard let asset = byID[id], asset.pixelWidth > 0, asset.pixelHeight > 0 else { return nil }
                    let resource = PHAssetResource.assetResources(for: asset).first { $0.type == .photo || $0.type == .fullSizePhoto }
                    var photo: [String: Any] = [
                        "id": id,
                        "capturedAt": formatter.string(from: asset.creationDate ?? asset.modificationDate ?? Date(timeIntervalSince1970: 0)),
                        "width": asset.pixelWidth,
                        "height": asset.pixelHeight,
                        "filename": resource?.originalFilename ?? "Photo"
                    ]
                    if let modified = asset.modificationDate { photo["modifiedAt"] = formatter.string(from: modified) }
                    return photo
                }
                guard Self.canRead else {
                    self.orderedIdentifiers = nil
                    self.indexFetchResult = nil
                    call.reject("Photo access changed. Review your gallery permission.", "PERMISSION_DENIED")
                    return
                }
                guard self.libraryRevision.current == pageRevision,
                      PHPhotoLibrary.authorizationStatus(for: .readWrite) == status else {
                    call.reject("The photo library changed while refreshing. Refresh photos again.", "LIBRARY_CHANGED")
                    return
                }
                call.resolve(["photos": photos, "hasMore": end < ids.count])
            }
        }
    }

    @objc func readPhoto(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty, id.utf8.count <= 512,
              !id.contains("\0"), !id.contains("://") else {
            call.reject("Choose an existing phone photo.", "INVALID_PHOTO_ID")
            return
        }
        let edge = min(1600, max(256, call.getInt("maxDimension") ?? 1200))
        workQueue.async { [weak self] in
            guard let self else { return }
            autoreleasepool {
                guard Self.canRead else {
                    call.reject("Photo access changed. Review your gallery permission.", "PERMISSION_DENIED")
                    return
                }
                guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject,
                      asset.mediaType == .image, asset.pixelWidth > 0, asset.pixelHeight > 0 else {
                    call.reject("This phone photo is no longer available.", "PHOTO_UNAVAILABLE")
                    return
                }
                let scale = min(1, CGFloat(edge) / CGFloat(max(asset.pixelWidth, asset.pixelHeight)))
                let target = CGSize(width: max(1, (CGFloat(asset.pixelWidth) * scale).rounded()),
                                    height: max(1, (CGFloat(asset.pixelHeight) * scale).rounded()))
                let options = PHImageRequestOptions()
                options.isNetworkAccessAllowed = false
                options.isSynchronous = false
                options.resizeMode = .exact
                options.deliveryMode = .highQualityFormat
                options.version = .current
                let result = PhoneGalleryImageResult()
                let requestID = self.imageManager.requestImage(for: asset, targetSize: target, contentMode: .aspectFit, options: options) { image, info in
                    if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                    result.finish(image: image)
                }
                let image = result.wait(seconds: 20)
                if image == nil { self.imageManager.cancelImageRequest(requestID) }
                guard Self.canRead else {
                    call.reject("Photo access changed. Review your gallery permission.", "PERMISSION_DENIED")
                    return
                }
                guard PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject != nil else {
                    call.reject("This phone photo is no longer available.", "PHOTO_UNAVAILABLE")
                    return
                }
                guard let image, image.size.width > 0, image.size.height > 0 else {
                    call.reject("This photo is not available on this phone. Cloud-only photos are not downloaded.", "PHOTO_UNAVAILABLE")
                    return
                }
                // Normalize UIImage orientation and remove all source metadata.
                // A final size clamp protects against provider thumbnail rounding.
                let pixelSize = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
                let outputScale = min(1, CGFloat(edge) / max(pixelSize.width, pixelSize.height))
                let outputSize = CGSize(width: max(1, (pixelSize.width * outputScale).rounded()),
                                        height: max(1, (pixelSize.height * outputScale).rounded()))
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                format.opaque = true
                let normalized = UIGraphicsImageRenderer(size: outputSize, format: format).image { context in
                    UIColor.white.setFill()
                    context.fill(CGRect(origin: .zero, size: outputSize))
                    image.draw(in: CGRect(origin: .zero, size: outputSize))
                }
                guard let bytes = normalized.jpegData(compressionQuality: 0.85), bytes.count <= 4 * 1024 * 1024 else {
                    call.reject("This photo could not be prepared safely.", "PHOTO_UNAVAILABLE")
                    return
                }
                guard Self.canRead else {
                    call.reject("Photo access changed. Review your gallery permission.", "PERMISSION_DENIED")
                    return
                }
                guard PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject != nil else {
                    call.reject("This phone photo is no longer available.", "PHOTO_UNAVAILABLE")
                    return
                }
                call.resolve(["dataUrl": "data:image/jpeg;base64," + bytes.base64EncodedString()])
            }
        }
    }

    /// Only invoked by the explicit Manage photo access action in Journal.
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("Open Bubble's photo permissions in Settings.", "SETTINGS_UNAVAILABLE")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in call.resolve(["opened": opened]) }
        }
    }

    private static var canRead: Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        return status == .authorized || status == .limited
    }

    private static func visibleImages() -> PHFetchResult<PHAsset> {
        PHAsset.fetchAssets(with: .image, options: nil)
    }

    private func observeLibraryIfNeeded() {
        guard !observingLibrary else { return }
        // Called on the serial worker only after an opted-in permission check.
        PHPhotoLibrary.shared().register(self)
        observingLibrary = true
    }

    private static func permissionStatus() -> String {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .notDetermined: return "prompt"
        case .authorized: return "granted"
        case .limited: return "limited"
        case .denied, .restricted: return "denied"
        @unknown default: return "unavailable"
        }
    }
}

/// Framed fields distinguish nil, empty strings, and delimiter-containing names.
/// CryptoKit SHA-256 is available before this project's iOS 15 minimum target.
private struct PhoneGalleryFingerprint {
    private var hash = SHA256()

    mutating func add(_ value: String?) {
        guard let value else {
            var marker = UInt32.max.bigEndian
            withUnsafeBytes(of: &marker) { hash.update(data: Data($0)) }
            return
        }
        let bytes = Data(value.utf8)
        var length = UInt32(bytes.count).bigEndian
        withUnsafeBytes(of: &length) { hash.update(data: Data($0)) }
        hash.update(data: bytes)
    }

    mutating func add(_ digest: SHA256.Digest) {
        var length = UInt32(SHA256.byteCount).bigEndian
        withUnsafeBytes(of: &length) { hash.update(data: Data($0)) }
        hash.update(data: Data(digest))
    }

    mutating func finalize() -> SHA256.Digest { hash.finalize() }
}

/// PhotoKit may notify on any queue, including during a background page fetch.
private final class PhoneGalleryRevision {
    private let lock = NSLock()
    private var revision: UInt64 = 0

    var current: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return revision
    }

    func changed() {
        lock.lock()
        revision &+= 1
        lock.unlock()
    }
}

/// Serializes an asynchronous PhotoKit result without blocking the UI thread.
/// Late callbacks after the bounded timeout cannot retain a decoded image.
private final class PhoneGalleryImageResult {
    private let lock = NSLock()
    private let ready = DispatchSemaphore(value: 0)
    private var finished = false
    private var image: UIImage?

    func finish(image: UIImage?) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        self.image = image
        lock.unlock()
        ready.signal()
    }

    func wait(seconds: Int) -> UIImage? {
        _ = ready.wait(timeout: .now() + .seconds(seconds))
        lock.lock()
        finished = true
        let result = image
        image = nil
        lock.unlock()
        return result
    }
}
