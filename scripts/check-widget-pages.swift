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

        let secondPhoto = page("photo:2", group: .photos, kind: .memory)
        let thirdPhoto = page("photo:3", group: .photos, kind: .memory)
        let photoDeck = makeSnapshot(at: morning, pages: [task, photo, recap, secondPhoto, thirdPhoto])
        let hourLater = morning.addingTimeInterval(3_600)
        let twoHoursLater = morning.addingTimeInterval(7_200)
        expect(photoDeck.rotatingPhotoPage(at: morning, calendar: calendar)?.id == photo.id,
               "Initial native photo matches the shuffled deck's first page")
        expect(photoDeck.rotatingPhotoPage(at: hourLater, calendar: calendar)?.id == secondPhoto.id,
               "A suspended app's next hourly entry advances to another photo")
        expect(photoDeck.rotatingPhotoPage(at: twoHoursLater, calendar: calendar)?.id == thirdPhoto.id,
               "Rotation visits every authorized photo before repeating")
        expect(photoDeck.rotatingPhotoPage(at: morning.addingTimeInterval(10_800), calendar: calendar)?.id == photo.id,
               "Rotation wraps without including tasks or recap posters")
        expect(photoDeck.rotatingPhotoPage(at: tomorrow, calendar: calendar) == nil,
               "Native rotation cannot extend yesterday's authorized photo lifetime")
        expect(hidden.rotatingPhotoPage(at: morning, calendar: calendar) == nil,
               "Hidden widget never rotates private photos")
        let rotationDates = photoDeck.photoRotationDates(after: morning, calendar: calendar)
        expect(rotationDates.first == hourLater && rotationDates.allSatisfy { $0 < tomorrow },
               "Hourly entries are precomputed only until the same-day privacy boundary")
        expect(snapshot.photoRotationDates(after: morning, calendar: calendar).isEmpty,
               "One photo does not schedule wasteful hourly rotation")
        let taskSelection = BubbleWidgetPageSelection(pageID: task.id, selectedAt: morning)
        expect(taskSelection.resolvedID(in: photoDeck, lane: .automatic, at: twoHoursLater, calendar: calendar) == task.id,
               "Photo rotation never replaces an explicitly chosen task")
        let photoSelection = BubbleWidgetPageSelection(pageID: secondPhoto.id, selectedAt: morning)
        expect(photoSelection.resolvedID(in: photoDeck, lane: .photos, at: morning.addingTimeInterval(120), calendar: calendar) == secondPhoto.id,
               "A manually selected photo stays visible for the current hour")
        expect(photoSelection.resolvedID(in: photoDeck, lane: .photos, at: hourLater, calendar: calendar) == thirdPhoto.id,
               "A manually selected photo resumes reminiscing the following hour")
        expect(photoDeck.rotatingPhotoPage(at: hourLater, calendar: calendar)?.snapshot(in: photoDeck).route == secondPhoto.route,
               "The displayed photo and its exact Journal link rotate together")
        expect(snapshot.emptySnapshot(for: .photos).route == "/journal",
               "An empty Photos widget opens Journal rather than a Capsule page")
        let hiddenLater = makeSnapshot(at: morning, pages: [photo, secondPhoto], schedule: [
            BubbleWidgetScheduleEntry(effectiveAt: BubbleWidgetDateCodec.string(from: hourLater),
                                      kind: .empty, theme: .plum, eyebrow: "Bubble", title: "Open Bubble",
                                      subtitle: nil, badge: nil, route: "/", privacy: .hidden)
        ])
        expect(hiddenLater.rotatingPhotoPage(at: hourLater, calendar: calendar) == nil,
               "A hidden scheduled transition prevents all future photo rotation")
        expect(photoSelection.resolvedID(in: hiddenLater, lane: .photos, at: hourLater, calendar: calendar) == nil,
               "Manual selection cannot bypass a later hidden transition")
        print("Native widget paging checks passed (30 scenarios).")
    }

    static func page(_ id: String, group: BubbleWidgetPageGroup, kind: BubbleWidgetKind) -> BubbleWidgetPage {
        BubbleWidgetPage(id: id, group: group, kind: kind, theme: .plum, eyebrow: "Bubble", title: id,
                         subtitle: nil, badge: nil,
                         route: group == .photos ? "/journal?photo=\(id)&collection=family-photo-library&source=widget" : "/capsule",
                         privacy: .full)
    }

    static func makeSnapshot(at date: Date, pages: [BubbleWidgetPage], privacy: BubbleWidgetPrivacy = .full,
                             schedule: [BubbleWidgetScheduleEntry]? = nil) -> BubbleWidgetSnapshot {
        BubbleWidgetSnapshot(version: 1, generatedAt: BubbleWidgetDateCodec.string(from: date), nextRefreshAt: nil,
                             kind: .today, theme: .plum, eyebrow: "Today", title: "A family plan", subtitle: nil,
                             badge: nil, route: "/journal?section=plans", privacy: privacy, schedule: schedule, pages: pages)
    }

    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }
}
