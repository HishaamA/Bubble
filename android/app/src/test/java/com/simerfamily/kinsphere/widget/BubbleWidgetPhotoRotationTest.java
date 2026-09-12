package com.simerfamily.kinsphere.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;
import java.util.TimeZone;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Suspended-app photo refreshes must never shift a parked planner or mix image links. */
public final class BubbleWidgetPhotoRotationTest {
    private TimeZone originalTimeZone;

    @Before
    public void useDubaiTime() {
        originalTimeZone = TimeZone.getDefault();
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Dubai"));
    }

    @After
    public void restoreTimeZone() {
        TimeZone.setDefault(originalTimeZone);
    }

    @Test
    public void keepsThePublishedShuffledOrderDuringItsFirstHour() {
        BubbleWidgetSnapshot snapshot = snapshot("full", pages());

        assertSame(snapshot.pages, BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(16, 59, 11)));
        assertEquals(at(17, 0, 11), BubbleWidgetPhotoRotation.nextRefreshAtMillis(snapshot, at(16, 59, 11)));
    }

    @Test
    public void changesOnlyPhotoPayloadsAndKeepsTheirExactImageAndJournalLinkTogether() {
        BubbleWidgetSnapshot snapshot = snapshot("full", pages());
        List<BubbleWidgetSnapshot.Page> displayed =
            BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(17, 0, 11));

        assertSame(snapshot.pages.get(0), displayed.get(0)); // parked task
        assertSame(snapshot.pages.get(2), displayed.get(2)); // recap
        assertSame(snapshot.pages.get(4), displayed.get(4)); // capture
        assertSame(snapshot.pages.get(3), displayed.get(1));
        assertEquals("photo-b", displayed.get(1).id); // thumbnail cache key
        assertEquals("/journal?photo=b&collection=family-photo-library&source=widget", displayed.get(1).route);
        assertSame(snapshot.pages.get(5), displayed.get(3));
        assertSame(snapshot.pages.get(1), displayed.get(5));
        // The original list still defines stable host slot IDs, not the moved image IDs.
        assertEquals("photo-a", snapshot.pages.get(1).id);
        assertEquals("photo-b", snapshot.pages.get(3).id);
    }

    @Test
    public void wrapsWithoutRepeatingWithinTheShuffledPhotoCycle() {
        BubbleWidgetSnapshot snapshot = snapshot("full", pages());

        assertEquals("photo-a", BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(16, 30, 11)).get(1).id);
        assertEquals("photo-b", BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(17, 30, 11)).get(1).id);
        assertEquals("photo-c", BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(18, 30, 11)).get(1).id);
        assertSame(snapshot.pages, BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(19, 30, 11)));
    }

    @Test
    public void skipsMissedHoursAfterDeviceSleepAndSchedulesTheNextHour() {
        BubbleWidgetSnapshot snapshot = snapshot("full", pages());

        assertEquals("photo-c", BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(21, 45, 11)).get(1).id);
        assertEquals(at(22, 0, 11), BubbleWidgetPhotoRotation.nextRefreshAtMillis(snapshot, at(21, 45, 11)));
        assertEquals(at(18, 0, 11), BubbleWidgetPhotoRotation.nextRefreshAtMillis(snapshot, at(17, 0, 11)));
    }

    @Test
    public void expiresPhotosAfterLocalMidnightAndRejectsAnotherDaysSnapshot() {
        BubbleWidgetSnapshot snapshot = snapshot("full", pages());

        assertTrue(BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(0, 0, 12)).isEmpty());
        assertEquals(0L, BubbleWidgetPhotoRotation.nextRefreshAtMillis(snapshot, at(0, 0, 12)));
        assertTrue(BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(23, 59, 10)).isEmpty());
    }

    @Test
    public void hiddenSnapshotsAndSinglePhotosDoNotScheduleImageRefreshes() {
        BubbleWidgetSnapshot hidden = snapshot("hidden", Collections.emptyList());
        BubbleWidgetSnapshot single = snapshot("full", Arrays.asList(photo("a", "full")));

        assertTrue(BubbleWidgetPhotoRotation.pagesForDisplay(hidden, at(17, 0, 11)).isEmpty());
        assertEquals(0L, BubbleWidgetPhotoRotation.nextRefreshAtMillis(hidden, at(17, 0, 11)));
        assertSame(single.pages, BubbleWidgetPhotoRotation.pagesForDisplay(single, at(17, 0, 11)));
        assertEquals(0L, BubbleWidgetPhotoRotation.nextRefreshAtMillis(single, at(17, 0, 11)));
        assertEquals(0L, BubbleWidgetPhotoRotation.nextRefreshAtMillis(null, at(17, 0, 11)));
    }

    @Test
    public void aHiddenSnapshotCannotExposeItsRetainedPhotoDeck() {
        BubbleWidgetSnapshot hidden = snapshot("hidden", pages());

        assertTrue(BubbleWidgetPhotoRotation.pagesForDisplay(hidden, at(17, 0, 11)).isEmpty());
        assertEquals(0L, BubbleWidgetPhotoRotation.nextRefreshAtMillis(hidden, at(17, 0, 11)));
    }

    @Test
    public void anActiveHiddenScheduleSuppressesTheDeckAndFurtherImageRefreshes() {
        BubbleWidgetSnapshot base = snapshot("full", pages());
        BubbleWidgetSnapshot scheduled = new BubbleWidgetSnapshot(
            base.generatedAtMillis, 0L, base.kind, base.theme, base.eyebrow,
            base.title, null, null, base.route, base.privacy,
            Arrays.asList(new BubbleWidgetSnapshot.ScheduledCard(
                at(17, 0, 11), "capture", "plum", "BUBBLE", "A little moment?",
                null, null, "/journal", "hidden"
            )), base.pages
        );
        BubbleWidgetSnapshot hidden = scheduled.forDisplay(at(17, 0, 11));

        assertEquals("hidden", hidden.privacy);
        assertTrue(BubbleWidgetPhotoRotation.pagesForDisplay(hidden, at(17, 0, 11)).isEmpty());
        assertEquals(0L, BubbleWidgetPhotoRotation.nextRefreshAtMillis(scheduled, at(17, 0, 11)));
    }

    @Test
    public void neverRotatesHiddenPagesOrRecapsAsPhotos() {
        BubbleWidgetSnapshot snapshot = snapshot("full", Arrays.asList(
            photo("a", "full"),
            photo("hidden", "hidden"),
            page("recap", "recap", "unlock"),
            photo("b", "full")
        ));
        List<BubbleWidgetSnapshot.Page> displayed =
            BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(17, 0, 11));

        assertEquals("photo-b", displayed.get(0).id);
        assertSame(snapshot.pages.get(1), displayed.get(1));
        assertSame(snapshot.pages.get(2), displayed.get(2));
        assertEquals("photo-a", displayed.get(3).id);
    }

    @Test
    public void aSameDayClockRollbackDoesNotProduceNegativeOffsets() {
        BubbleWidgetSnapshot snapshot = snapshot("full", pages());

        assertSame(snapshot.pages, BubbleWidgetPhotoRotation.pagesForDisplay(snapshot, at(15, 0, 11)));
    }

    private static List<BubbleWidgetSnapshot.Page> pages() {
        return Arrays.asList(
            page("task", "tasks", "today"),
            photo("a", "full"),
            page("recap", "recap", "unlock"),
            photo("b", "full"),
            page("capture", "capture", "capture"),
            photo("c", "full")
        );
    }

    private static BubbleWidgetSnapshot.Page photo(String id, String privacy) {
        return new BubbleWidgetSnapshot.Page(
            "photo-" + id, "photos", "memory", "plum", "REMEMBER THIS?",
            "Photo " + id, null, null,
            "/journal?photo=" + id + "&collection=family-photo-library&source=widget", privacy
        );
    }

    private static BubbleWidgetSnapshot.Page page(String id, String group, String kind) {
        return new BubbleWidgetSnapshot.Page(
            id, group, kind, "plum", "BUBBLE", id, null, null, "/journal", "full"
        );
    }

    private static BubbleWidgetSnapshot snapshot(String privacy, List<BubbleWidgetSnapshot.Page> pages) {
        return new BubbleWidgetSnapshot(
            at(16, 30, 11), 0L, "memory", "plum", "BUBBLE", "Family photo",
            null, null, "/journal", privacy, Collections.emptyList(), pages
        );
    }

    private static long at(int hour, int minute, int day) {
        Calendar calendar = Calendar.getInstance();
        calendar.clear();
        calendar.set(2026, Calendar.SEPTEMBER, day, hour, minute, 0);
        return calendar.getTimeInMillis();
    }
}
