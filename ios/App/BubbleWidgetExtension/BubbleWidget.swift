import SwiftUI
import UIKit
import WidgetKit
import AppIntents

struct BubbleWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: BubbleWidgetSnapshot
    let thumbnail: UIImage?
    var lane: BubbleWidgetLane = .automatic
    var pageIDs: [String] = []
    var selectedPageID: String? = nil
}

struct BubbleWidgetProvider: TimelineProvider {
    var lane: BubbleWidgetLane = .automatic
    func placeholder(in context: Context) -> BubbleWidgetEntry {
        BubbleWidgetEntry(
            date: Date(),
            snapshot: .placeholder,
            thumbnail: nil
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (BubbleWidgetEntry) -> Void) {
        completion(entry(at: Date(), storedSnapshot: BubbleWidgetStorage.loadSnapshot()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BubbleWidgetEntry>) -> Void) {
        let now = Date()
        let calendar = Calendar.autoupdatingCurrent
        let startOfToday = calendar.startOfDay(for: now)
        let nextMidnight = calendar.date(byAdding: .day, value: 1, to: startOfToday)
            ?? now.addingTimeInterval(24 * 60 * 60)
        let storedSnapshot = BubbleWidgetStorage.loadSnapshot()
        let current = entry(at: now, storedSnapshot: storedSnapshot)
        var entries = [current]

        if let storedSnapshot,
           storedSnapshot.wasGenerated(onSameLocalDayAs: now, calendar: calendar),
           lane == .automatic,
           BubbleWidgetStorage.selectedPageID(for: lane, snapshot: storedSnapshot, at: now) == nil {
            let scheduledEntries = (storedSnapshot.schedule ?? [])
                .compactMap { scheduled -> BubbleWidgetEntry? in
                    guard let effectiveDate = scheduled.effectiveDate,
                          effectiveDate > now,
                          effectiveDate < nextMidnight else {
                        return nil
                    }
                    // Scheduled cards are deliberately text-only. A future
                    // reveal poster waits for an authenticated app republish.
                    return entry(at: effectiveDate, storedSnapshot: storedSnapshot)
                }
                .sorted { $0.date < $1.date }
            entries.append(contentsOf: scheduledEntries)
        }

        // Make the privacy boundary part of the timeline itself, even if iOS
        // delays the requested reload while the app remains suspended.
        entries.append(BubbleWidgetEntry(
            date: nextMidnight,
            snapshot: .privateFallback(theme: storedSnapshot?.theme ?? .plum),
            thumbnail: nil
        ))

        let requestedRefresh = current.snapshot.nextRefreshDate.flatMap { requested in
            requested > now ? requested : nil
        }
        let refreshDate = min(requestedRefresh ?? nextMidnight, nextMidnight)
        completion(Timeline(entries: entries, policy: .after(refreshDate)))
    }

    private func entry(
        at date: Date,
        storedSnapshot: BubbleWidgetSnapshot?
    ) -> BubbleWidgetEntry {
        let calendar = Calendar.autoupdatingCurrent
        let snapshot: BubbleWidgetSnapshot
        let mayLoadThumbnail: Bool
        var pageID: String?
        var pageIDs: [String] = []
        if let storedSnapshot,
           storedSnapshot.wasGenerated(onSameLocalDayAs: date, calendar: calendar) {
            let pages = storedSnapshot.availablePages(for: lane, at: date, calendar: calendar)
            pageIDs = pages.map(\.id)
            let savedPageID = BubbleWidgetStorage.selectedPageID(for: lane, snapshot: storedSnapshot, at: date)
            let selectedPage = pages.first { $0.id == savedPageID }
                ?? (lane == .automatic ? nil : pages.first)
            if let selectedPage {
                snapshot = selectedPage.snapshot(in: storedSnapshot)
                pageID = selectedPage.id
                mayLoadThumbnail = true
            } else if lane != .automatic {
                snapshot = storedSnapshot.emptySnapshot(for: lane)
                mayLoadThumbnail = false
            } else {
                let resolved = storedSnapshot.resolvedForDisplay(
                    at: date,
                    calendar: calendar
                )
                snapshot = resolved.snapshot
                mayLoadThumbnail = resolved.mayUseCurrentThumbnail
            }
        } else {
            snapshot = .privateFallback(theme: storedSnapshot?.theme ?? .plum)
            mayLoadThumbnail = false
        }
        var thumbnail: UIImage?
        if mayLoadThumbnail,
           snapshot.privacy == .full,
           let thumbnailURL = BubbleWidgetStorage.thumbnailURL(for: snapshot, pageID: pageID),
           let data = try? Data(contentsOf: thumbnailURL),
           data.count <= 5 * 1_024 * 1_024 {
            thumbnail = UIImage(data: data)
        }
        let displayedPageID = pageID ?? storedSnapshot?.pages?.first(where: {
            $0.route == snapshot.route && $0.title == snapshot.title
        })?.id
        return BubbleWidgetEntry(
            date: date, snapshot: snapshot, thumbnail: thumbnail,
            lane: lane, pageIDs: pageIDs, selectedPageID: displayedPageID
        )
    }
}

@available(iOS 16.0, *)
struct BrowseBubbleWidgetIntent: AppIntent {
    static var title: LocalizedStringResource = "Browse Bubble"
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Widget") var widgetKind: String
    @Parameter(title: "Current page") var currentPageID: String
    @Parameter(title: "Direction") var direction: Int

    init() {}

    init(lane: BubbleWidgetLane, currentPageID: String?, direction: Int) {
        self.widgetKind = lane.rawValue
        self.currentPageID = currentPageID ?? ""
        self.direction = direction
    }

    func perform() async throws -> some IntentResult {
        guard let lane = BubbleWidgetLane(rawValue: widgetKind),
              let snapshot = BubbleWidgetStorage.loadSnapshot() else { return .result() }
        let now = Date()
        let pages = snapshot.availablePages(for: lane, at: now)
        guard !pages.isEmpty else {
            WidgetCenter.shared.reloadAllTimelines()
            return .result()
        }
        let currentID = BubbleWidgetStorage.selectedPageID(for: lane, snapshot: snapshot, at: now)
            ?? currentPageID
        guard let nextID = snapshot.adjacentPageID(
            for: lane, currentPageID: currentID, direction: direction, at: now
        ) else { return .result() }
        BubbleWidgetStorage.selectPage(nextID, for: lane, at: now)
        WidgetCenter.shared.reloadTimelines(ofKind: lane.rawValue)
        return .result()
    }
}

private struct BubbleWidgetPalette {
    let background: Color
    let surface: Color
    let ink: Color
    let mutedInk: Color
    let accent: Color
    let secondaryAccent: Color

    init(theme: BubbleWidgetTheme) {
        switch theme {
        case .plum:
            background = Color(red: 0.16, green: 0.025, blue: 0.095)
            surface = Color(red: 1.0, green: 0.94, blue: 0.78)
            ink = Color(red: 0.20, green: 0.035, blue: 0.13)
            mutedInk = Color(red: 0.42, green: 0.25, blue: 0.34)
            accent = Color(red: 0.90, green: 0.64, blue: 0.74)
            secondaryAccent = Color(red: 0.67, green: 0.74, blue: 0.48)
        case .forest:
            background = Color(red: 0.015, green: 0.25, blue: 0.20)
            surface = Color(red: 0.98, green: 0.93, blue: 0.76)
            ink = Color(red: 0.02, green: 0.25, blue: 0.20)
            mutedInk = Color(red: 0.24, green: 0.38, blue: 0.30)
            accent = Color(red: 0.66, green: 0.73, blue: 0.47)
            secondaryAccent = Color(red: 0.89, green: 0.67, blue: 0.73)
        case .midnight:
            background = Color(red: 0.015, green: 0.06, blue: 0.20)
            surface = Color(red: 1.0, green: 0.94, blue: 0.77)
            ink = Color(red: 0.035, green: 0.10, blue: 0.27)
            mutedInk = Color(red: 0.20, green: 0.29, blue: 0.46)
            accent = Color(red: 0.97, green: 0.72, blue: 0.25)
            secondaryAccent = Color(red: 0.46, green: 0.61, blue: 0.84)
        }
    }
}

struct BubbleWidgetEntryView: View {
    let entry: BubbleWidgetEntry

    private var palette: BubbleWidgetPalette {
        BubbleWidgetPalette(theme: entry.snapshot.theme)
    }

    private var hasPoster: Bool {
        entry.thumbnail != nil &&
            entry.snapshot.privacy == .full &&
            (entry.snapshot.kind == .unlock || entry.snapshot.kind == .memory)
    }

    private var canBrowse: Bool {
        if #available(iOSApplicationExtension 17.0, *) {
            return entry.pageIDs.count > 1 && entry.snapshot.privacy == .full
        }
        return false
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                palette.background
                if hasPoster {
                    poster(size: geometry.size)
                } else {
                    BubblePaperTexture(palette: palette)
                    BubbleStateDoodles(kind: entry.snapshot.kind, palette: palette)
                    message
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
            .overlay(alignment: .bottom) {
                if #available(iOSApplicationExtension 17.0, *), canBrowse {
                    browsingControls
                }
            }
        }
        .widgetURL(entry.snapshot.deepLink)
        .bubbleWidgetBackground(palette.background)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }

    @available(iOSApplicationExtension 17.0, *)
    private var browsingControls: some View {
        HStack(spacing: 8) {
            browseButton(direction: -1, symbol: "chevron.left", label: "Previous Bubble card")
            Spacer(minLength: 0)
            Text(pagePosition)
                .font(.system(size: 8, weight: .medium, design: .rounded))
                .foregroundColor(palette.surface.opacity(0.9))
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(palette.background.opacity(hasPoster ? 0.7 : 0), in: Capsule())
                .accessibilityLabel("Card \(pagePosition)")
            Spacer(minLength: 0)
            browseButton(direction: 1, symbol: "chevron.right", label: "Next Bubble card")
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 7)
    }

    private var pagePosition: String {
        guard let index = entry.pageIDs.firstIndex(where: { $0 == entry.selectedPageID }) else {
            return "Browse"
        }
        return "\(index + 1) of \(entry.pageIDs.count)"
    }

    @available(iOSApplicationExtension 17.0, *)
    private func browseButton(direction: Int, symbol: String, label: String) -> some View {
        Button(intent: BrowseBubbleWidgetIntent(
            lane: entry.lane, currentPageID: entry.selectedPageID, direction: direction
        )) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(palette.surface)
                .frame(width: 28, height: 25)
                .background(palette.background.opacity(hasPoster ? 0.75 : 0.3), in: Capsule())
                .overlay(Capsule().stroke(palette.surface.opacity(0.24), lineWidth: 0.7))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 6) {
            Image(systemName: symbolName)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(palette.ink)
                .frame(width: 23, height: 23)
                .background(palette.accent, in: Circle())

            Text(entry.snapshot.eyebrow.uppercased())
                .font(.system(size: 8.5, weight: .bold, design: .rounded))
                .tracking(0.65)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .foregroundColor(palette.surface)
            Spacer(minLength: 2)
            if let badge = entry.snapshot.badge {
                Text(badge)
                    .font(.system(size: 9, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .foregroundColor(palette.surface)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 3)
                    .background(palette.surface.opacity(0.12))
                    .clipShape(Capsule())
            }
        }
    }

    private var message: some View {
        VStack(alignment: .leading, spacing: 5) {
            header
            Text(entry.snapshot.title)
                .font(.system(size: canBrowse ? 15 : 16, weight: .semibold, design: .serif))
                .foregroundColor(palette.surface)
                .lineLimit(canBrowse ? 2 : 3)
                .minimumScaleFactor(0.85)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)

            if isPlan, let subtitle = entry.snapshot.subtitle {
                planDetails(subtitle)
            } else if let subtitle = entry.snapshot.subtitle {
                Text(subtitle)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundColor(palette.surface.opacity(0.82))
                    .lineLimit(2)
                    .minimumScaleFactor(0.9)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .padding(.bottom, canBrowse ? 25 : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var isPlan: Bool {
        entry.snapshot.kind == .today || entry.snapshot.kind == .urgent
    }

    private func planDetails(_ subtitle: String) -> some View {
        let parts = subtitle.components(separatedBy: " · ")
        return VStack(alignment: .leading, spacing: 3) {
            Text(parts[0])
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundColor(palette.accent)
                .lineLimit(1)
                .minimumScaleFactor(0.9)
            if parts.count > 1 {
                Text(parts.dropFirst().joined(separator: " · "))
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundColor(palette.surface.opacity(0.82))
                    .lineLimit(canBrowse ? 1 : 2)
                    .minimumScaleFactor(0.9)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func poster(size: CGSize) -> some View {
        ZStack(alignment: .bottomLeading) {
            if let thumbnail = entry.thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size.width, height: size.height)
                    .clipped()
            }

            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.35), location: 0),
                    .init(color: .clear, location: 0.35),
                    .init(color: .black.opacity(0.12), location: 0.5),
                    .init(color: .black.opacity(0.76), location: 1)
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            VStack(alignment: .leading, spacing: 5) {
                Text(entry.snapshot.eyebrow.uppercased())
                    .font(.system(size: 8, weight: .bold, design: .rounded))
                    .tracking(0.8)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .foregroundColor(palette.surface)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(palette.background.opacity(0.65), in: Capsule())
                Spacer(minLength: 4)
                HStack(alignment: .bottom, spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(entry.snapshot.title)
                            .font(.system(size: 15, weight: .semibold, design: .serif))
                            .foregroundColor(palette.surface)
                            .lineLimit(2)
                            .minimumScaleFactor(0.85)
                        if let subtitle = entry.snapshot.subtitle {
                            Text(subtitle)
                                .font(.system(size: 9, weight: .medium, design: .rounded))
                                .foregroundColor(palette.surface.opacity(0.85))
                                .lineLimit(1)
                                .minimumScaleFactor(0.9)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if entry.snapshot.kind == .unlock {
                        Image(systemName: "play.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(palette.ink)
                            .offset(x: 1)
                            .frame(width: 28, height: 28)
                            .background(palette.surface.opacity(0.94), in: Circle())
                    }
                }
            }
            .padding(12)
            .padding(.bottom, canBrowse ? 28 : 0)
        }
        .frame(width: size.width, height: size.height)
    }

    private var symbolName: String {
        switch entry.snapshot.kind {
        case .urgent: return "bell.fill"
        case .unlock: return "play.fill"
        case .today: return "checkmark.circle.fill"
        case .capture: return "camera.fill"
        case .memory: return "photo.fill"
        case .empty: return "heart.fill"
        }
    }

    private var accessibilityLabel: String {
        [
            entry.snapshot.eyebrow,
            entry.snapshot.title,
            entry.snapshot.subtitle,
            entry.snapshot.badge
        ]
        .compactMap { $0 }
        .joined(separator: ". ")
    }
}

private struct BubblePaperTexture: View {
    let palette: BubbleWidgetPalette

    var body: some View {
        Canvas { context, size in
            var horizontalLines = Path()
            stride(from: CGFloat(10), through: size.height, by: 12).forEach { y in
                horizontalLines.move(to: CGPoint(x: 0, y: y))
                horizontalLines.addLine(to: CGPoint(x: size.width, y: y))
            }
            context.stroke(horizontalLines, with: .color(palette.surface.opacity(0.035)), lineWidth: 0.6)

            var diagonalLines = Path()
            stride(from: -size.height, through: size.width, by: 9).forEach { x in
                diagonalLines.move(to: CGPoint(x: x, y: 0))
                diagonalLines.addLine(to: CGPoint(x: x + size.height, y: size.height))
            }
            context.stroke(diagonalLines, with: .color(palette.surface.opacity(0.025)), lineWidth: 0.5)
        }
        .allowsHitTesting(false)
    }
}

private struct BubbleStateDoodles: View {
    let kind: BubbleWidgetKind
    let palette: BubbleWidgetPalette

    var body: some View {
        ZStack {
            Circle()
                .stroke(palette.accent.opacity(0.12), lineWidth: 1)
                .frame(width: 105, height: 105)
                .offset(x: 36, y: -25)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            Canvas { context, size in
                var path = Path()
                path.move(to: CGPoint(x: size.width * 0.56, y: size.height + 8))
                path.addCurve(
                    to: CGPoint(x: size.width + 8, y: size.height * 0.52),
                    control1: CGPoint(x: size.width * 0.51, y: size.height * 0.74),
                    control2: CGPoint(x: size.width * 0.95, y: size.height * 0.95)
                )
                context.stroke(
                    path,
                    with: .color(palette.secondaryAccent.opacity(0.16)),
                    style: StrokeStyle(lineWidth: 1.2, lineCap: .round, dash: [3, 5])
                )
            }

            Image(systemName: doodleSymbol)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(palette.accent.opacity(0.3))
                .rotationEffect(.degrees(kind == .urgent ? -10 : 8))
                .padding(9)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        }
        .allowsHitTesting(false)
    }

    private var doodleSymbol: String {
        switch kind {
        case .urgent: return "bell"
        case .unlock: return "sparkles"
        case .today: return "checkmark"
        case .capture: return "heart"
        case .memory: return "photo"
        case .empty: return "leaf"
        }
    }
}

private extension View {
    @ViewBuilder
    func bubbleWidgetBackground(_ color: Color) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(for: .widget) {
                color
            }
        } else {
            background(color)
        }
    }
}

struct BubbleHomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: BubbleWidgetConstants.widgetKind,
            provider: BubbleWidgetProvider()
        ) { entry in
            BubbleWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Bubble")
        .description("Plans, capsule reveals, and little family moments at a glance.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

struct BubbleTasksWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: BubbleWidgetLane.tasks.rawValue, provider: BubbleWidgetProvider(lane: .tasks)) {
            BubbleWidgetEntryView(entry: $0)
        }
        .configurationDisplayName("Bubble Tasks")
        .description("Today's plans. Add to a stack with Bubble Photos and Recap to swipe between them.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

struct BubblePhotosWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: BubbleWidgetLane.photos.rawValue, provider: BubbleWidgetProvider(lane: .photos)) {
            BubbleWidgetEntryView(entry: $0)
        }
        .configurationDisplayName("Bubble Photos")
        .description("A family photo you can leave on your Home Screen. Swipe between widgets in a stack.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

struct BubbleRecapWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: BubbleWidgetLane.recap.rawValue, provider: BubbleWidgetProvider(lane: .recap)) {
            BubbleWidgetEntryView(entry: $0)
        }
        .configurationDisplayName("Bubble Recap")
        .description("Your opened capsule recaps. Add to a stack with Bubble Tasks and Photos.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

@main
struct BubbleWidgetCollection: WidgetBundle {
    var body: some Widget {
        BubbleHomeWidget()
        BubbleTasksWidget()
        BubblePhotosWidget()
        BubbleRecapWidget()
    }
}
