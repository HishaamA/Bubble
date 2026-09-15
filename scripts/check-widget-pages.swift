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
        let flightDeparture = tomorrow.addingTimeInterval(-3_600)
        let flightArrival = tomorrow.addingTimeInterval(5 * 3_600)
        let flightExpiry = flightArrival.addingTimeInterval(2 * 3_600)
        let flightMetadata = BubbleWidgetFlight(
            departureAt: BubbleWidgetDateCodec.string(from: flightDeparture),
            arrivalAt: BubbleWidgetDateCodec.string(from: flightArrival),
            updatedAt: BubbleWidgetDateCodec.string(from: morning)
        )
        var flightPage = page("flight:1", group: .flights, kind: .flight)
        flightPage.expiresAt = BubbleWidgetDateCodec.string(from: flightExpiry)
        flightPage.flight = flightMetadata
        let flightDeck = makeSnapshot(at: morning, pages: [task, photo, flightPage])
        expect(flightDeck.availablePages(for: .automatic, at: afternoon, calendar: calendar).count == 3,
               "Automatic deck includes active flights alongside existing cards")
        expect(flightDeck.availablePages(for: .flights, at: afternoon, calendar: calendar).map(\.id) == [flightPage.id],
               "Dedicated flight lane includes only flights")
        expect(flightDeck.availablePages(for: .automatic, at: tomorrow, calendar: calendar).map(\.id) == [flightPage.id],
               "Only a bounded, full-privacy flight survives local midnight")
        expect(flightDeck.availablePages(for: .photos, at: tomorrow, calendar: calendar).isEmpty,
               "An overnight flight cannot extend photo visibility")
        expect(flightDeck.availablePages(for: .tasks, at: tomorrow, calendar: calendar).isEmpty,
               "An overnight flight cannot extend task visibility")
        expect(flightDeck.resolvedForDisplay(at: tomorrow, calendar: calendar).snapshot.kind == .flight,
               "Overnight automatic card resolves to the independently valid flight")
        expect(!flightDeck.resolvedForDisplay(at: tomorrow, calendar: calendar).mayUseCurrentThumbnail,
               "A flight cannot inherit a previous primary photo")
        expect(flightDeck.availablePages(for: .flights, at: flightExpiry, calendar: calendar).isEmpty,
               "Exact expiry removes a flight without waiting for the app")
        expect(flightDeck.resolvedForDisplay(at: flightExpiry, calendar: calendar).snapshot.privacy == .hidden,
               "Last flight expiry returns a private fallback")
        let flightSelection = BubbleWidgetPageSelection(pageID: flightPage.id, selectedAt: afternoon)
        expect(flightSelection.resolvedID(in: flightDeck, lane: .automatic, at: tomorrow, calendar: calendar) == flightPage.id,
               "The selected overnight flight remains selected until its expiry")
        expect(flightSelection.resolvedID(in: flightDeck, lane: .automatic, at: flightExpiry, calendar: calendar) == nil,
               "A selected flight cannot bypass expiration")

        var unbounded = flightPage
        unbounded.expiresAt = nil
        expect(makeSnapshot(at: morning, pages: [unbounded]).availablePages(for: .flights, at: tomorrow, calendar: calendar).isEmpty,
               "Legacy flight without explicit expiry cannot survive midnight")
        unbounded.expiresAt = BubbleWidgetDateCodec.string(from: morning.addingTimeInterval(36 * 3_600 + 1))
        expect(makeSnapshot(at: morning, pages: [unbounded]).availablePages(for: .flights, at: afternoon, calendar: calendar).isEmpty,
               "An expiration beyond the 36-hour bound fails closed even the same day")
        unbounded.expiresAt = "not-a-date"
        expect(makeSnapshot(at: morning, pages: [unbounded]).availablePages(for: .flights, at: afternoon, calendar: calendar).isEmpty,
               "Malformed expiry fails closed")
        expect(makeSnapshot(at: morning, pages: [flightPage], privacy: .hidden).availablePages(for: .flights, at: tomorrow, calendar: calendar).isEmpty,
               "Hidden privacy cannot expose overnight route or provider data")
        expect(makeSnapshot(at: morning, pages: [flightPage], privacy: .hidden).resolvedForDisplay(at: afternoon, calendar: calendar).snapshot.flight == nil,
               "Hidden native display removes flight timestamps")
        let hiddenFlightDeck = makeSnapshot(at: morning, pages: [flightPage], schedule: hiddenLater.schedule)
        expect(hiddenFlightDeck.availablePages(for: .flights, at: tomorrow, calendar: calendar).isEmpty,
               "A hidden transition still blocks flights after midnight")

        expect(flightMetadata.isValid && flightMetadata.estimatedProgress(at: flightDeparture.addingTimeInterval(-1)) == 0,
               "Estimated progress is zero before departure")
        expect(abs(flightMetadata.estimatedProgress(at: flightDeparture.addingTimeInterval(3 * 3_600)) - 0.5) < 0.0001,
               "Plane position reflects elapsed time, not fabricated aircraft coordinates")
        expect(flightMetadata.estimatedProgress(at: flightArrival.addingTimeInterval(1)) == 1,
               "Estimated progress clamps at arrival without inventing a provider status")
        let invalidFlight = BubbleWidgetFlight(departureAt: flightMetadata.arrivalAt,
                                               arrivalAt: flightMetadata.departureAt, updatedAt: flightMetadata.updatedAt)
        expect(!invalidFlight.isValid && invalidFlight.estimatedProgress(at: tomorrow) == 0,
               "Inverted timestamps cannot render invalid progress")
        let flightDates = flightDeck.flightTimelineDates(after: afternoon, calendar: calendar)
        expect(flightDates.contains(flightArrival) && flightDates.contains(flightExpiry),
               "Arrival and exact expiry are precomputed timeline boundaries")
        expect(flightDates.allSatisfy { $0 > afternoon && $0 <= flightExpiry } && flightDates.count < 160,
               "Native estimated progress has a bounded timeline, not a background network poll")
        expect(flightDeck.emptySnapshot(for: .flights).route == "/journal?section=flights",
               "An empty flight widget opens the Flight tab")
        let flattened = flightPage.snapshot(in: flightDeck)
        expect(flattened.expiresAt == flightPage.expiresAt && flattened.flight?.arrivalAt == flightMetadata.arrivalAt,
               "Flattening an active page preserves expiry and cached provider timestamps")
        let roundTrip = try! JSONDecoder().decode(BubbleWidgetSnapshot.self, from: JSONEncoder().encode(flattened))
        expect(roundTrip.version == 1 && roundTrip.kind == .flight && roundTrip.flight?.updatedAt == flightMetadata.updatedAt,
               "Flight fields round-trip through the additive version-one native Codable contract")
        let legacy = try! JSONDecoder().decode(BubbleWidgetSnapshot.self, from: JSONEncoder().encode(snapshot))
        expect(legacy.flight == nil && legacy.expiresAt == nil && legacy.pages?.count == 3,
               "Existing saved snapshots decode without flight fields")
        let muchLater = morning.addingTimeInterval(30 * 24 * 3_600)
        var retained = flightPage
        retained.retainedFlight = true
        retained.flightMap = map(mode: .estimated, progress: 25, advanceWithTime: true)
        let retainedDeck = makeSnapshot(at: morning, pages: [retained, task, photo, recap])
        expect(retainedDeck.availablePages(for: .automatic, at: muchLater, calendar: calendar).map(\.id) == [retained.id],
               "An explicitly retained tracker flight survives old expiry, midnight, and staleness")
        expect(retainedDeck.resolvedForDisplay(at: muchLater, calendar: calendar).snapshot.kind == .flight,
               "Automatic widget can continue displaying an old tracked flight")
        expect(flightSelection.resolvedID(in: retainedDeck, lane: .flights, at: muchLater, calendar: calendar) == retained.id,
               "A selected retained flight stays selected across days")
        expect(makeSnapshot(at: muchLater, pages: [task]).availablePages(for: .flights, at: muchLater, calendar: calendar).isEmpty,
               "Removing the flight from the next app snapshot removes its widget page")
        expect(BubbleWidgetSnapshot.privateFallback(theme: .plum).availablePages(for: .flights, at: muchLater, calendar: calendar).isEmpty,
               "Account clearing removes retained flights")
        expect(makeSnapshot(at: morning, pages: [retained], privacy: .hidden).resolvedForDisplay(at: muchLater, calendar: calendar).snapshot.flightMap == nil,
               "Hidden privacy strips retained map coordinates")
        var retainedTask = task
        retainedTask.retainedFlight = true
        expect(makeSnapshot(at: morning, pages: [retainedTask]).availablePages(for: .tasks, at: muchLater, calendar: calendar).isEmpty,
               "A retained-flight flag cannot extend unrelated task visibility")
        let terminalModes: [BubbleWidgetFlightMapMode] = [.arrived, .cancelled, .unavailable]
        for mode in terminalModes {
            var card = page("flight:\(mode.rawValue)", group: .flights, kind: .flight)
            card.retainedFlight = true
            card.flightMap = map(mode: mode, progress: mode == .arrived ? 100 : nil)
            let terminalDeck = makeSnapshot(at: morning, pages: [card])
            expect(terminalDeck.availablePages(for: .flights, at: muchLater, calendar: calendar).count == 1,
                   "Arrived, cancelled, and missing-timetable flights remain in the tracker deck")
            expect(terminalDeck.flightTimelineDates(after: muchLater, calendar: calendar).isEmpty,
                   "Completed or unavailable cards do not schedule fake progress updates")
        }
        let manyFlights = (0..<100).map { index -> BubbleWidgetPage in
            var card = page("flight:\(index)", group: .flights, kind: .flight)
            card.retainedFlight = true
            card.flightMap = map(mode: .scheduled, progress: 0)
            return card
        }
        let largeDeck = makeSnapshot(at: morning, pages: manyFlights + (0..<12).map { page("photo:\($0)", group: .photos, kind: .memory) })
        expect(largeDeck.availablePages(for: .automatic, at: afternoon, calendar: calendar).count == 112,
               "One hundred tracked flights coexist with the original twelve-card allowance")
        expect(largeDeck.availablePages(for: .flights, at: muchLater, calendar: calendar).count == 100,
               "Every retained flight remains browsable without preserving stale photo metadata")
        expect(largeDeck.adjacentPageID(for: .flights, currentPageID: "flight:99", direction: 1, at: muchLater, calendar: calendar) == "flight:0",
               "Native arrows wrap around all one hundred flight cards")
        var excessFlight = page("flight:100", group: .flights, kind: .flight)
        excessFlight.retainedFlight = true
        expect(makeSnapshot(at: morning, pages: manyFlights + [excessFlight]).availablePages(for: .flights, at: afternoon, calendar: calendar).isEmpty,
               "More than one hundred flight pages fails closed")
        let arrivedMap = map(mode: .arrived, progress: 100)
        expect(arrivedMap.displayedMarker(at: morning, flight: flightMetadata)?.point == arrivedMap.end,
               "Arrived aircraft is drawn at its destination")
        expect(map(mode: .cancelled, progress: nil).displayedMarker(at: morning, flight: flightMetadata) == nil,
               "Cancelled flight has no aircraft marker")
        expect(map(mode: .unavailable, progress: nil).displayedMarker(at: morning, flight: nil) == nil,
               "Unavailable position does not invent an aircraft marker")
        let cachedLive = map(mode: .live, progress: 25, advanceWithTime: true)
        expect(cachedLive.displayedMarker(at: muchLater, flight: flightMetadata)?.point == cachedLive.marker,
               "Cached last-reported position never advances with the clock")
        let providerProgress = map(mode: .estimated, progress: 25)
        expect(providerProgress.displayedMarker(at: muchLater, flight: flightMetadata)?.point == providerProgress.marker,
               "Provider progress stays at exactly the app's supplied marker")
        let timedMap = map(mode: .estimated, progress: 25, advanceWithTime: true)
        expect(timedMap.displayedMarker(at: flightDeparture.addingTimeInterval(3 * 3_600), flight: flightMetadata)?.point == BubbleWidgetMapPoint(x: 167.5, y: 40),
               "Opted-in estimates follow the same quadratic route as the app")
        expect(timedMap.displayedMarker(at: muchLater, flight: nil)?.point == timedMap.marker,
               "Missing timetable keeps supplied route geometry instead of guessing")
        expect(!map(mode: .estimated, progress: 101).isValid && !map(mode: .cancelled, progress: 1).isValid,
               "Progress bounds and cancelled semantics are validated")
        expect(!BubbleWidgetMapPoint(x: .nan, y: 2).isValid && !BubbleWidgetMapPoint(x: 721, y: 2).isValid,
               "Nonfinite or unbounded coordinates are rejected")
        expect(BubbleWidgetFlightMapGeometry.land.count == 5 && BubbleWidgetFlightMapGeometry.land.reduce(0, { $0 + $1.count }) == 45,
               "The native map uses the app's same five minimal land polygons")
        let retainedRoundTrip = try! JSONDecoder().decode(BubbleWidgetSnapshot.self, from: JSONEncoder().encode(retained.snapshot(in: retainedDeck)))
        expect(retainedRoundTrip.retainedFlight == true && retainedRoundTrip.flightMap?.mode == .estimated && retainedRoundTrip.flightMap?.advanceWithTime == true,
               "Retention and map metadata round-trip through the additive native Codable contract")
        print("Native widget paging and flight-map checks passed.")
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

    static func map(mode: BubbleWidgetFlightMapMode, progress: Double?, advanceWithTime: Bool? = nil) -> BubbleWidgetFlightMap {
        BubbleWidgetFlightMap(start: BubbleWidgetMapPoint(x: 100, y: 50),
                              end: BubbleWidgetMapPoint(x: 230, y: 70),
                              control: BubbleWidgetMapPoint(x: 170, y: 20),
                              marker: BubbleWidgetMapPoint(x: 110, y: 60),
                              rotation: 10, mode: mode, progress: progress, advanceWithTime: advanceWithTime)
    }

    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }
}
