import Foundation
import CryptoKit

/// Shared identifiers and filenames used by the app and its WidgetKit extension.
enum BubbleWidgetConstants {
    static let appGroupIdentifier = "group.com.simerfamily.kinsphere.widget"
    static let widgetKind = "BubbleWidget"
    static let snapshotFilename = "bubble-widget-snapshot-v1.json"
    static let thumbnailFilename = "bubble-widget-thumbnail-v1.jpg"
    static let deepLinkScheme = "com.simerfamily.kinsphere"
}

enum BubbleWidgetKind: String, Codable {
    case urgent
    case unlock
    case today
    case capture
    case memory
    case empty
}

enum BubbleWidgetTheme: String, Codable {
    case plum
    case forest
    case midnight
}

enum BubbleWidgetPrivacy: String, Codable {
    case full
    case hidden
}

enum BubbleWidgetPageGroup: String, Codable {
    case tasks, photos, recap, capture
}

enum BubbleWidgetLane: String, CaseIterable {
    case automatic = "BubbleWidget"
    case tasks = "BubbleTasksWidget"
    case photos = "BubblePhotosWidget"
    case recap = "BubbleRecapWidget"

    var group: BubbleWidgetPageGroup? {
        switch self {
        case .automatic: return nil
        case .tasks: return .tasks
        case .photos: return .photos
        case .recap: return .recap
        }
    }
}

struct BubbleWidgetPage: Codable {
    let id: String
    let group: BubbleWidgetPageGroup
    let kind: BubbleWidgetKind
    let theme: BubbleWidgetTheme
    let eyebrow: String
    let title: String
    let subtitle: String?
    let badge: String?
    let route: String
    let privacy: BubbleWidgetPrivacy

    func snapshot(in parent: BubbleWidgetSnapshot) -> BubbleWidgetSnapshot {
        BubbleWidgetSnapshot(
            version: parent.version,
            generatedAt: parent.generatedAt,
            nextRefreshAt: parent.nextRefreshAt,
            kind: kind,
            theme: theme,
            eyebrow: eyebrow,
            title: title,
            subtitle: subtitle,
            badge: badge,
            route: route,
            privacy: privacy,
            schedule: nil,
            mediaRevision: parent.mediaRevision
        )
    }
}

struct BubbleWidgetPageSelection {
    let pageID: String
    let selectedAt: Date

    func resolvedID(
        in snapshot: BubbleWidgetSnapshot,
        lane: BubbleWidgetLane,
        at date: Date,
        calendar: Calendar = .autoupdatingCurrent
    ) -> String? {
        guard calendar.isDate(selectedAt, inSameDayAs: date),
              snapshot.availablePages(for: lane, at: date, calendar: calendar)
                .contains(where: { $0.id == pageID }) else { return nil }
        return pageID
    }
}

/// A text-only card that becomes active at a same-day selector boundary.
struct BubbleWidgetScheduleEntry: Codable {
    let effectiveAt: String
    let kind: BubbleWidgetKind
    let theme: BubbleWidgetTheme
    let eyebrow: String
    let title: String
    let subtitle: String?
    let badge: String?
    let route: String
    let privacy: BubbleWidgetPrivacy

    var effectiveDate: Date? {
        BubbleWidgetDateCodec.date(from: effectiveAt)
    }
}

/// Versioned, platform-neutral payload written by Bubble's web layer.
struct BubbleWidgetSnapshot: Codable {
    let version: Int
    let generatedAt: String
    let nextRefreshAt: String?
    let kind: BubbleWidgetKind
    let theme: BubbleWidgetTheme
    let eyebrow: String
    let title: String
    let subtitle: String?
    let badge: String?
    let route: String
    let privacy: BubbleWidgetPrivacy
    let schedule: [BubbleWidgetScheduleEntry]?
    var pages: [BubbleWidgetPage]? = nil
    // Native-only revision keeps an old timeline from reading newly published
    // account media while the app replaces the snapshot atomically.
    var mediaRevision: String? = nil

    static let placeholder = BubbleWidgetSnapshot(
        version: 1,
        generatedAt: BubbleWidgetDateCodec.string(from: Date()),
        nextRefreshAt: nil,
        kind: .capture,
        theme: .plum,
        eyebrow: "A LITTLE MOMENT",
        title: "What should we remember today?",
        subtitle: "Take a quick photo for this week’s capsule.",
        badge: nil,
        route: "/",
        privacy: .hidden,
        schedule: nil
    )

    static let empty = BubbleWidgetSnapshot(
        version: 1,
        generatedAt: BubbleWidgetDateCodec.string(from: Date()),
        nextRefreshAt: nil,
        kind: .empty,
        theme: .plum,
        eyebrow: "BUBBLE",
        title: "Open Bubble",
        subtitle: "Little moments live here.",
        badge: nil,
        route: "/",
        privacy: .hidden,
        schedule: nil
    )

    static func privateFallback(theme: BubbleWidgetTheme) -> BubbleWidgetSnapshot {
        BubbleWidgetSnapshot(
            version: 1,
            generatedAt: BubbleWidgetDateCodec.string(from: Date()),
            nextRefreshAt: nil,
            kind: .empty,
            theme: theme,
            eyebrow: "BUBBLE",
            title: "Open Bubble",
            subtitle: "Little moments live here.",
            badge: nil,
            route: "/",
            privacy: .hidden,
            schedule: nil
        )
    }

    var generatedDate: Date? {
        BubbleWidgetDateCodec.date(from: generatedAt)
    }

    var nextRefreshDate: Date? {
        guard let nextRefreshAt else { return nil }
        return BubbleWidgetDateCodec.date(from: nextRefreshAt)
    }

    var deepLink: URL? {
        var components = URLComponents()
        components.scheme = BubbleWidgetConstants.deepLinkScheme
        components.host = "open"
        components.queryItems = [URLQueryItem(name: "route", value: route)]
        return components.url
    }

    func wasGenerated(onSameLocalDayAs date: Date, calendar: Calendar) -> Bool {
        guard let generatedDate else { return false }
        return calendar.isDate(generatedDate, inSameDayAs: date)
    }

    func availablePages(
        for lane: BubbleWidgetLane,
        at date: Date,
        calendar: Calendar = .autoupdatingCurrent
    ) -> [BubbleWidgetPage] {
        guard privacy == .full,
              wasGenerated(onSameLocalDayAs: date, calendar: calendar),
              let pages, pages.count <= 12,
              Set(pages.map(\.id)).count == pages.count,
              pages.allSatisfy({ $0.privacy == .full && $0.theme == theme }) else {
            return []
        }
        return pages.filter { lane.group == nil || $0.group == lane.group }
    }

    func emptySnapshot(for lane: BubbleWidgetLane) -> BubbleWidgetSnapshot {
        var fallback = BubbleWidgetSnapshot.privateFallback(theme: theme)
        guard privacy == .full, let group = lane.group else { return fallback }
        let title: String
        switch group {
        case .tasks: title = "Nothing planned today"
        case .photos: title = "Little memories will live here"
        case .recap: title = "Your next recap is gathering"
        case .capture: title = "A little moment?"
        }
        fallback = BubbleWidgetSnapshot(
            version: 1, generatedAt: generatedAt, nextRefreshAt: nil,
            kind: .empty, theme: theme, eyebrow: group.rawValue.capitalized,
            title: title, subtitle: "Open Bubble", badge: nil,
            route: group == .tasks ? "/journal?section=plans" : "/capsule",
            privacy: .hidden, schedule: nil
        )
        return fallback
    }

    func adjacentPageID(
        for lane: BubbleWidgetLane,
        currentPageID: String?,
        direction: Int,
        at date: Date,
        calendar: Calendar = .autoupdatingCurrent
    ) -> String? {
        let pages = availablePages(for: lane, at: date, calendar: calendar)
        guard !pages.isEmpty else { return nil }
        let current = pages.firstIndex { $0.id == currentPageID } ?? (direction < 0 ? 0 : -1)
        let next = (current + (direction < 0 ? -1 : 1) + pages.count) % pages.count
        return pages[next].id
    }

    /// Resolves the latest text-only transition. `mayUseCurrentThumbnail` is
    /// false for every scheduled card so current media cannot be mispaired.
    func resolvedForDisplay(
        at date: Date,
        calendar: Calendar
    ) -> (snapshot: BubbleWidgetSnapshot, mayUseCurrentThumbnail: Bool) {
        guard wasGenerated(onSameLocalDayAs: date, calendar: calendar) else {
            return (.privateFallback(theme: theme), false)
        }
        let latest = schedule?
            .compactMap { entry -> (BubbleWidgetScheduleEntry, Date)? in
                guard let effectiveDate = entry.effectiveDate,
                      effectiveDate <= date,
                      calendar.isDate(effectiveDate, inSameDayAs: date) else {
                    return nil
                }
                return (entry, effectiveDate)
            }
            .max { $0.1 < $1.1 }
        guard let entry = latest?.0 else {
            return (self, true)
        }
        return (
            BubbleWidgetSnapshot(
                version: version,
                generatedAt: generatedAt,
                nextRefreshAt: nextRefreshAt,
                kind: entry.kind,
                theme: entry.theme,
                eyebrow: entry.eyebrow,
                title: entry.title,
                subtitle: entry.subtitle,
                badge: entry.badge,
                route: entry.route,
                privacy: entry.privacy,
                schedule: nil
            ),
            false
        )
    }
}

enum BubbleWidgetDateCodec {
    static func date(from value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) {
            return date
        }

        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        return ordinary.date(from: value)
    }

    static func string(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

enum BubbleWidgetStorage {
    private static let selectionPrefix = "bubble-widget-selection-"
    private static let mediaPrefix = "bubble-widget-media-"
    static var containerURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: BubbleWidgetConstants.appGroupIdentifier
        )
    }

    static var snapshotURL: URL? {
        containerURL?.appendingPathComponent(BubbleWidgetConstants.snapshotFilename)
    }

    static var thumbnailURL: URL? {
        containerURL?.appendingPathComponent(BubbleWidgetConstants.thumbnailFilename)
    }

    static func thumbnailURL(for snapshot: BubbleWidgetSnapshot, pageID: String? = nil) -> URL? {
        guard let revision = snapshot.mediaRevision else {
            return pageID == nil ? thumbnailURL : nil
        }
        guard UUID(uuidString: revision) != nil else { return nil }
        let digest = SHA256.hash(data: Data((pageID ?? "current").utf8))
            .map { String(format: "%02x", $0) }.joined()
        return containerURL?.appendingPathComponent("\(mediaPrefix)\(revision)-\(digest).jpg")
    }

    static func clearMedia(except revision: String? = nil) throws {
        guard let containerURL else { return }
        let manager = FileManager.default
        for url in try manager.contentsOfDirectory(at: containerURL, includingPropertiesForKeys: nil) {
            let name = url.lastPathComponent
            guard name == BubbleWidgetConstants.thumbnailFilename || name.hasPrefix(mediaPrefix) else {
                continue
            }
            if let revision, name.hasPrefix("\(mediaPrefix)\(revision)-") { continue }
            try manager.removeItem(at: url)
        }
    }

    static func selectedPageID(
        for lane: BubbleWidgetLane,
        snapshot: BubbleWidgetSnapshot,
        at date: Date
    ) -> String? {
        let defaults = UserDefaults(suiteName: BubbleWidgetConstants.appGroupIdentifier)
        let key = selectionPrefix + lane.rawValue
        guard let selection = defaults?.dictionary(forKey: key),
              let pageID = selection["pageID"] as? String,
              let selectedAt = selection["selectedAt"] as? Date,
              let resolvedID = BubbleWidgetPageSelection(pageID: pageID, selectedAt: selectedAt)
                .resolvedID(in: snapshot, lane: lane, at: date) else {
            defaults?.removeObject(forKey: key)
            return nil
        }
        return resolvedID
    }

    static func selectPage(_ pageID: String, for lane: BubbleWidgetLane, at date: Date) {
        UserDefaults(suiteName: BubbleWidgetConstants.appGroupIdentifier)?.set(
            ["pageID": pageID, "selectedAt": date],
            forKey: selectionPrefix + lane.rawValue
        )
    }

    static func clearSelections() {
        let defaults = UserDefaults(suiteName: BubbleWidgetConstants.appGroupIdentifier)
        for lane in BubbleWidgetLane.allCases {
            defaults?.removeObject(forKey: selectionPrefix + lane.rawValue)
        }
    }

    static func loadSnapshot() -> BubbleWidgetSnapshot? {
        guard let snapshotURL,
              let data = try? Data(contentsOf: snapshotURL),
              let snapshot = try? JSONDecoder().decode(BubbleWidgetSnapshot.self, from: data),
              snapshot.version == 1 else {
            return nil
        }
        return snapshot
    }
}
