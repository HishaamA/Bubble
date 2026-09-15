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

/// One thumbnail instance per authorized page, shared by that page's future
/// hourly entries so a small widget does not decode the same photo all day.
private final class BubbleWidgetTimelineImages {
    var images: [URL: UIImage] = [:]
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
        let timelineImages = BubbleWidgetTimelineImages()
        let current = entry(at: now, storedSnapshot: storedSnapshot, timelineImages: timelineImages)
        var entries = [current]
        var futureDates = Set<Date>()

        if let storedSnapshot,
           storedSnapshot.wasGenerated(onSameLocalDayAs: now, calendar: calendar),
           lane == .automatic,
           BubbleWidgetStorage.selectedPageID(for: lane, snapshot: storedSnapshot, at: now) == nil {
            let scheduledDates = (storedSnapshot.schedule ?? [])
                .compactMap { scheduled -> Date? in
                    guard let effectiveDate = scheduled.effectiveDate,
                          effectiveDate > now,
                          effectiveDate < nextMidnight else {
                        return nil
                    }
                    return effectiveDate
                }
            futureDates.formUnion(scheduledDates)
        }
        if let storedSnapshot, lane == .automatic || lane == .photos {
            futureDates.formUnion(storedSnapshot.photoRotationDates(after: now, calendar: calendar))
        }
        if let storedSnapshot, lane == .automatic || lane == .flights {
            futureDates.formUnion(storedSnapshot.flightTimelineDates(after: now, calendar: calendar))
        }
        // Resolve midnight explicitly: photos/tasks/recaps disappear, while a
        // explicitly retained flights stay until removal/account clearing.
        futureDates.insert(nextMidnight)
        entries.append(contentsOf: futureDates.sorted().map {
            entry(at: $0, storedSnapshot: storedSnapshot, timelineImages: timelineImages)
        })

        let requestedRefresh = current.snapshot.nextRefreshDate.flatMap { requested in
            requested > now ? requested : nil
        }
        let refreshDate = min(requestedRefresh ?? nextMidnight, futureDates.min() ?? nextMidnight, nextMidnight)
        completion(Timeline(entries: entries, policy: .after(refreshDate)))
    }

    private func entry(
        at date: Date,
        storedSnapshot: BubbleWidgetSnapshot?,
        timelineImages: BubbleWidgetTimelineImages = BubbleWidgetTimelineImages()
    ) -> BubbleWidgetEntry {
        let calendar = Calendar.autoupdatingCurrent
        let snapshot: BubbleWidgetSnapshot
        let mayLoadThumbnail: Bool
        var pageID: String?
        var pageIDs: [String] = []
        if let storedSnapshot {
            let pages = storedSnapshot.availablePages(for: lane, at: date, calendar: calendar)
            pageIDs = pages.map(\.id)
            let savedPageID = BubbleWidgetStorage.selectedPageID(for: lane, snapshot: storedSnapshot, at: date)
            let selectedPage = pages.first { $0.id == savedPageID }
                ?? (lane == .photos
                    ? storedSnapshot.rotatingPhotoPage(at: date, calendar: calendar)
                    : lane == .automatic ? nil : pages.first)
            if let selectedPage {
                snapshot = selectedPage.snapshot(in: storedSnapshot)
                pageID = selectedPage.id
                mayLoadThumbnail = selectedPage.kind != .flight
            } else if lane != .automatic {
                snapshot = storedSnapshot.emptySnapshot(for: lane)
                mayLoadThumbnail = false
            } else {
                let resolved = storedSnapshot.resolvedForDisplay(
                    at: date,
                    calendar: calendar
                )
                if resolved.snapshot.kind == .memory,
                   resolved.snapshot.privacy == .full,
                   let photo = storedSnapshot.rotatingPhotoPage(at: date, calendar: calendar) {
                    // A future memory state must use the authorized page's
                    // matching poster and route, not the prior primary image.
                    snapshot = photo.snapshot(in: storedSnapshot)
                    pageID = photo.id
                    mayLoadThumbnail = true
                } else {
                    snapshot = resolved.snapshot
                    mayLoadThumbnail = resolved.mayUseCurrentThumbnail
                }
            }
        } else {
            snapshot = .privateFallback(theme: storedSnapshot?.theme ?? .plum)
            mayLoadThumbnail = false
        }
        var thumbnail: UIImage?
        if mayLoadThumbnail,
           snapshot.privacy == .full,
           let thumbnailURL = BubbleWidgetStorage.thumbnailURL(for: snapshot, pageID: pageID) {
            if let cached = timelineImages.images[thumbnailURL] {
                thumbnail = cached
            } else if let data = try? Data(contentsOf: thumbnailURL),
                      data.count <= 5 * 1_024 * 1_024,
                      let image = UIImage(data: data) {
                timelineImages.images[thumbnailURL] = image
                thumbnail = image
            }
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
        // Advance from the card the member actually tapped. WidgetKit may
        // render an hourly rotation a little late, so a clock-derived stored
        // selection can already be ahead of that visible card.
        let currentID = pages.contains(where: { $0.id == currentPageID })
            ? currentPageID
            : BubbleWidgetStorage.selectedPageID(for: lane, snapshot: snapshot, at: now)
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
    let accent: Color
    let secondaryAccent: Color

    init(theme: BubbleWidgetTheme) {
        switch theme {
        case .plum:
            background = Color(red: 45 / 255, green: 10 / 255, blue: 33 / 255)
            surface = Color(red: 1.0, green: 0.94, blue: 0.78)
            accent = Color(red: 0.90, green: 0.64, blue: 0.74)
            secondaryAccent = Color(red: 0.67, green: 0.74, blue: 0.48)
        case .forest:
            background = Color(red: 11 / 255, green: 61 / 255, blue: 51 / 255)
            surface = Color(red: 0.98, green: 0.93, blue: 0.76)
            accent = Color(red: 0.66, green: 0.73, blue: 0.47)
            secondaryAccent = Color(red: 0.89, green: 0.67, blue: 0.73)
        case .midnight:
            background = Color(red: 8 / 255, green: 22 / 255, blue: 53 / 255)
            surface = Color(red: 1.0, green: 0.94, blue: 0.77)
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
                BubbleWidgetBackdrop(palette: palette)
                if hasPoster {
                    poster(size: geometry.size)
                } else if entry.snapshot.kind == .flight {
                    flightMessage(size: geometry.size)
                } else {
                    message(size: geometry.size)
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
                .font(.system(size: 9, weight: .medium))
                .tracking(0.7)
                .foregroundColor(palette.surface.opacity(0.7))
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .accessibilityLabel("Card \(pagePosition)")
            Spacer(minLength: 0)
            browseButton(direction: 1, symbol: "chevron.right", label: "Next Bubble card")
        }
        .padding(.horizontal, 7)
        .padding(.bottom, 3)
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
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(palette.surface.opacity(0.9))
                .frame(width: 28, height: 28)
                .background(palette.background.opacity(hasPoster ? 0.55 : 0.2), in: Circle())
                .overlay(Circle().stroke(palette.surface.opacity(0.14), lineWidth: 0.6))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func header(compact: Bool) -> some View {
        HStack(alignment: .center, spacing: 6) {
            Image(systemName: symbolName)
                .font(.system(size: compact ? 9 : 11, weight: .regular))
                .foregroundColor(palette.accent)
                .accessibilityHidden(true)
            Text(entry.snapshot.eyebrow.uppercased())
                .font(.system(size: compact ? 8 : 9, weight: .medium))
                .tracking(compact ? 1.1 : 1.6)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .foregroundColor(palette.surface.opacity(0.74))
            Spacer(minLength: 2)
            if let badge = entry.snapshot.badge {
                Text(badge)
                    .font(.system(size: compact ? 8 : 9, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .foregroundColor(palette.surface)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(palette.surface.opacity(0.055), in: Capsule())
                    .overlay(Capsule().stroke(palette.surface.opacity(0.12), lineWidth: 0.6))
            }
        }
    }

    private func message(size: CGSize) -> some View {
        let compact = size.width < 260
        let tall = size.height > 230
        let dense = canBrowse && size.height < 180
        return VStack(alignment: .leading, spacing: 0) {
            header(compact: compact)
            Spacer(minLength: dense ? 4 : 12)
            Text(entry.snapshot.title)
                .font(.system(size: tall ? 38 : compact ? (dense ? 22 : 26) : dense ? 28 : 32,
                              weight: .regular, design: .serif))
                .foregroundColor(palette.surface)
                .lineSpacing(tall ? 2 : 0)
                .lineLimit(tall ? 4 : 2)
                .minimumScaleFactor(0.75)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(maxHeight: dense ? 48 : nil, alignment: .leading)
                .layoutPriority(1)
            if isPlan, let subtitle = entry.snapshot.subtitle {
                planDetails(subtitle, compact: compact, dense: dense)
                    .padding(.top, dense ? 5 : 10)
            } else if let subtitle = entry.snapshot.subtitle {
                Text(subtitle)
                    .font(.system(size: compact ? 10 : 12, weight: .regular))
                    .foregroundColor(palette.surface.opacity(0.72))
                    .lineLimit(dense ? 1 : 2)
                    .minimumScaleFactor(0.85)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, dense ? 5 : 9)
            }
            if tall {
                Spacer(minLength: 18)
                brandSignature
            }
        }
        .padding(.horizontal, compact ? 15 : 23)
        .padding(.top, dense ? 13 : compact ? 13 : 20)
        .padding(.bottom, canBrowse ? 47 : compact ? 17 : 21)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var brandSignature: some View {
        HStack(spacing: 7) {
            BubbleRingMark(color: palette.surface.opacity(0.5))
                .frame(width: 17, height: 12)
            Text("BUBBLE")
                .font(.system(size: 8, weight: .medium))
                .tracking(2.2)
                .foregroundColor(palette.surface.opacity(0.48))
        }
        .accessibilityHidden(true)
    }

    private var isPlan: Bool {
        entry.snapshot.kind == .today || entry.snapshot.kind == .urgent
    }

    private func flightMessage(size: CGSize) -> some View {
        let compact = size.width < 260
        let tall = size.height > 230
        let dense = canBrowse && size.height < 180
        return VStack(alignment: .leading, spacing: 0) {
            flightIdentity(compact: compact, dense: dense)
            Spacer(minLength: dense ? 4 : tall ? 24 : 9)
            flightTicketRoute(compact: compact, tall: tall, dense: dense)
            Spacer(minLength: dense ? 4 : tall ? 26 : 10)
            BubbleTicketPerforation(color: palette.surface.opacity(0.22))
                .frame(height: 1)
                .padding(.bottom, dense ? 5 : tall ? 16 : 9)
            flightDetails(compact: compact, tall: tall)
                .frame(maxWidth: .infinity, alignment: .leading)
            if tall {
                brandSignature.padding(.top, 22)
            }
        }
        .padding(.horizontal, compact ? 13 : 23)
        .padding(.top, dense ? 12 : compact ? 12 : 19)
        .padding(.bottom, canBrowse ? 47 : compact ? 13 : 18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func flightIdentity(compact: Bool, dense: Bool) -> some View {
        HStack(spacing: 6) {
            Text(entry.snapshot.eyebrow.uppercased())
                .font(.system(size: compact ? 8 : 9, weight: .medium))
                .tracking(compact ? 0.5 : 1.2)
                .foregroundColor(palette.surface.opacity(0.72))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let badge = entry.snapshot.badge {
                Text(badge)
                    .font(.system(size: compact ? 8 : 9, weight: .medium))
                    .foregroundColor(palette.surface)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .padding(.horizontal, compact ? 5 : 8)
                    .padding(.vertical, compact || dense ? 2 : 4)
                    .background(palette.surface.opacity(0.055), in: Capsule())
                    .overlay(Capsule().stroke(palette.surface.opacity(0.17), lineWidth: 0.6))
                    .frame(maxWidth: compact ? 67 : 118, alignment: .trailing)
            }
        }
    }

    @ViewBuilder
    private func flightTicketRoute(compact: Bool, tall: Bool, dense: Bool) -> some View {
        let codes = entry.snapshot.title.components(separatedBy: "→")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        if codes.count == 2, codes.allSatisfy({ !$0.isEmpty && $0.count <= 6 }) {
            HStack(alignment: .center, spacing: compact ? 5 : 15) {
                airportCode(codes[0], label: "FROM", alignment: .leading,
                            compact: compact, tall: tall, dense: dense)
                // A typographic ticket route, deliberately independent of map/position data.
                HStack(spacing: compact ? 3 : 6) {
                    Rectangle().fill(palette.surface.opacity(0.25)).frame(height: 0.7)
                    Image(systemName: "airplane")
                        .font(.system(size: tall ? 16 : compact ? 9 : 13, weight: .regular))
                        .foregroundColor(palette.accent.opacity(0.9))
                    Rectangle().fill(palette.surface.opacity(0.25)).frame(height: 0.7)
                }
                .frame(width: compact ? 24 : tall ? 60 : 52)
                .padding(.top, tall ? 17 : 0)
                .accessibilityHidden(true)
                airportCode(codes[1], label: "TO", alignment: .trailing,
                            compact: compact, tall: tall, dense: dense)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(entry.snapshot.title)
        } else {
            Text(entry.snapshot.title)
                .font(.system(size: tall ? 48 : compact ? 27 : 38, weight: .regular, design: .serif))
                .foregroundColor(palette.surface)
                .lineLimit(tall ? 2 : 1)
                .minimumScaleFactor(0.65)
        }
    }

    private func airportCode(
        _ code: String, label: String, alignment: HorizontalAlignment,
        compact: Bool, tall: Bool, dense: Bool
    ) -> some View {
        VStack(alignment: alignment, spacing: 8) {
            if tall {
                Text(label)
                    .font(.system(size: 8, weight: .medium))
                    .tracking(2.2)
                    .foregroundColor(palette.surface.opacity(0.56))
            }
            Text(code)
                .font(.system(size: tall ? 58 : compact ? (dense ? 29 : 34) : dense ? 34 : 42,
                              weight: .regular, design: .serif))
                .foregroundColor(palette.surface)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
        }
        .frame(maxWidth: .infinity, alignment: alignment == .leading ? .leading : .trailing)
    }

    private var flightArrivalLabel: String {
        let first = entry.snapshot.subtitle?.components(separatedBy: " · ").first ?? "Arrival time unavailable"
        return first.components(separatedBy: " (").first ?? first
    }

    private var flightArrivalDate: String? {
        guard let first = entry.snapshot.subtitle?.components(separatedBy: " · ").first,
              let open = first.range(of: " ("), first.hasSuffix(")") else { return nil }
        return String(first[open.upperBound...].dropLast())
    }

    private func flightSourceLine(tall: Bool) -> some View {
        Text(entry.snapshot.subtitle?.components(separatedBy: " · ").last ?? "Open Bubble for details")
            .font(.system(size: tall ? 10 : 8, weight: .regular))
            .foregroundColor(palette.surface.opacity(0.62))
            .lineLimit(1)
            .minimumScaleFactor(0.85)
    }

    private func flightDetails(compact: Bool, tall: Bool) -> some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: tall ? 5 : 2) {
                Text(flightArrivalLabel)
                    .font(.system(size: tall ? 18 : compact ? 10.5 : 13, weight: .medium))
                    .foregroundColor(palette.surface)
                    .lineLimit(tall ? 2 : 1)
                    .minimumScaleFactor(0.85)
                if let date = flightArrivalDate {
                    Text(date)
                        .font(.system(size: tall ? 11 : compact ? 8.5 : 9, weight: .regular))
                        .foregroundColor(palette.surface.opacity(0.76))
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
                if compact || tall {
                    flightSourceLine(tall: tall)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !compact && !tall {
                flightSourceLine(tall: false)
                    .frame(maxWidth: 105, alignment: .trailing)
            }
        }
    }

    private func planDetails(_ subtitle: String, compact: Bool, dense: Bool) -> some View {
        let parts = subtitle.components(separatedBy: " · ")
        return VStack(alignment: .leading, spacing: dense ? 2 : 4) {
            Text(parts[0])
                .font(.system(size: dense ? 10 : compact ? 11 : 13, weight: .medium))
                .foregroundColor(palette.accent)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
            if parts.count > 1 {
                Text(parts.dropFirst().joined(separator: " · "))
                    .font(.system(size: dense ? 9 : compact ? 10 : 11, weight: .regular))
                    .foregroundColor(palette.surface.opacity(0.7))
                    .lineLimit(dense ? 1 : 2)
                    .minimumScaleFactor(0.85)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func poster(size: CGSize) -> some View {
        let compact = size.width < 260
        let tall = size.height > 230
        let dense = canBrowse && size.height < 180
        let inset: CGFloat = compact ? 6 : 7
        let photoSize = CGSize(width: max(0, size.width - inset * 2),
                               height: max(0, size.height - inset * 2))
        let corner: CGFloat = compact ? 20 : 23
        return ZStack(alignment: .bottomLeading) {
            if let thumbnail = entry.thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(width: photoSize.width, height: photoSize.height)
                    .clipped()
            }
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.38), location: 0),
                    .init(color: .black.opacity(0.02), location: 0.32),
                    .init(color: .black.opacity(0.16), location: 0.48),
                    .init(color: .black.opacity(0.82), location: 1)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            VStack(alignment: .leading, spacing: 0) {
                Text(entry.snapshot.eyebrow.uppercased())
                    .font(.system(size: compact ? 8 : 9, weight: .medium))
                    .tracking(compact ? 1.2 : 1.8)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .foregroundColor(palette.surface.opacity(0.92))
                Spacer(minLength: dense ? 4 : 12)
                HStack(alignment: .bottom, spacing: 9) {
                    VStack(alignment: .leading, spacing: dense ? 3 : 6) {
                        Text(entry.snapshot.title)
                            .font(.system(size: tall ? 40 : compact ? (dense ? 22 : 26) : 32,
                                          weight: .regular, design: .serif))
                            .foregroundColor(palette.surface)
                            .lineLimit(tall ? 3 : 2)
                            .minimumScaleFactor(0.75)
                            .frame(maxHeight: dense ? 48 : nil, alignment: .leading)
                        if let subtitle = entry.snapshot.subtitle {
                            Text(subtitle)
                                .font(.system(size: compact ? 9 : 11, weight: .regular))
                                .foregroundColor(palette.surface.opacity(0.8))
                                .lineLimit(1)
                                .minimumScaleFactor(0.85)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if entry.snapshot.kind == .unlock {
                        Image(systemName: "play.fill")
                            .font(.system(size: compact ? 9 : 11, weight: .medium))
                            .foregroundColor(palette.surface)
                            .offset(x: 1)
                            .frame(width: compact ? 27 : 34, height: compact ? 27 : 34)
                            .background(palette.background.opacity(0.35), in: Circle())
                            .overlay(Circle().stroke(palette.surface.opacity(0.48), lineWidth: 0.7))
                            .accessibilityHidden(true)
                    }
                }
            }
            .padding(compact || dense ? 11 : 18)
            .padding(.bottom, canBrowse ? 36 : 0)
        }
        .frame(width: photoSize.width, height: photoSize.height)
        .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: corner, style: .continuous)
                .stroke(palette.surface.opacity(0.16), lineWidth: 0.7)
        )
        .padding(inset)
    }

    private var symbolName: String {
        switch entry.snapshot.kind {
        case .urgent: return "bell"
        case .unlock: return "play"
        case .today: return "checkmark.circle"
        case .capture: return "camera"
        case .memory: return "photo"
        case .flight: return "airplane"
        case .empty: return "heart"
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

private struct BubbleWidgetBackdrop: View {
    let palette: BubbleWidgetPalette

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                palette.background
                RadialGradient(
                    colors: [palette.accent.opacity(0.11), .clear],
                    center: .topTrailing,
                    startRadius: 0,
                    endRadius: max(geometry.size.width, geometry.size.height) * 0.9
                )
                LinearGradient(
                    colors: [.clear, palette.secondaryAccent.opacity(0.025)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                BubbleRingMark(color: palette.surface.opacity(0.055))
                    .frame(width: geometry.size.width * 0.82, height: geometry.size.width * 0.58)
                    .rotationEffect(.degrees(-20))
                    .offset(x: geometry.size.width * 0.24, y: -geometry.size.width * 0.12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                RoundedRectangle(cornerRadius: 25, style: .continuous)
                    .stroke(palette.surface.opacity(0.1), lineWidth: 0.7)
                    .padding(0.7)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct BubbleRingMark: View {
    let color: Color

    var body: some View {
        GeometryReader { geometry in
            let side = min(geometry.size.width, geometry.size.height)
            let scale = side / 80
            ZStack {
                Circle()
                    .stroke(color, lineWidth: 5.5 * scale)
                    .frame(width: 26 * scale, height: 26 * scale)
                    .position(x: 28 * scale, y: 18 * scale)
                Circle()
                    .stroke(color, lineWidth: 5.5 * scale)
                    .frame(width: 16 * scale, height: 16 * scale)
                    .position(x: 58 * scale, y: 13 * scale)
                Circle()
                    .stroke(color, lineWidth: 5.5 * scale)
                    .frame(width: 14 * scale, height: 14 * scale)
                    .position(x: 17 * scale, y: 56 * scale)
                Circle()
                    .stroke(color, lineWidth: 5.5 * scale)
                    .frame(width: 36 * scale, height: 36 * scale)
                    .position(x: 53 * scale, y: 53 * scale)
            }
            .frame(width: side, height: side)
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }
}

private struct BubbleTicketPerforation: View {
    let color: Color

    var body: some View {
        Canvas { context, size in
            var rule = Path()
            rule.move(to: CGPoint(x: 0, y: size.height / 2))
            rule.addLine(to: CGPoint(x: size.width, y: size.height / 2))
            context.stroke(rule, with: .color(color),
                           style: StrokeStyle(lineWidth: 0.7, dash: [1.5, 3.5]))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
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
        .description("Plans, tracked flights, capsule reveals, and family moments at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
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
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
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
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
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
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}

struct BubbleFlightsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: BubbleWidgetLane.flights.rawValue, provider: BubbleWidgetProvider(lane: .flights)) {
            BubbleWidgetEntryView(entry: $0)
        }
        .configurationDisplayName("Bubble Flights")
        .description("All your tracked flights, arrival times and cached status. A flight remains here until you remove it in Bubble.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
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
        BubbleFlightsWidget()
    }
}
