import Foundation

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
