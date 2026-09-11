import Capacitor
import Foundation
import ImageIO
import UIKit
import WidgetKit

private enum BubbleWidgetPluginError: LocalizedError {
    case missingSnapshot
    case snapshotTooLarge
    case invalidSnapshot
    case unsupportedVersion
    case invalidField(String)
    case invalidThumbnail
    case thumbnailTooLarge
    case storageUnavailable

    var errorDescription: String? {
        switch self {
        case .missingSnapshot:
            return "A widget snapshot is required."
        case .snapshotTooLarge:
            return "The widget snapshot is too large."
        case .invalidSnapshot:
            return "The widget snapshot is not valid JSON."
        case .unsupportedVersion:
            return "This widget snapshot version is not supported."
        case .invalidField(let field):
            return "The widget snapshot has an invalid \(field)."
        case .invalidThumbnail:
            return "The widget thumbnail is not a valid image."
        case .thumbnailTooLarge:
            return "The widget thumbnail is too large."
        case .storageUnavailable:
            return "Widget storage is not available on this device."
        }
    }
}

/// Persists a bounded widget payload in the app group shared with WidgetKit.
@objc(BubbleWidgetPlugin)
public final class BubbleWidgetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BubbleWidgetPlugin"
    public let jsName = "BubbleWidget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    private let workQueue = DispatchQueue(
        label: "com.simerfamily.kinsphere.widget-storage",
        qos: .utility
    )

    private let maximumSnapshotBytes = 32 * 1_024
    private let maximumScheduleEntries = 12
    private let maximumThumbnailCharacters = 8 * 1_024 * 1_024
    private let maximumThumbnailBytes = 5 * 1_024 * 1_024
    private let maximumThumbnailPixels: Int64 = 36_000_000
    private let maximumStoredEdge: CGFloat = 720

    @objc func update(_ call: CAPPluginCall) {
        guard let snapshotJSON = call.getString("snapshot") else {
            call.reject(BubbleWidgetPluginError.missingSnapshot.localizedDescription, "MISSING_SNAPSHOT")
            return
        }
        let thumbnailBase64 = call.getString("thumbnailBase64")

        workQueue.async { [weak self] in
            guard let self else { return }
            do {
                let snapshot = try self.validatedSnapshot(snapshotJSON)
                let thumbnail: Data?
                if snapshot.privacy == .full, let thumbnailBase64, !thumbnailBase64.isEmpty {
                    thumbnail = try self.normalizedThumbnail(thumbnailBase64)
                } else {
                    thumbnail = nil
                }
                try self.persist(snapshot: snapshot, thumbnail: thumbnail)
                WidgetCenter.shared.reloadTimelines(ofKind: BubbleWidgetConstants.widgetKind)
                call.resolve()
            } catch {
                // persist(snapshot:) installs a generic private snapshot before
                // touching media. Reload even on failure so WidgetKit cannot
                // keep showing the previously rendered family content.
                WidgetCenter.shared.reloadTimelines(ofKind: BubbleWidgetConstants.widgetKind)
                call.reject(error.localizedDescription, "WIDGET_UPDATE_FAILED", error)
            }
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        workQueue.async {
            do {
                guard let containerURL = BubbleWidgetStorage.containerURL,
                      let snapshotURL = BubbleWidgetStorage.snapshotURL,
                      let thumbnailURL = BubbleWidgetStorage.thumbnailURL else {
                    throw BubbleWidgetPluginError.storageUnavailable
                }
                let fileManager = FileManager.default
                try fileManager.createDirectory(
                    at: containerURL,
                    withIntermediateDirectories: true,
                    attributes: nil
                )

                let currentTheme = BubbleWidgetStorage.loadSnapshot()?.theme ?? .plum
                try self.writeSnapshot(
                    .privateFallback(theme: currentTheme),
                    to: snapshotURL
                )
                if fileManager.fileExists(atPath: thumbnailURL.path) {
                    try fileManager.removeItem(at: thumbnailURL)
                }
                WidgetCenter.shared.reloadTimelines(ofKind: BubbleWidgetConstants.widgetKind)
                call.resolve()
            } catch {
                WidgetCenter.shared.reloadTimelines(ofKind: BubbleWidgetConstants.widgetKind)
                call.reject(error.localizedDescription, "WIDGET_CLEAR_FAILED", error)
            }
        }
    }

    private func validatedSnapshot(_ json: String) throws -> BubbleWidgetSnapshot {
        guard let data = json.data(using: .utf8), data.count <= maximumSnapshotBytes else {
            throw BubbleWidgetPluginError.snapshotTooLarge
        }
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else {
            throw BubbleWidgetPluginError.invalidSnapshot
        }

        let allowedKeys: Set<String> = [
            "version", "generatedAt", "nextRefreshAt", "kind", "theme",
            "eyebrow", "title", "subtitle", "badge", "route", "privacy",
            "schedule"
        ]
        guard Set(dictionary.keys).isSubset(of: allowedKeys) else {
            throw BubbleWidgetPluginError.invalidSnapshot
        }
        guard let version = dictionary["version"] as? Int, version == 1 else {
            throw BubbleWidgetPluginError.unsupportedVersion
        }

        let generatedAt = try requiredString(dictionary, key: "generatedAt", maximumBytes: 64)
        guard let generatedDate = BubbleWidgetDateCodec.date(from: generatedAt) else {
            throw BubbleWidgetPluginError.invalidField("generatedAt")
        }
        let nextRefreshAt = try optionalString(dictionary, key: "nextRefreshAt", maximumBytes: 64)
        if let nextRefreshAt, BubbleWidgetDateCodec.date(from: nextRefreshAt) == nil {
            throw BubbleWidgetPluginError.invalidField("nextRefreshAt")
        }

        let kindValue = try requiredString(dictionary, key: "kind", maximumBytes: 16)
        guard let kind = BubbleWidgetKind(rawValue: kindValue) else {
            throw BubbleWidgetPluginError.invalidField("kind")
        }
        let themeValue = try requiredString(dictionary, key: "theme", maximumBytes: 16)
        guard let theme = BubbleWidgetTheme(rawValue: themeValue) else {
            throw BubbleWidgetPluginError.invalidField("theme")
        }
        let privacyValue = try requiredString(dictionary, key: "privacy", maximumBytes: 16)
        guard let privacy = BubbleWidgetPrivacy(rawValue: privacyValue) else {
            throw BubbleWidgetPluginError.invalidField("privacy")
        }

        let eyebrow = try requiredString(dictionary, key: "eyebrow", maximumBytes: 64)
        // Captions and locations are bounded by the service in characters;
        // allow their worst-case UTF-8 width and let SwiftUI line limits handle
        // the visual truncation in the compact widget.
        let title = try requiredString(dictionary, key: "title", maximumBytes: 1_040)
        let subtitle = try optionalString(dictionary, key: "subtitle", maximumBytes: 1_280)
        let badge = try optionalString(dictionary, key: "badge", maximumBytes: 64)
        let route = try requiredString(dictionary, key: "route", maximumBytes: 512)
        guard route.hasPrefix("/"),
              !route.hasPrefix("//"),
              !route.contains("\\"),
              !route.contains("://"),
              route.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }) else {
            throw BubbleWidgetPluginError.invalidField("route")
        }
        let schedule = try validatedSchedule(
            dictionary["schedule"],
            generatedDate: generatedDate,
            expectedTheme: theme,
            expectedPrivacy: privacy
        )

        return BubbleWidgetSnapshot(
            version: version,
            generatedAt: generatedAt,
            nextRefreshAt: nextRefreshAt,
            kind: kind,
            theme: theme,
            eyebrow: eyebrow,
            title: title,
            subtitle: subtitle,
            badge: badge,
            route: route,
            privacy: privacy,
            schedule: schedule
        )
    }

    private func validatedSchedule(
        _ rawValue: Any?,
        generatedDate: Date,
        expectedTheme: BubbleWidgetTheme,
        expectedPrivacy: BubbleWidgetPrivacy
    ) throws -> [BubbleWidgetScheduleEntry]? {
        guard let rawValue, !(rawValue is NSNull) else { return nil }
        guard let values = rawValue as? [Any],
              values.count <= maximumScheduleEntries else {
            throw BubbleWidgetPluginError.invalidField("schedule")
        }

        let calendar = Calendar.autoupdatingCurrent
        let startOfGeneratedDay = calendar.startOfDay(for: generatedDate)
        let nextMidnight = calendar.date(
            byAdding: .day,
            value: 1,
            to: startOfGeneratedDay
        ) ?? startOfGeneratedDay.addingTimeInterval(24 * 60 * 60)
        let allowedKeys: Set<String> = [
            "effectiveAt", "kind", "theme", "eyebrow", "title",
            "subtitle", "badge", "route", "privacy"
        ]
        var previousDate = generatedDate
        var entries: [BubbleWidgetScheduleEntry] = []

        for rawEntry in values {
            guard let dictionary = rawEntry as? [String: Any],
                  Set(dictionary.keys).isSubset(of: allowedKeys) else {
                throw BubbleWidgetPluginError.invalidField("schedule")
            }
            let effectiveAt = try requiredString(
                dictionary,
                key: "effectiveAt",
                maximumBytes: 64
            )
            guard let effectiveDate = BubbleWidgetDateCodec.date(from: effectiveAt),
                  effectiveDate > previousDate,
                  effectiveDate < nextMidnight,
                  calendar.isDate(effectiveDate, inSameDayAs: generatedDate) else {
                throw BubbleWidgetPluginError.invalidField("schedule.effectiveAt")
            }

            let kindValue = try requiredString(dictionary, key: "kind", maximumBytes: 16)
            let themeValue = try requiredString(dictionary, key: "theme", maximumBytes: 16)
            let privacyValue = try requiredString(dictionary, key: "privacy", maximumBytes: 16)
            guard let kind = BubbleWidgetKind(rawValue: kindValue),
                  let theme = BubbleWidgetTheme(rawValue: themeValue),
                  let privacy = BubbleWidgetPrivacy(rawValue: privacyValue),
                  theme == expectedTheme,
                  privacy == expectedPrivacy else {
                throw BubbleWidgetPluginError.invalidField("schedule")
            }

            let eyebrow = try requiredString(dictionary, key: "eyebrow", maximumBytes: 64)
            let title = try requiredString(dictionary, key: "title", maximumBytes: 1_040)
            let subtitle = try optionalString(dictionary, key: "subtitle", maximumBytes: 1_280)
            let badge = try optionalString(dictionary, key: "badge", maximumBytes: 64)
            let route = try requiredString(dictionary, key: "route", maximumBytes: 512)
            guard route.hasPrefix("/"),
                  !route.hasPrefix("//"),
                  !route.contains("\\"),
                  !route.contains("://"),
                  route.unicodeScalars.allSatisfy({
                      !CharacterSet.controlCharacters.contains($0)
                  }) else {
                throw BubbleWidgetPluginError.invalidField("schedule.route")
            }

            entries.append(BubbleWidgetScheduleEntry(
                effectiveAt: effectiveAt,
                kind: kind,
                theme: theme,
                eyebrow: eyebrow,
                title: title,
                subtitle: subtitle,
                badge: badge,
                route: route,
                privacy: privacy
            ))
            previousDate = effectiveDate
        }
        return entries
    }

    private func requiredString(
        _ dictionary: [String: Any],
        key: String,
        maximumBytes: Int
    ) throws -> String {
        guard let raw = dictionary[key] as? String else {
            throw BubbleWidgetPluginError.invalidField(key)
        }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= maximumBytes else {
            throw BubbleWidgetPluginError.invalidField(key)
        }
        return value
    }

    private func optionalString(
        _ dictionary: [String: Any],
        key: String,
        maximumBytes: Int
    ) throws -> String? {
        guard let rawValue = dictionary[key], !(rawValue is NSNull) else {
            return nil
        }
        guard let raw = rawValue as? String else {
            throw BubbleWidgetPluginError.invalidField(key)
        }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= maximumBytes else {
            throw BubbleWidgetPluginError.invalidField(key)
        }
        return value
    }

    private func normalizedThumbnail(_ encodedValue: String) throws -> Data {
        guard encodedValue.utf8.count <= maximumThumbnailCharacters else {
            throw BubbleWidgetPluginError.thumbnailTooLarge
        }

        let base64: String
        if encodedValue.hasPrefix("data:") {
            guard let comma = encodedValue.firstIndex(of: ",") else {
                throw BubbleWidgetPluginError.invalidThumbnail
            }
            let header = String(encodedValue[..<comma]).lowercased()
            guard [
                "data:image/jpeg;base64",
                "data:image/jpg;base64",
                "data:image/png;base64"
            ].contains(header) else {
                throw BubbleWidgetPluginError.invalidThumbnail
            }
            base64 = String(encodedValue[encodedValue.index(after: comma)...])
        } else {
            base64 = encodedValue
        }

        guard let imageData = Data(base64Encoded: base64),
              !imageData.isEmpty,
              imageData.count <= maximumThumbnailBytes,
              let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let pixelHeight = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
            throw BubbleWidgetPluginError.invalidThumbnail
        }

        let pixels = pixelWidth.int64Value * pixelHeight.int64Value
        guard pixelWidth.intValue > 0,
              pixelHeight.intValue > 0,
              pixels > 0,
              pixels <= maximumThumbnailPixels,
              let image = UIImage(data: imageData) else {
            throw BubbleWidgetPluginError.thumbnailTooLarge
        }

        let longestEdge = max(image.size.width, image.size.height)
        let scale = min(1, maximumStoredEdge / longestEdge)
        let size = CGSize(
            width: max(1, image.size.width * scale),
            height: max(1, image.size.height * scale)
        )
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let normalizedImage = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor(red: 0.13, green: 0.03, blue: 0.09, alpha: 1).setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let output = normalizedImage.jpegData(compressionQuality: 0.82),
              output.count <= maximumThumbnailBytes else {
            throw BubbleWidgetPluginError.thumbnailTooLarge
        }
        return output
    }

    private func persist(snapshot: BubbleWidgetSnapshot, thumbnail: Data?) throws {
        guard let containerURL = BubbleWidgetStorage.containerURL,
              let snapshotURL = BubbleWidgetStorage.snapshotURL,
              let thumbnailURL = BubbleWidgetStorage.thumbnailURL else {
            throw BubbleWidgetPluginError.storageUnavailable
        }

        let fileManager = FileManager.default
        try fileManager.createDirectory(
            at: containerURL,
            withIntermediateDirectories: true,
            attributes: nil
        )

        // A generic snapshot is the transaction's privacy boundary. If media
        // cleanup or the final write fails, the extension can only render this
        // non-sensitive card and will never pair content across accounts.
        try writeSnapshot(
            .privateFallback(theme: snapshot.theme),
            to: snapshotURL
        )

        if let thumbnail {
            try thumbnail.write(to: thumbnailURL, options: [.atomic, .completeFileProtectionUnlessOpen])
        } else if fileManager.fileExists(atPath: thumbnailURL.path) {
            try fileManager.removeItem(at: thumbnailURL)
        }

        try writeSnapshot(snapshot, to: snapshotURL)
    }

    private func writeSnapshot(
        _ snapshot: BubbleWidgetSnapshot,
        to snapshotURL: URL
    ) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let canonicalSnapshot = try encoder.encode(snapshot)
        try canonicalSnapshot.write(
            to: snapshotURL,
            options: [.atomic, .completeFileProtectionUnlessOpen]
        )
    }
}
