import Foundation

/// Compile alongside BubbleWidgetShared.swift to exercise the native paging
/// contract without an app group, simulator, or family account.
@main
enum CheckWidgetPages {
    static func main() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 4 * 60 * 60)!
        let morning = BubbleWidgetDateCodec.date(from: "2026-09-11T09:00:00+04:00")!
        let afternoon = BubbleWidgetDateCodec.date(from: "2026-09-11T15:00:00+04:00")!
        let tomorrow = BubbleWidgetDateCodec.date(from: "2026-09-12T00:00:00+04:00")!
        let task = page("task:1", group: .tasks, kind: .today)
        let photo = page("photo:1", group: .photos, kind: .memory)
        let recap = page("recap:1", group: .recap, kind: .unlock)
        let snapshot = makeSnapshot(at: morning, pages: [task, photo, recap])
        let selected = BubbleWidgetPageSelection(pageID: photo.id, selectedAt: morning)

        expect(snapshot.availablePages(for: .automatic, at: afternoon, calendar: calendar).count == 3,
               "Automatic widget can browse all eligible groups")
        expect(snapshot.availablePages(for: .tasks, at: afternoon, calendar: calendar).map(\.id) == [task.id],
               "Tasks stack member only shows tasks")
        expect(snapshot.availablePages(for: .photos, at: afternoon, calendar: calendar).map(\.id) == [photo.id],
               "Photos stack member only shows photos")
        expect(snapshot.availablePages(for: .recap, at: afternoon, calendar: calendar).map(\.id) == [recap.id],
               "Recap stack member only shows recaps")
        expect(snapshot.adjacentPageID(for: .automatic, currentPageID: photo.id, direction: 1, at: afternoon,
                                      calendar: calendar) == recap.id, "Next advances one eligible card")
        expect(snapshot.adjacentPageID(for: .automatic, currentPageID: task.id, direction: -1, at: afternoon,
                                      calendar: calendar) == recap.id, "Previous wraps without opening the app")

        let refreshed = makeSnapshot(at: afternoon, pages: [recap, photo, task])
        expect(selected.resolvedID(in: refreshed, lane: .automatic, at: afternoon, calendar: calendar) == photo.id,
               "Selection survives fresh snapshot and reordered cards by ID")
        let removed = makeSnapshot(at: afternoon, pages: [task, recap])
        expect(selected.resolvedID(in: removed, lane: .automatic, at: afternoon, calendar: calendar) == nil,
               "Removed page does not retain an obsolete selection")
        expect(snapshot.availablePages(for: .automatic, at: tomorrow, calendar: calendar).isEmpty,
               "Day boundary hides every prior card")
        expect(selected.resolvedID(in: snapshot, lane: .automatic, at: tomorrow, calendar: calendar) == nil,
               "Day boundary resets selection")
        let nextDaySnapshot = makeSnapshot(at: tomorrow, pages: [photo])
        expect(selected.resolvedID(in: nextDaySnapshot, lane: .photos, at: tomorrow, calendar: calendar) == nil,
               "A republished ID does not retain yesterday's selection")

        let hidden = makeSnapshot(at: morning, pages: [photo], privacy: .hidden)
        expect(hidden.availablePages(for: .automatic, at: afternoon, calendar: calendar).isEmpty,
               "Privacy-hidden snapshot never exposes pages")
        let duplicate = makeSnapshot(at: morning, pages: [photo, photo])
        expect(duplicate.availablePages(for: .automatic, at: afternoon, calendar: calendar).isEmpty,
               "Duplicate page IDs fail closed")
        let excessive = makeSnapshot(at: morning, pages: (0..<13).map { page("photo:\($0)", group: .photos, kind: .memory) })
        expect(excessive.availablePages(for: .automatic, at: afternoon, calendar: calendar).isEmpty,
               "Native page bound fails closed")
        expect(snapshot.mediaRevision == nil && photo.snapshot(in: snapshot).pages == nil,
               "Legacy snapshot and flattened page remain compatible")
        print("Native widget paging checks passed (15 scenarios).")
    }

    static func page(_ id: String, group: BubbleWidgetPageGroup, kind: BubbleWidgetKind) -> BubbleWidgetPage {
        BubbleWidgetPage(id: id, group: group, kind: kind, theme: .plum, eyebrow: "Bubble", title: id,
                         subtitle: nil, badge: nil, route: "/capsule", privacy: .full)
    }

    static func makeSnapshot(at date: Date, pages: [BubbleWidgetPage], privacy: BubbleWidgetPrivacy = .full) -> BubbleWidgetSnapshot {
        BubbleWidgetSnapshot(version: 1, generatedAt: BubbleWidgetDateCodec.string(from: date), nextRefreshAt: nil,
                             kind: .today, theme: .plum, eyebrow: "Today", title: "A family plan", subtitle: nil,
                             badge: nil, route: "/journal?section=plans", privacy: privacy, schedule: nil, pages: pages)
    }

    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }
}
