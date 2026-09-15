package com.simerfamily.kinsphere.widget;

import static org.junit.Assert.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/** Retention is tied to the saved tracker, not whether a cached flight is active. */
public final class BubbleWidgetRetainedFlightTest {
    private static final long NOW = 1_789_423_200_000L;
    private static final long HOUR = 3_600_000L;

    @Test public void completedCancelledFutureAndMissingTimesRemainUntilRemoved() {
        List<BubbleWidgetSnapshot.Page> pages = new ArrayList<>();
        for (String mode : Arrays.asList("arrived", "cancelled", "scheduled", "unavailable"))
            pages.add(page(mode, "full", null, map(mode, null, false)));
        BubbleWidgetSnapshot saved = deck(pages);
        BubbleWidgetSnapshot later = saved.forDisplay(NOW + 30 * 24 * HOUR);
        assertEquals(4, later.pages.size());
        assertTrue(BubbleWidgetNavigation.canBrowse(saved, NOW + 30 * 24 * HOUR));
        assertEquals(4, BubbleWidgetPhotoRotation.pagesForDisplay(saved, NOW + 30 * 24 * HOUR).size());
        BubbleWidgetSnapshot replacement = deck(Collections.singletonList(pages.get(2)));
        assertEquals(1, replacement.forDisplay(NOW + 30 * 24 * HOUR).pages.size());
        assertEquals("scheduled", replacement.forDisplay(NOW + 30 * 24 * HOUR).pages.get(0).id);
        assertEquals("hidden", deck(Collections.emptyList()).forDisplay(NOW + 30 * 24 * HOUR).privacy);
    }

    @Test public void otherFamilyCardsStillExpireAtMidnight() {
        BubbleWidgetSnapshot.Page task = new BubbleWidgetSnapshot.Page("task", "tasks", "today", "forest",
            "TODAY", "Private task", null, null, "/journal", "full");
        BubbleWidgetSnapshot saved = deck(Arrays.asList(task, page("flight", "full", null, null)));
        assertEquals(1, saved.forDisplay(NOW + 48 * HOUR).pages.size());
        assertEquals("flight", saved.forDisplay(NOW + 48 * HOUR).pages.get(0).id);
    }

    @Test public void retentionCannotExposeHiddenMetadataOrSurviveAccountClear() {
        BubbleWidgetSnapshot.Page hidden = page("private", "hidden", timeline(), map("live", 20.0, false));
        assertFalse(hidden.retainedFlight);
        assertNull(hidden.flight);
        assertNull(hidden.flightMap);
        BubbleWidgetSnapshot saved = new BubbleWidgetSnapshot(NOW, 0, "flight", "forest", "BUBBLE", "Open Bubble",
            null, null, "/", "hidden", Collections.emptyList(),
            Collections.singletonList(page("flight", "full", null, null)), 0, timeline(), true, map("live", 20.0, false));
        assertFalse(saved.retainedFlight);
        assertNull(saved.flightMap);
        assertEquals("hidden", saved.forDisplay(NOW + 48 * HOUR).privacy);
        assertTrue(saved.forDisplay(NOW + 48 * HOUR).pages.isEmpty());
        assertFalse(BubbleWidgetNavigation.canBrowse(null, NOW));
    }

    @Test public void largeDeckKeepsStableIdsAndWrapsWithoutDroppingTheFifthFlight() {
        List<BubbleWidgetSnapshot.Page> pages = new ArrayList<>();
        for (int i = 0; i < 100; i++) pages.add(page("flight-" + i, "full", null, null));
        BubbleWidgetSnapshot saved = deck(pages);
        List<BubbleWidgetSnapshot.Page> displayed = saved.forDisplay(NOW + 72 * HOUR).pages;
        assertEquals(100, displayed.size());
        assertEquals(4, BubbleWidgetNavigation.resolvePosition(displayed, "flight-3", 1));
        assertEquals(99, BubbleWidgetNavigation.resolvePosition(displayed, "flight-0", -1));
        assertEquals(0, BubbleWidgetNavigation.resolvePosition(displayed, "flight-99", 1));
        assertEquals(54, BubbleWidgetNavigation.resolvePosition(displayed, "flight-54", 0));
    }

    @Test public void mapKeepsReportedPercentageInsteadOfInventingElapsedProgress() {
        BubbleWidgetFlightMap original = map("estimated", 20.0, false);
        assertSame(original, original.at(NOW + 4 * HOUR, timeline()));
        assertEquals(20.0, original.at(NOW + 4 * HOUR, timeline()).progress, 0);
    }

    @Test public void onlyExplicitEstimatedOrScheduledTimelinesAdvance() {
        BubbleWidgetFlightMap original = map("estimated", 20.0, true);
        BubbleWidgetFlightMap display = original.at(NOW + 4 * HOUR, timeline());
        assertEquals(50.0, display.progress, 0.001);
        assertEquals(180.0, display.marker.x, 0.001);
        assertEquals(45.0, display.marker.y, 0.001);
        assertSame(original, original.at(NOW + 4 * HOUR, null));
        for (String mode : Arrays.asList("live", "cancelled", "unavailable")) {
            BubbleWidgetFlightMap fixed = map(mode, null, true);
            assertFalse(fixed.mayAdvance());
            assertSame(fixed, fixed.at(NOW + 4 * HOUR, timeline()));
        }
    }

    @Test public void arrivedUsesDestinationAndCancelledDoesNotHaveAPlane() {
        BubbleWidgetFlightMap arrived = map("arrived", 20.0, true).at(NOW, timeline());
        assertSame(arrived.end, arrived.marker);
        assertEquals(100.0, arrived.progress, 0);
        assertTrue(arrived.showsPlane());
        assertFalse(map("cancelled", null, false).showsPlane());
        assertFalse(map("unavailable", null, false).showsPlane());
        assertEquals("Last reported location", map("live", 50.0, false).label());
    }

    @Test public void terminalAndCachedMapsDoNotScheduleFakeProgressUpdates() {
        BubbleWidgetSnapshot saved = deck(Collections.singletonList(
            page("done", "full", timeline(), map("arrived",100.0,false))));
        assertEquals(0, saved.nextTransitionAtMillis(NOW + 48 * HOUR));
        assertEquals(0, saved.nextTransitionAtMillis(NOW));
    }

    @Test public void wrapCoordinatesRemainInSharedMapSpace() {
        BubbleWidgetFlightMap wrapped = new BubbleWidgetFlightMap(new BubbleWidgetFlightMap.Point(330,40),
            new BubbleWidgetFlightMap.Point(410,70), new BubbleWidgetFlightMap.Point(370,20),
            new BubbleWidgetFlightMap.Point(370,37.5), 30, "scheduled", 50.0, false);
        assertEquals(410, wrapped.end.x, 0);
        assertEquals(370, wrapped.marker.x, 0);
    }

    @Test public void finiteHeadingsAreNormalizedInsteadOfRejectingTheSnapshot() {
        BubbleWidgetFlightMap base = map("live",20.0,false);
        BubbleWidgetFlightMap rotated = new BubbleWidgetFlightMap(base.start,base.end,base.control,
            base.marker,361,"live",20.0,false);
        assertEquals(1,rotated.rotation,0);
    }

    @Test(expected = IllegalArgumentException.class) public void rejectsUnboundedCoordinates() {
        new BubbleWidgetFlightMap.Point(721,90);
    }

    @Test(expected = IllegalArgumentException.class) public void rejectsNaNCoordinates() {
        new BubbleWidgetFlightMap.Point(180,Double.NaN);
    }

    @Test public void mapKeepsExactlyTheFiveMinimalAppSilhouettes() {
        assertEquals(5, BubbleWidgetFlightMapRenderer.LAND.length);
        int vertices = 0;
        for (float[] ring : BubbleWidgetFlightMapRenderer.LAND) vertices += ring.length / 2;
        assertEquals(45, vertices);
        assertEquals(103f, BubbleWidgetFlightMapRenderer.LAND[0][6], 0);
        assertEquals(112f, BubbleWidgetFlightMapRenderer.LAND[0][8], 0);
    }

    private static BubbleWidgetSnapshot deck(List<BubbleWidgetSnapshot.Page> pages) {
        return new BubbleWidgetSnapshot(NOW,0,"today","forest","TODAY","Task",null,null,"/journal",
            "full",Collections.emptyList(),pages);
    }
    private static BubbleWidgetSnapshot.Page page(String id, String privacy,
        BubbleWidgetSnapshot.Flight flight, BubbleWidgetFlightMap map) {
        return new BubbleWidgetSnapshot.Page(id,"flights","flight","forest","EK202","JFK → DXB",
            "Status available in tracker","Saved","/journal?section=flights",privacy,0,flight,true,map);
    }
    private static BubbleWidgetSnapshot.Flight timeline() {
        return new BubbleWidgetSnapshot.Flight(NOW,NOW+8*HOUR,NOW);
    }
    private static BubbleWidgetFlightMap map(String mode, Double progress, boolean advance) {
        return new BubbleWidgetFlightMap(new BubbleWidgetFlightMap.Point(100,50), new BubbleWidgetFlightMap.Point(260,70),
            new BubbleWidgetFlightMap.Point(180,30), new BubbleWidgetFlightMap.Point(120,40), 20, mode, progress, advance);
    }
}
