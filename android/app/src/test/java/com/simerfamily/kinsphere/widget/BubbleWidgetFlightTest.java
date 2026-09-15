package com.simerfamily.kinsphere.widget;

import static org.junit.Assert.*;

import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;
import java.util.TimeZone;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Pure policy coverage: flights are bounded local estimates, never live positions. */
public final class BubbleWidgetFlightTest {
    private TimeZone original;
    @Before public void setZone() {
        original = TimeZone.getDefault();
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Dubai"));
    }
    @After public void restoreZone() { TimeZone.setDefault(original); }

    @Test public void flightGroupOnlyAcceptsFlightKindAndNeverUsesPhotos() {
        assertTrue(BubbleWidgetSnapshot.isSupportedPageKind("flights", "flight"));
        assertFalse(BubbleWidgetSnapshot.isSupportedPageKind("flights", "memory"));
        assertFalse(BubbleWidgetSnapshot.isSupportedPageKind("tasks", "flight"));
        assertFalse(flightPage("flight-a", at(14, 10)).mayShowThumbnail());
    }

    @Test public void estimateIsBoundedAndBasedOnElapsedTimeOnly() {
        BubbleWidgetSnapshot.Flight flight = timeline();
        assertEquals(0, flight.progressPercent(at(13, 20)));
        assertEquals(0, flight.progressPercent(at(13, 22)));
        assertEquals(50, flight.progressPercent(at(14, 4)));
        assertEquals(100, flight.progressPercent(at(14, 10)));
        assertEquals(100, flight.progressPercent(at(14, 15)));
    }

    @Test(expected = IllegalArgumentException.class) public void rejectsBackwardsTimeline() {
        new BubbleWidgetSnapshot.Flight(at(14, 10), at(13, 22), at(13, 21));
    }

    @Test(expected = IllegalArgumentException.class) public void rejectsUnboundedTimeline() {
        new BubbleWidgetSnapshot.Flight(at(13, 22), at(15, 11), at(13, 21));
    }

    @Test public void arrowsBrowseThroughFlightsWithoutChangingOtherSelectionRules() {
        List<BubbleWidgetSnapshot.Page> pages = Arrays.asList(task(),
            flightPage("flight-a", at(14, 10)), flightPage("flight-b", at(14, 11)));
        assertEquals(1, BubbleWidgetNavigation.resolvePosition(pages, "task", 1));
        assertEquals(2, BubbleWidgetNavigation.resolvePosition(pages, "flight-a", 1));
        assertEquals(0, BubbleWidgetNavigation.resolvePosition(pages, "flight-b", 1));
        assertEquals(0, BubbleWidgetNavigation.resolvePosition(pages, "flight-a", -1));
    }

    @Test public void onlyExplicitFullFlightPagesSurviveMidnight() {
        BubbleWidgetSnapshot source = deck("full");
        assertEquals(3, source.forDisplay(at(13, 23)).pages.size());
        BubbleWidgetSnapshot display = source.forDisplay(at(14, 1));
        assertEquals("flight", display.kind);
        assertEquals(2, display.pages.size());
        assertTrue(BubbleWidgetNavigation.canBrowse(source, at(14, 1)));
        assertEquals(2, BubbleWidgetPhotoRotation.pagesForDisplay(source, at(14, 1)).size());
        for (BubbleWidgetSnapshot.Page page : display.pages) assertEquals("flights", page.group);
    }

    @Test public void expiryRemovesFlightPagesAndRepairsSelectedSlot() {
        BubbleWidgetSnapshot source = deck("full");
        List<BubbleWidgetSnapshot.Page> pages = source.forDisplay(at(14, 10)).pages;
        assertEquals(1, pages.size());
        assertEquals("flight-b", pages.get(0).id);
        assertEquals(0, BubbleWidgetNavigation.resolvePosition(pages, "flight-a", 0));
        assertFalse(BubbleWidgetNavigation.canBrowse(source, at(14, 10)));
        assertEquals("hidden", source.forDisplay(at(14, 11)).privacy);
    }

    @Test public void sameDayExpiryDoesNotDiscardTheTask() {
        BubbleWidgetSnapshot source = new BubbleWidgetSnapshot(at(13, 21), 0L, "today",
            "forest", "TODAY", "Task", null, null, "/journal", "full",
            Collections.emptyList(), Arrays.asList(task(), flightPage("flight", at(13, 23))));
        assertEquals(1, source.forDisplay(at(13, 23)).pages.size());
        assertEquals("task", source.forDisplay(at(13, 23)).pages.get(0).id);
    }

    @Test public void missingExpiryCannotExtendFlightsPastMidnight() {
        BubbleWidgetSnapshot source = new BubbleWidgetSnapshot(at(13, 21), 0L, "flight",
            "forest", "EK202", "JFK → DXB", "ETA 10 AM · Estimated", null,
            "/journal?section=flights", "full", Collections.emptyList(),
            Collections.singletonList(flightPage("unbounded", 0L)), 0L, timeline());
        assertEquals("hidden", source.forDisplay(at(14, 1)).privacy);
    }

    @Test public void staleSnapshotsCannotExtendFlightBeyondThirtySixHours() {
        BubbleWidgetSnapshot source = deck("full");
        assertEquals("hidden", source.forDisplay(at(15, 10)).privacy);
    }

    @Test public void hiddenSnapshotsStripTimelineAndDisableTheDeck() {
        BubbleWidgetSnapshot source = new BubbleWidgetSnapshot(at(13, 21), 0L, "flight",
            "forest", "BUBBLE", "Open Bubble", null, null, "/", "hidden",
            Collections.emptyList(), deck("full").pages, at(14, 10), timeline());
        assertNull(source.flight);
        assertEquals(0L, source.expiresAtMillis);
        assertTrue(source.forDisplay(at(13, 22)).pages.isEmpty());
        assertFalse(BubbleWidgetNavigation.canBrowse(source, at(14, 1)));
        assertEquals(0L, source.nextTransitionAtMillis(at(14, 1)));
    }

    @Test public void scheduleCarriesFlightTimelineButNotYesterdayTaskPages() {
        BubbleWidgetSnapshot source = new BubbleWidgetSnapshot(at(13, 21), 0L,
            "today", "forest", "TODAY", "Task", null, null, "/journal", "full",
            Collections.singletonList(new BubbleWidgetSnapshot.ScheduledCard(at(13, 22),
                "flight", "forest", "EK202", "JFK → DXB", "ETA 10 AM · Estimated", null,
                "/journal?section=flights", "full", at(14, 10), timeline())),
            Collections.singletonList(task()));
        assertEquals("flight", source.forDisplay(at(14, 1)).kind);
        assertTrue(source.forDisplay(at(14, 1)).pages.isEmpty());
        assertNotNull(source.forDisplay(at(14, 1)).flight);
        assertEquals("hidden", source.forDisplay(at(14, 10)).privacy);
    }

    @Test public void localRefreshUsesDepartureMinuteAndExpiryBoundaries() {
        BubbleWidgetSnapshot source = deck("full");
        assertEquals(at(13, 22), source.nextTransitionAtMillis(at(13, 21)));
        assertEquals(at(14, 4) + 60_000, source.nextTransitionAtMillis(at(14, 4)));
        assertEquals(at(14, 11), source.nextTransitionAtMillis(at(14, 10)));
        assertEquals(0L, source.nextTransitionAtMillis(at(14, 11)));
    }

    private static BubbleWidgetSnapshot deck(String privacy) {
        return new BubbleWidgetSnapshot(at(13, 21), 0L, "today", "forest", "TODAY", "Task",
            null, null, "/journal", privacy, Collections.emptyList(), Arrays.asList(task(),
                flightPage("flight-a", at(14, 10)), flightPage("flight-b", at(14, 11))));
    }
    private static BubbleWidgetSnapshot.Page task() {
        return new BubbleWidgetSnapshot.Page("task", "tasks", "today", "forest", "TODAY",
            "A task", null, null, "/journal?section=plans", "full");
    }
    private static BubbleWidgetSnapshot.Page flightPage(String id, long expiry) {
        return new BubbleWidgetSnapshot.Page(id, "flights", "flight", "forest", "EK202",
            "JFK → DXB", "ETA 10 AM · Estimated", "En route", "/journal?section=flights",
            "full", expiry, timeline());
    }
    private static BubbleWidgetSnapshot.Flight timeline() {
        return new BubbleWidgetSnapshot.Flight(at(13, 22), at(14, 10), at(13, 21));
    }
    private static long at(int day, int hour) {
        Calendar calendar = Calendar.getInstance();
        calendar.clear();
        calendar.set(2026, Calendar.SEPTEMBER, day, hour, 0, 0);
        return calendar.getTimeInMillis();
    }
}
