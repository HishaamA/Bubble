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
    case flight
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
    case tasks, photos, recap, capture, flights
}

enum BubbleWidgetLane: String, CaseIterable {
    case automatic = "BubbleWidget"
    case tasks = "BubbleTasksWidget"
    case photos = "BubblePhotosWidget"
    case recap = "BubbleRecapWidget"
    case flights = "BubbleFlightsWidget"

    var group: BubbleWidgetPageGroup? {
        switch self {
        case .automatic: return nil
        case .tasks: return .tasks
        case .photos: return .photos
        case .recap: return .recap
        case .flights: return .flights
        }
    }
}

/// Only the last provider timestamps, never live aircraft coordinates.
struct BubbleWidgetFlight: Codable {
    let departureAt: String
    let arrivalAt: String
    let updatedAt: String

    var departureDate: Date? { BubbleWidgetDateCodec.date(from: departureAt) }
    var arrivalDate: Date? { BubbleWidgetDateCodec.date(from: arrivalAt) }

    var isValid: Bool {
        guard let departure = departureDate, let arrival = arrivalDate,
              BubbleWidgetDateCodec.date(from: updatedAt) != nil else { return false }
        return arrival > departure && arrival.timeIntervalSince(departure) <= 36 * 3_600
    }

    func estimatedProgress(at date: Date) -> Double {
        guard isValid, let departure = departureDate, let arrival = arrivalDate else { return 0 }
        return min(1, max(0, date.timeIntervalSince(departure) / arrival.timeIntervalSince(departure)))
    }
}

struct BubbleWidgetMapPoint: Codable, Equatable {
    let x: Double
    let y: Double

    var isValid: Bool { x.isFinite && y.isFinite && (-360...720).contains(x) && (-180...360).contains(y) }
}

enum BubbleWidgetFlightMapMode: String, Codable {
    case live, estimated, scheduled, arrived, cancelled, unavailable

    var label: String {
        switch self {
        case .live: return "Last reported"
        case .estimated: return "Estimated"
        case .scheduled: return "Scheduled"
        case .arrived: return "Arrived"
        case .cancelled: return "Cancelled"
        case .unavailable: return "Position unavailable"
        }
    }
}

struct BubbleWidgetFlightMap: Codable {
    let start: BubbleWidgetMapPoint
    let end: BubbleWidgetMapPoint
    let control: BubbleWidgetMapPoint
    let marker: BubbleWidgetMapPoint
    let rotation: Double
    let mode: BubbleWidgetFlightMapMode
    let progress: Double?
    var advanceWithTime: Bool? = nil

    var isValid: Bool {
        let validProgress = progress.map { $0.isFinite && (0...100).contains($0) } ?? true
        return [start, end, control, marker].allSatisfy(\.isValid)
            && rotation.isFinite
            && validProgress
            && (mode != .cancelled || progress == nil)
    }

    /// Uses exactly the app's projected route. Provider percentages and cached
    /// live coordinates stay fixed; only explicitly opted-in estimates advance.
    func displayedMarker(at date: Date, flight: BubbleWidgetFlight?) -> (point: BubbleWidgetMapPoint, rotation: Double)? {
        guard isValid, mode != .cancelled, mode != .unavailable else { return nil }
        if mode == .arrived { return (end, rotation) }
        guard advanceWithTime == true, mode == .estimated || mode == .scheduled,
              let flight, flight.isValid else { return (marker, rotation) }
        let t = flight.estimatedProgress(at: date)
        let inverse = 1 - t
        let point = BubbleWidgetMapPoint(
            x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
            y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y
        )
        let dx = 2 * inverse * (control.x - start.x) + 2 * t * (end.x - control.x)
        let dy = 2 * inverse * (control.y - start.y) + 2 * t * (end.y - control.y)
        return (point, atan2(dy, dx) * 180 / .pi)
    }
}

/// Exactly the app's five minimalist land polygons, in shared 360×180 map space.
enum BubbleWidgetFlightMapGeometry {
    static let land: [[[Double]]] = [
        [[8,55],[22,41],[44,33],[103,40],[112,57],[72,72],[52,76],[40,98],[22,103],[13,83]],
        [[81,123],[97,131],[106,155],[101,173],[91,154],[79,142]],
        [[142,41],[164,24],[193,19],[211,28],[239,24],[263,34],[280,52],[273,64],[248,59],[232,71],[212,65],[197,80],[180,73],[170,52],[148,54]],
        [[231,106],[246,92],[270,97],[289,121],[277,147],[259,155],[246,136],[227,129]],
        [[299,63],[318,49],[342,52],[352,65],[343,75],[317,74]],
    ]
}

enum BubbleWidgetFlightValidity {
    static let maximumLifetime: TimeInterval = 36 * 3_600

    static func expiration(_ expiresAt: String?, generatedAt: Date?) -> Date? {
        guard let expiresAt, let generatedAt,
              let expiration = BubbleWidgetDateCodec.date(from: expiresAt),
              expiration > generatedAt,
              expiration.timeIntervalSince(generatedAt) <= maximumLifetime else { return nil }
        return expiration
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
    var expiresAt: String? = nil
    var flight: BubbleWidgetFlight? = nil
    var retainedFlight: Bool? = nil
    var flightMap: BubbleWidgetFlightMap? = nil

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
            mediaRevision: parent.mediaRevision,
            expiresAt: expiresAt,
            flight: flight,
            retainedFlight: retainedFlight,
            flightMap: flightMap
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
        guard let page = snapshot.availablePages(for: lane, at: date, calendar: calendar)
                .first(where: { $0.id == pageID }) else { return nil }
        guard calendar.isDate(selectedAt, inSameDayAs: date)
                || (page.kind == .flight && selectedAt >= (snapshot.generatedDate ?? date)
                    && selectedAt <= date) else { return nil }
        if page.group == .photos {
            // A manual photo choice stays visible for its current hour, then
            // reminiscing resumes. Task and recap choices stay member-owned.
            let anchor = max(selectedAt, snapshot.generatedDate ?? selectedAt)
            return snapshot.rotatingPhotoPage(
                startingWith: pageID, anchoredAt: anchor, at: date, calendar: calendar
            )?.id
        }
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
    var expiresAt: String? = nil
    var flight: BubbleWidgetFlight? = nil
    var retainedFlight: Bool? = nil
    var flightMap: BubbleWidgetFlightMap? = nil

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
    var expiresAt: String? = nil
    var flight: BubbleWidgetFlight? = nil
    var retainedFlight: Bool? = nil
    var flightMap: BubbleWidgetFlightMap? = nil

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
              latestScheduleEntry(at: date)?.privacy != .hidden,
              let pages, pages.count <= 112,
              pages.filter({ $0.kind == .flight }).count <= 100,
              pages.filter({ $0.kind != .flight }).count <= 12,
              Set(pages.map(\.id)).count == pages.count,
              pages.allSatisfy({ $0.privacy == .full && $0.theme == theme }) else {
            return []
        }
        return pages.filter { page in
            (lane.group == nil || page.group == lane.group)
                && canDisplay(kind: page.kind, privacy: page.privacy, expiresAt: page.expiresAt,
                              retainedFlight: page.retainedFlight, at: date, calendar: calendar)
        }
    }

    /// Rotate only the already-authorized, pre-shuffled photo deck. The page
    /// keeps its own route and thumbnail identity as one indivisible choice.
    func rotatingPhotoPage(
        startingWith pageID: String? = nil,
        anchoredAt anchor: Date? = nil,
        at date: Date,
        calendar: Calendar = .autoupdatingCurrent
    ) -> BubbleWidgetPage? {
        let photos = availablePages(for: .photos, at: date, calendar: calendar)
        guard !photos.isEmpty, let generatedDate else { return nil }
        let startIndex = photos.firstIndex { $0.id == pageID } ?? 0
        let from = anchor ?? generatedDate
        let elapsedHours = max(0, Int(floor(date.timeIntervalSince1970 / 3_600)
            - floor(from.timeIntervalSince1970 / 3_600)))
        return photos[(startIndex + elapsedHours) % photos.count]
    }

    /// Timeline entries are precomputed so photo rotation doesn't depend on
    /// the app opening again or WidgetKit accepting an immediate reload.
    func photoRotationDates(
        after date: Date,
        calendar: Calendar = .autoupdatingCurrent
    ) -> [Date] {
        guard availablePages(for: .photos, at: date, calendar: calendar).count > 1,
              let end = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: date))
        else { return [] }
        var next = Date(timeIntervalSince1970: (floor(date.timeIntervalSince1970 / 3_600) + 1) * 3_600)
        var dates: [Date] = []
        while next < end && dates.count < 25 {
            dates.append(next)
            next = next.addingTimeInterval(3_600)
        }
        return dates
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
        case .flights: title = "No tracked flights"
        }
        fallback = BubbleWidgetSnapshot(
            version: 1, generatedAt: generatedAt, nextRefreshAt: nil,
            kind: .empty, theme: theme, eyebrow: group.rawValue.capitalized,
            title: title, subtitle: "Open Bubble", badge: nil,
            route: group == .flights ? "/journal?section=flights"
                : group == .tasks ? "/journal?section=plans" : group == .photos ? "/journal" : "/capsule",
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
        guard privacy == .full else {
            return (.privateFallback(theme: theme), false)
        }
        let latest = latestScheduleEntry(at: date)
        guard latest?.privacy != .hidden else {
            return (.privateFallback(theme: theme), false)
        }
        let displayedKind = latest?.kind ?? kind
        let displayedPrivacy = latest?.privacy ?? privacy
        let displayedExpiry = latest == nil ? expiresAt : latest?.expiresAt
        let displayedRetention = latest == nil ? retainedFlight : latest?.retainedFlight
        guard canDisplay(kind: displayedKind, privacy: displayedPrivacy, expiresAt: displayedExpiry,
                         retainedFlight: displayedRetention, at: date, calendar: calendar) else {
            if let page = availablePages(for: .automatic, at: date, calendar: calendar).first {
                // The old primary card expired; only a separately valid page may replace it.
                return (page.snapshot(in: self), false)
            }
            return (.privateFallback(theme: theme), false)
        }
        guard let entry = latest else {
            return (self, kind != .flight)
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
                schedule: nil,
                expiresAt: entry.expiresAt,
                flight: entry.flight,
                retainedFlight: entry.retainedFlight,
                flightMap: entry.flightMap
            ),
            false
        )
    }

    private func latestScheduleEntry(at date: Date) -> BubbleWidgetScheduleEntry? {
        schedule?.filter { ($0.effectiveDate ?? .distantFuture) <= date }
            .max { ($0.effectiveDate ?? .distantPast) < ($1.effectiveDate ?? .distantPast) }
    }

    private func canDisplay(kind: BubbleWidgetKind, privacy: BubbleWidgetPrivacy, expiresAt: String?,
                            retainedFlight: Bool?, at date: Date, calendar: Calendar) -> Bool {
        guard privacy == .full, let generatedDate, date >= generatedDate else { return false }
        if kind == .flight && retainedFlight == true { return true }
        let expiration = BubbleWidgetFlightValidity.expiration(expiresAt, generatedAt: generatedDate)
        if expiresAt != nil {
            guard let expiration, date < expiration else { return false }
        }
        if wasGenerated(onSameLocalDayAs: date, calendar: calendar) { return true }
        // No tasks, photos, or recap metadata is carried into a new day.
        return kind == .flight && expiration != nil
    }

    /// Cached estimates are stepped every 15 minutes, including overnight,
    /// with exact arrival/expiry entries. WidgetKit may delay timeline delivery.
    func flightTimelineDates(after date: Date, calendar: Calendar = .autoupdatingCurrent) -> [Date] {
        guard privacy == .full, latestScheduleEntry(at: date)?.privacy != .hidden else { return [] }
        let candidates = [(kind, expiresAt, flight, retainedFlight, flightMap)]
            + (pages ?? []).map { ($0.kind, $0.expiresAt, $0.flight, $0.retainedFlight, $0.flightMap) }
            + (schedule ?? []).map { ($0.kind, $0.expiresAt, $0.flight, $0.retainedFlight, $0.flightMap) }
        var dates = Set<Date>()
        for (kind, expiry, flight, retained, map) in candidates where kind == .flight {
            let end: Date
            if retained == true {
                guard map?.advanceWithTime == true,
                      map?.mode == .estimated || map?.mode == .scheduled,
                      let flight, flight.isValid, let arrival = flight.arrivalDate, arrival > date else { continue }
                end = min(arrival, date.addingTimeInterval(36 * 3_600))
            } else {
                guard let expiration = BubbleWidgetFlightValidity.expiration(expiry, generatedAt: generatedDate), expiration > date else { continue }
                end = expiration
            }
            dates.insert(end)
            if let departure = flight?.departureDate, departure > date && departure < end { dates.insert(departure) }
            if let arrival = flight?.arrivalDate, arrival > date && arrival < end { dates.insert(arrival) }
            var next = Date(timeIntervalSince1970: (floor(date.timeIntervalSince1970 / 900) + 1) * 900)
            while next < end && dates.count < 160 {
                dates.insert(next)
                next = next.addingTimeInterval(900)
            }
        }
        return dates.sorted()
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
            // Building tomorrow's/another future timeline entry must not
            // erase a choice that remains valid on the currently shown card.
            if date <= Date() { defaults?.removeObject(forKey: key) }
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
              let data = try? Data(contentsOf: snapshotURL), data.count <= 256 * 1_024,
              let snapshot = try? JSONDecoder().decode(BubbleWidgetSnapshot.self, from: data),
              snapshot.version == 1 else {
            return nil
        }
        return snapshot
    }
}
