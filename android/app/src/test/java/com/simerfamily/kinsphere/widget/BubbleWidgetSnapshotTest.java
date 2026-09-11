package com.simerfamily.kinsphere.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

import java.util.Arrays;
import java.util.Calendar;
import java.util.TimeZone;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Pure JVM coverage for suspended-app schedule selection and day expiry. */
public final class BubbleWidgetSnapshotTest {

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
    public void appliesTextScheduleWithoutReusingCurrentMediaIdentity() {
        BubbleWidgetSnapshot snapshot = snapshot();

        assertSame(snapshot, snapshot.forDisplay(at(16, 30, 11)));

        BubbleWidgetSnapshot capture = snapshot.forDisplay(at(18, 0, 11));
        assertNotSame(snapshot, capture);
        assertEquals("capture", capture.kind);
        assertEquals("A little moment?", capture.title);

        BubbleWidgetSnapshot empty = snapshot.forDisplay(at(22, 0, 11));
        assertNotSame(snapshot, empty);
        assertEquals("empty", empty.kind);
    }

    @Test
    public void choosesTheNextFutureScheduleBoundaryAfterAnEarlierOnePasses() {
        BubbleWidgetSnapshot snapshot = snapshot();

        assertEquals(at(17, 0, 11), snapshot.nextTransitionAtMillis(at(16, 30, 11)));
        assertEquals(at(21, 0, 11), snapshot.nextTransitionAtMillis(at(18, 0, 11)));
    }

    @Test
    public void expiresTheEntireScheduleAfterLocalMidnight() {
        BubbleWidgetSnapshot snapshot = snapshot();
        BubbleWidgetSnapshot display = snapshot.forDisplay(at(0, 1, 12));

        assertEquals("hidden", display.privacy);
        assertEquals("capture", display.kind);
        assertEquals("A little moment?", display.title);
        assertEquals(0L, snapshot.nextTransitionAtMillis(at(0, 1, 12)));
    }

    @Test
    public void keepsTheSwipeDeckAcrossAnInDayFlatScheduleTransition() {
        BubbleWidgetSnapshot snapshot = deckSnapshot();

        BubbleWidgetSnapshot scheduled = snapshot.forDisplay(at(18, 0, 11));

        assertNotSame(snapshot, scheduled);
        assertEquals("capture", scheduled.kind);
        assertEquals(2, scheduled.pages.size());
        assertEquals("task-1", scheduled.pages.get(0).id);
        assertEquals("photo-1", scheduled.pages.get(1).id);
    }

    @Test
    public void expiresEverySwipePageAfterLocalMidnight() {
        BubbleWidgetSnapshot display = deckSnapshot().forDisplay(at(0, 1, 12));

        assertEquals("hidden", display.privacy);
        assertTrue(display.pages.isEmpty());
    }

    @Test
    public void onlyUnlockedMediaGroupsMayUsePageImages() {
        BubbleWidgetSnapshot snapshot = deckSnapshot();

        assertFalse(snapshot.pages.get(0).mayShowThumbnail());
        assertTrue(snapshot.pages.get(1).mayShowThumbnail());
        assertSame(snapshot.pages.get(1), snapshot.findPage("photo-1"));
    }

    @Test
    public void acceptsOnlyTheContractedGroupKindPairs() {
        assertTrue(BubbleWidgetSnapshot.isSupportedPageKind("tasks", "today"));
        assertTrue(BubbleWidgetSnapshot.isSupportedPageKind("photos", "memory"));
        assertTrue(BubbleWidgetSnapshot.isSupportedPageKind("recap", "unlock"));
        assertTrue(BubbleWidgetSnapshot.isSupportedPageKind("capture", "capture"));
        assertFalse(BubbleWidgetSnapshot.isSupportedPageKind("tasks", "urgent"));
        assertFalse(BubbleWidgetSnapshot.isSupportedPageKind("photos", "unlock"));
        assertFalse(BubbleWidgetSnapshot.isSupportedPageKind("unknown", "capture"));
    }

    private static BubbleWidgetSnapshot snapshot() {
        return new BubbleWidgetSnapshot(
            at(16, 0, 11),
            at(17, 0, 11),
            "memory",
            "plum",
            "FROM YOUR FAMILY",
            "Sunday dinner",
            "Shared by Mum",
            null,
            "/journal/photo/weekly/photo",
            "full",
            Arrays.asList(
                new BubbleWidgetSnapshot.ScheduledCard(
                    at(17, 0, 11),
                    "capture",
                    "plum",
                    "THIS WEEK",
                    "A little moment?",
                    "Add a photo",
                    null,
                    "/capsule?contribute=weekly",
                    "full"
                ),
                new BubbleWidgetSnapshot.ScheduledCard(
                    at(21, 0, 11),
                    "empty",
                    "plum",
                    "BUBBLE",
                    "Nothing pressing today",
                    "Open Bubble",
                    null,
                    "/",
                    "full"
                )
            )
        );
    }

    private static BubbleWidgetSnapshot deckSnapshot() {
        BubbleWidgetSnapshot base = snapshot();
        return new BubbleWidgetSnapshot(
            base.generatedAtMillis,
            base.nextRefreshAtMillis,
            base.kind,
            base.theme,
            base.eyebrow,
            base.title,
            base.subtitle,
            base.badge,
            base.route,
            base.privacy,
            base.schedule,
            Arrays.asList(
                new BubbleWidgetSnapshot.Page(
                    "task-1",
                    "tasks",
                    "today",
                    "plum",
                    "TODAY",
                    "Pick up the cake",
                    "6:00 PM",
                    null,
                    "/journal?tab=plans&plan=task-1",
                    "full"
                ),
                new BubbleWidgetSnapshot.Page(
                    "photo-1",
                    "photos",
                    "memory",
                    "plum",
                    "LAST WEEK",
                    "Sunday dinner",
                    "Mum",
                    null,
                    "/journal/photo/photo-1",
                    "full"
                )
            )
        );
    }

    private static long at(int hour, int minute, int day) {
        Calendar calendar = Calendar.getInstance();
        calendar.clear();
        calendar.set(2026, Calendar.SEPTEMBER, day, hour, minute, 0);
        return calendar.getTimeInMillis();
    }
}
