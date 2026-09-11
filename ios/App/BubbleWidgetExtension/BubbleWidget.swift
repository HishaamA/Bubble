import SwiftUI
import UIKit
import WidgetKit

struct BubbleWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: BubbleWidgetSnapshot
    let thumbnail: UIImage?
}

struct BubbleWidgetProvider: TimelineProvider {
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
           storedSnapshot.wasGenerated(onSameLocalDayAs: now, calendar: calendar) {
            let scheduledEntries = (storedSnapshot.schedule ?? [])
                .compactMap { scheduled -> BubbleWidgetEntry? in
                    guard let effectiveDate = scheduled.effectiveDate,
                          effectiveDate > now,
                          effectiveDate < nextMidnight else {
                        return nil
                    }
                    // Scheduled cards are deliberately text-only. A future
                    // reveal poster waits for an authenticated app republish.
                    let resolved = storedSnapshot.resolvedForDisplay(
                        at: effectiveDate,
                        calendar: calendar
                    )
                    return BubbleWidgetEntry(
                        date: effectiveDate,
                        snapshot: resolved.snapshot,
                        thumbnail: nil
                    )
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
        if let storedSnapshot {
            let resolved = storedSnapshot.resolvedForDisplay(
                at: date,
                calendar: calendar
            )
            snapshot = resolved.snapshot
            mayLoadThumbnail = resolved.mayUseCurrentThumbnail
        } else {
            snapshot = .empty
            mayLoadThumbnail = false
        }
        var thumbnail: UIImage?
        if mayLoadThumbnail,
           snapshot.privacy == .full,
           let thumbnailURL = BubbleWidgetStorage.thumbnailURL,
           let data = try? Data(contentsOf: thumbnailURL),
           data.count <= 5 * 1_024 * 1_024 {
            thumbnail = UIImage(data: data)
        }
        return BubbleWidgetEntry(date: date, snapshot: snapshot, thumbnail: thumbnail)
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

    var body: some View {
        ZStack {
            palette.background
            BubblePaperTexture(palette: palette)
            BubbleStateDoodles(kind: entry.snapshot.kind, palette: palette)

            VStack(alignment: .leading, spacing: 7) {
                header
                if hasPoster {
                    poster
                } else {
                    message
                }
            }
            .padding(12)
        }
        .widgetURL(entry.snapshot.deepLink)
        .bubbleWidgetBackground(palette.background)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 5) {
            Text(entry.snapshot.eyebrow.uppercased())
                .font(.system(size: 9, weight: .bold, design: .rounded))
                .tracking(1.2)
                .lineLimit(1)
                .foregroundColor(palette.surface.opacity(0.9))
            Spacer(minLength: 2)
            if let badge = entry.snapshot.badge {
                Text(badge)
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .foregroundColor(palette.ink)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(palette.surface)
                    .clipShape(Capsule())
            }
        }
    }

    private var message: some View {
        VStack(alignment: .leading, spacing: 5) {
            ZStack {
                Circle()
                    .fill(palette.accent)
                    .frame(width: 29, height: 29)
                Image(systemName: symbolName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(palette.ink)
            }

            Text(entry.snapshot.title)
                .font(.system(size: 17, weight: .semibold, design: .serif))
                .foregroundColor(palette.surface)
                .lineLimit(2)
                .minimumScaleFactor(0.78)

            if let subtitle = entry.snapshot.subtitle {
                Text(subtitle)
                    .font(.system(size: 10.5, weight: .medium, design: .rounded))
                    .foregroundColor(palette.surface.opacity(0.73))
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var poster: some View {
        ZStack(alignment: .bottomLeading) {
            if let thumbnail = entry.thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
            }

            LinearGradient(
                colors: [.clear, palette.ink.opacity(0.82)],
                startPoint: .center,
                endPoint: .bottom
            )

            Text(entry.snapshot.title)
                .font(.system(size: 13.5, weight: .semibold, design: .serif))
                .foregroundColor(palette.surface)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .padding(8)

            if entry.snapshot.kind == .unlock {
                ZStack {
                    Circle()
                        .fill(palette.surface.opacity(0.94))
                    Image(systemName: "play.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(palette.ink)
                        .offset(x: 1)
                }
                .frame(width: 31, height: 31)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(palette.surface.opacity(0.8), lineWidth: 1.5)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            Canvas { context, size in
                var path = Path()
                path.move(to: CGPoint(x: -8, y: size.height * 0.70))
                path.addCurve(
                    to: CGPoint(x: size.width + 8, y: size.height * 0.48),
                    control1: CGPoint(x: size.width * 0.34, y: size.height * 0.51),
                    control2: CGPoint(x: size.width * 0.58, y: size.height * 0.82)
                )
                context.stroke(
                    path,
                    with: .color(palette.secondaryAccent.opacity(0.22)),
                    style: StrokeStyle(lineWidth: 1.2, lineCap: .round, dash: [3, 5])
                )
            }

            Image(systemName: doodleSymbol)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(palette.accent.opacity(0.45))
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

@main
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
    }
}
